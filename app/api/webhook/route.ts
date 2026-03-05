import { NextResponse } from 'next/server';
import {
  supabase,
  callOpenRouter,
  generateEmbedding,
  sendTelegram,
  compactMemory,
  getOrCreateSession,
  setPendingQuestion,
  clearPendingQuestion,
  reinforceMemory
} from '@/lib/jarvis';
import { createGoogleEvent, updateGoogleEvent } from '@/lib/google';
import {
  classifyTemporalHorizon,
  buildWeightedContext,
  truncateByWeight
} from '@/lib/context-router';
import {
  getOnboardingState,
  initOnboarding,
  processOnboardingFromMessage,
  buildOnboardingBlock
} from '@/lib/onboarding';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message;
    let messageText = message?.text || "";

    // ============================================================
    // 🎤 WHISPER — com fallback de formatos
    // ============================================================
    if (message?.voice) {
      try {
        const fileId = message.voice.file_id;
        const getFile = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
        );
        const fileData = await getFile.json();

        if (!fileData.ok) {
          await sendTelegram(message.chat.id, "⚠️ Não consegui acessar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
        const audioRes = await fetch(fileUrl);

        if (!audioRes.ok) {
          await sendTelegram(message.chat.id, "⚠️ Falha ao baixar o áudio. Tenta de novo?");
          return NextResponse.json({ ok: true });
        }

        const buffer = await audioRes.arrayBuffer();
        const audioFormats = [
          { type: 'audio/mpeg', ext: 'voice.mp3' },
          { type: 'audio/ogg',  ext: 'voice.ogg' },
          { type: 'audio/wav',  ext: 'voice.wav' },
        ];

        let transcriptionRes: Response | null = null;
        for (const fmt of audioFormats) {
          const formData = new FormData();
          formData.append('file', new Blob([buffer], { type: fmt.type }), fmt.ext);
          formData.append('model', 'whisper-1');
          formData.append('language', 'pt');

          const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
            body: formData
          });

          if (res.ok) { transcriptionRes = res; break; }
        }

        if (!transcriptionRes) {
          await sendTelegram(message.chat.id, "⚠️ Não consegui transcrever o áudio. Pode digitar?");
          return NextResponse.json({ ok: true });
        }

        const transcriptionData = await transcriptionRes.json();
        messageText = transcriptionData.text?.trim() || "";

        if (!messageText) {
          await sendTelegram(message.chat.id, "⚠️ O áudio veio vazio. Pode repetir?");
          return NextResponse.json({ ok: true });
        }

      } catch (err) {
        console.error("Erro no pipeline de áudio:", err);
        await sendTelegram(message.chat.id, "⚠️ Erro ao processar áudio. Tenta digitar.");
        return NextResponse.json({ ok: true });
      }
    }

    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const userFirstName = message?.from?.first_name || "Usuário";

    if (!messageText || chatId == null || telegramUserId == null) {
      return NextResponse.json({ ok: true });
    }

    const stringId = String(telegramUserId);

    // ============================================================
    // BUSCA EM PARALELO
    // ============================================================
    const [userProfileResult, sessionId, eventsResult, ashesResult, onboardingResult] = await Promise.all([
      supabase
        .from('users')
        .select('nickname, current_context, pending_question, pending_context, plan')
        .eq('id', stringId)
        .single(),

      getOrCreateSession(stringId),

      supabase
        .from('events')
        .select('title, event_date, category, decay_type, relevance_score, emotional_weight, is_recurring, notes')
        .eq('user_id', stringId)
        .order('relevance_score', { ascending: false }),

      supabase
        .from('memory_ashes')
        .select('ash_summary, period_start, period_end')
        .eq('user_id', stringId)
        .order('period_end', { ascending: false })
        .limit(5),

      supabase
        .from('onboarding_progress')
        .select('*')
        .eq('user_id', stringId)
        .single()
    ]);

    const userProfile = userProfileResult.data;
    const authorName = userProfile?.nickname || userFirstName;
    const currentContextL3 = userProfile?.current_context || "Sem dossiê ainda.";
    const pendingQuestion = userProfile?.pending_question || null;
    const pendingContext = userProfile?.pending_context || null;

    // Tratamento informal baseado no gênero detectado no dossiê
    const isFemale = currentContextL3.toLowerCase().includes('feminino') ||
                     currentContextL3.toLowerCase().includes('mulher');
    const informalAddress = isFemale ? 'miga' : 'cara';

    // Onboarding — inicializa se for novo usuário
    let onboardingState = onboardingResult?.data || null;
    if (!onboardingState) {
      onboardingState = await initOnboarding(stringId);
    }
    const onboardingBlock = buildOnboardingBlock(onboardingState);

    // ============================================================
    // EVENTOS
    // ============================================================
    const events = eventsResult.data || [];
    const urgentEvents = events.filter(e => (e.relevance_score || 0) >= 0.7);
    const radarEvents  = events.filter(e => (e.relevance_score || 0) >= 0.3 && (e.relevance_score || 0) < 0.7);
    const eventsBlock  = events.length > 0 ? [
      urgentEvents.length > 0
        ? `🔴 PRÓXIMOS:\n${urgentEvents.map(e => `  - ${e.title}: ${e.event_date}${e.notes ? ` (${e.notes})` : ''}`).join('\n')}`
        : null,
      radarEvents.length > 0
        ? `🟡 NO RADAR:\n${radarEvents.map(e => `  - ${e.title}: ${e.event_date}`).join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n') : "Nenhum evento cadastrado.";

    // CINZAS
    const ashes = ashesResult.data || [];
    const ashesBlock = ashes.length > 0 ? ashes.map(a => a.ash_summary).join('\n') : null;

    // ============================================================
    // HD VETORIAL
    // ============================================================
    const queryEmbedding = await generateEmbedding(messageText);
    let hdBlock = "";
    let hdMemoryIds: string[] = [];

    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: 0.4,
        match_count: 3
      }) as { data: any[] | null };

      if (search && search.length > 0) {
        hdBlock = search
          .filter(r => !r.summary.startsWith('[CINZA]'))
          .map(r => r.summary)
          .join('\n---\n');
        hdMemoryIds = search.map(r => r.id);
      }
    }

    // ============================================================
    // RAM RESILIENTE — 3 níveis de fallback
    // ============================================================
    let ramBlock = "";

    // Nível 1: sessão atual
    const { data: historySession } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', stringId)
      .eq('session_id', sessionId)
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(8);

    if (historySession && historySession.length >= 2) {
      ramBlock = [...historySession].reverse().map((h: any) => {
        const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
        return `${authorName}: ${h.content}\nJarvis: ${ai}`;
      }).join('\n\n');
      console.log('[RAM] Nível 1 — sessão:', historySession.length, 'msgs');

    } else {
      // Nível 2: histórico recente sem filtro de sessão
      const { data: historyRecent } = await supabase
        .from('brain')
        .select('content, metadata')
        .eq('user_id', stringId)
        .neq('category', 'noise')
        .order('created_at', { ascending: false })
        .limit(12);

      if (historyRecent && historyRecent.length > 0) {
        const sessionSet = new Set((historySession || []).map((h: any) => h.content));
        const extra = historyRecent.filter((h: any) => !sessionSet.has(h.content));
        const merged = [...(historySession || []), ...extra].slice(0, 10);
        ramBlock = [...merged].reverse().map((h: any) => {
          const ai = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
          return `${authorName}: ${h.content}\nJarvis: ${ai}`;
        }).join('\n\n');
        console.log('[RAM] Nível 2 — recente:', merged.length, 'msgs');

      } else if (hdBlock) {
        // Nível 3: consolidação HD como base
        ramBlock = `[Contexto anterior consolidado]\n${hdBlock}`;
        console.log('[RAM] Nível 3 — HD como base');
      }
    }

    // ============================================================
    // CLASSIFICADOR TEMPORAL
    // ============================================================
    const weights = classifyTemporalHorizon(messageText, ramBlock, pendingQuestion);
    console.log(`[Router] ${weights.horizon} | ${weights.reason}`);

    const truncatedRam    = truncateByWeight(ramBlock, weights.ram, 6000);
    const truncatedL3     = truncateByWeight(currentContextL3, weights.l3, 6000);
    const truncatedHd     = truncateByWeight(hdBlock, weights.hd, 6000);
    const truncatedAshes  = ashesBlock ? truncateByWeight(ashesBlock, weights.ashes, 6000) : null;
    const truncatedEvents = truncateByWeight(eventsBlock, weights.events, 6000);

    const weightedContext = buildWeightedContext(weights, {
      ram: truncatedRam,
      l3: truncatedL3,
      hd: truncatedHd,
      ashes: truncatedAshes,
      events: truncatedEvents,
      authorName,
      pendingQuestion,
      pendingContext
    });

    // ============================================================
    // PROMPT FINAL v1.4
    // ============================================================
    const fusoLondrina = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // ============================================================
    // MONTA MESSAGES ESTRUTURADO — como uma instância real
    // System prompt com contexto + histórico como conversa
    // ============================================================
    const systemPrompt = `
Você é ${authorName === 'Celio' ? 'Jarvis' : 'Lev'}, assistente pessoal de ${authorName}.
Data/hora: ${fusoLondrina} | Modo: ${weights.horizon.toUpperCase()}

${truncatedL3 ? `[QUEM É ${authorName.toUpperCase()}]
${truncatedL3}` : ''}

${truncatedEvents ? `[EVENTOS RELEVANTES]
${truncatedEvents}` : ''}

${truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]
${truncatedHd}` : ''}

${truncatedAshes ? `[MEMÓRIAS DISTANTES — use "lembro vagamente que..." ao citar]
${truncatedAshes}` : ''}

${onboardingBlock}

REGRAS:
1. FOCO: Responda O QUE FOI PERGUNTADO. Nunca mude de assunto.
   - Pronomes ("esse filme", "isso", "ele") sempre se referem ao ÚLTIMO assunto da conversa
   - Nunca pergunte "qual?" se o histórico já deixa claro

2. TOM: Amigo de longa data — inteligente, direto, humano.
   - Use "${informalAddress}" com moderação — no máximo 1x por conversa, nunca para iniciar frase
   - Humor leve e inesperado quando o momento pedir
   - NUNCA comece com "Considerando que", "Com base no seu histórico", "Levando em conta"
   - SEM perguntas ao final — só pergunte se for ESSENCIAL para agir
   - SEM "Em que posso te ajudar?" ou variações

3. MEMÓRIA DISTANTE: Se usar cinzas, diga "lembro vagamente que...".

4. PERGUNTAS ABERTAS: Só quando precisar agir:
   [PERGUNTA_ABERTA: "texto" | contexto]

5. GATILHOS — use APENAS estes formatos exatos, nunca invente outros:
   [SALVAR_EVENTO: título | YYYY-MM-DD | alta|media|baixa | true|false | permanent|recurring_annual|deadline|one_time]
   [AGENDAR: título | YYYY-MM-DDTHH:MM | minutos]
   [ATUALIZAR_EVENTO: busca | título | YYYY-MM-DDTHH:MM | minutos]
   [LIMPAR_PENDENTE]
   PROIBIDO: criar gatilhos próprios como [ONBOARDING: x], [IDÉIA: x], [REGISTRADO: x] ou qualquer outro formato livre.
   Os gatilhos ficam INVISÍVEIS para o usuário — nunca aparecem no texto da resposta.

6. Ao final: [CLASSE: info] ou [CLASSE: noise]
`.trim();

    // Busca histórico para montar conversa estruturada
    const { data: historyForMessages } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', stringId)
      .neq('category', 'noise')
      .order('created_at', { ascending: false })
      .limit(10);

    type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

    const conversationMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      // Histórico como conversa estruturada (ordem cronológica)
      ...(historyForMessages || []).reverse().flatMap((h: any): ChatMessage[] => [
        { role: 'user',      content: h.content },
        { role: 'assistant', content: (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim() }
      ]),
      // Mensagem atual
      { role: 'user', content: messageText }
    ];

    let aiReply = await callOpenRouter(conversationMessages);

    // ============================================================
    // INTERCEPTORES
    // ============================================================
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/gi, '').trim();

    const pendingMatch = aiReply.match(/\[?PERGUNTA_ABERTA:\s*[\"']?([^\"'|\]]+)[\"']?\s*\|\s*([^\]]+)\]?/i);
    if (pendingMatch) {
      let ctx = null;
      try { ctx = JSON.parse(pendingMatch[2]); } catch { ctx = { tag: pendingMatch[2].trim() }; }
      await setPendingQuestion(stringId, pendingMatch[1].trim(), ctx);
      aiReply = aiReply.replace(pendingMatch[0], '').trim();
    }

    if (aiReply.includes('[LIMPAR_PENDENTE]')) {
      await clearPendingQuestion(stringId);
      aiReply = aiReply.replace(/\[LIMPAR_PENDENTE\]/gi, '').trim();
    }

    // Salvar evento
    const eventRegex = /\[?SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(permanent|recurring_annual|deadline|one_time)\]?/gi;
    for (const m of Array.from(aiReply.matchAll(eventRegex)) as any[]) {
      await supabase.from('events').insert([{
        user_id: stringId,
        title: m[1].trim(),
        event_date: m[2],
        priority: m[3].toLowerCase(),
        is_recurring: m[4] === 'true',
        decay_type: m[5],
        last_notified_year: new Date().getFullYear() - 1
      }]);
      aiReply = aiReply.replace(m[0], '').trim();
    }

    // Google Calendar
    const sMatch = aiReply.match(/\[?AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (sMatch) {
      const res = await createGoogleEvent(sMatch[1].trim(), sMatch[2].trim(), parseInt(sMatch[3]));
      aiReply = aiReply.replace(sMatch[0], '').trim() + `\n\n🗓️ *Agendado:* ${res}`;
    }

    const uMatch = aiReply.match(/\[?ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]?/i);
    if (uMatch) {
      const res = await updateGoogleEvent(uMatch[1].trim(), uMatch[2].trim(), uMatch[3].trim(), parseInt(uMatch[4]));
      aiReply = aiReply.replace(uMatch[0], '').trim() + `\n\n🗓️ *Atualizado:* ${res}`;
    }

    // ============================================================
    // PERSISTÊNCIA
    // ============================================================
    const { error: insertError } = await supabase.from('brain').insert([{
      content: messageText,
      category,
      user_id: stringId,
      session_id: sessionId,
      project_tag: 'geral',
      embedding: queryEmbedding,
      metadata: {
        ai_reply: aiReply,
        user: authorName,
        horizon: weights.horizon,
        pending_resolved: !!pendingQuestion
      }
    }]);

    if (insertError) {
      console.error('BRAIN INSERT ERRO:', JSON.stringify(insertError));
    } else {
      console.log('BRAIN INSERT OK — user:', stringId, 'session:', sessionId);
    }

    for (const memId of hdMemoryIds) await reinforceMemory(memId);

    await sendTelegram(chatId, aiReply);

    // Onboarding em background — não bloqueia a resposta
    if (onboardingState?.status === 'in_progress') {
      processOnboardingFromMessage(stringId, messageText, aiReply, onboardingState)
        .catch(e => console.error('[Onboarding] Erro:', e));
    }

    // Extrator contínuo — roda para TODA mensagem info, em paralelo
    // Persiste fatos novos em user_profiles, children, relationships e L3
    if (category === 'info') {
      extractAndPersistFacts(stringId, authorName, messageText, aiReply)
        .catch(e => console.error('[Extrator] Erro:', e));
    }

    // Compactação
    const { count } = await supabase
      .from('brain')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', stringId)
      .eq('category', 'info');

    if (count && count >= 20) await compactMemory(stringId, authorName);

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true });
  }
}

// ============================================================
// EXTRATOR CONTÍNUO DE FATOS
// Roda em paralelo após cada mensagem classificada como 'info'
// Detecta fatos novos e persiste nas tabelas certas
// ============================================================
async function extractAndPersistFacts(
  userId: string,
  userName: string,
  userMessage: string,
  aiReply: string
) {
  const prompt = `
Analise esta troca e extraia APENAS fatos pessoais novos mencionados explicitamente.
Retorne APENAS JSON válido, sem explicações.

Usuário: "${userMessage}"
Assistente: "${aiReply}"

Retorne:
{
  "fatos_detectados": true,
  "perfil": {
    "cidade": null,
    "cidade_origem": null,
    "profissao": null,
    "nascimento": null
  },
  "esposa": {
    "nome": null,
    "aniversario": null
  },
  "filhos": [],
  "fe": null,
  "objetivos": null,
  "preferencias": null
}

Regras:
- Retorne null para campos não mencionados EXPLICITAMENTE nesta troca
- filhos: [{"nome": "Miguel", "idade": 5}] apenas se mencionados agora
- fatos_detectados: false se nenhum fato pessoal foi compartilhado
- Se fatos_detectados for false, os outros campos podem ser todos null
`;

  const raw = await callOpenRouter(prompt);
  const clean = raw.replace(/\`\`\`json|\`\`\`/g, '').trim();
  const extracted = JSON.parse(clean);

  if (!extracted.fatos_detectados) return; // nada novo — sai sem custo

  console.log('[Extrator] Fatos detectados:', JSON.stringify(extracted));

  // ── Atualiza user_profiles ──────────────────────────────
  const profilePatch: Record<string, any> = {};
  const p = extracted.perfil || {};
  const e = extracted.esposa || {};

  if (p.cidade)        profilePatch.city           = p.cidade;
  if (p.cidade_origem) profilePatch.birth_city     = p.cidade_origem;
  if (p.profissao)     profilePatch.current_job    = p.profissao;
  if (p.nascimento)    profilePatch.birth_date     = p.nascimento;
  if (e.nome)          profilePatch.spouse_name    = e.nome;
  if (e.aniversario)   profilePatch.spouse_birthday = e.aniversario;

  if (Object.keys(profilePatch).length > 0) {
    profilePatch.user_id    = userId;
    profilePatch.updated_at = new Date().toISOString();
    await supabase
      .from('user_profiles')
      .upsert(profilePatch, { onConflict: 'user_id' });
    console.log('[Extrator] user_profiles atualizado:', profilePatch);
  }

  // ── Atualiza children ───────────────────────────────────
  const filhos: any[] = extracted.filhos || [];
  for (const filho of filhos) {
    if (!filho.nome) continue;
    const birthYear  = filho.idade ? new Date().getFullYear() - filho.idade : null;
    const birth_date = birthYear ? `${birthYear}-01-01` : null;
    const lifePhase  =
      !filho.idade      ? 'child'       :
      filho.idade <= 3  ? 'baby'        :
      filho.idade <= 11 ? 'child'       :
      filho.idade <= 17 ? 'teen'        :
      filho.idade <= 24 ? 'young_adult' : 'adult';

    // Upsert por nome + parent_id para evitar duplicatas
    const { data: existing } = await supabase
      .from('children')
      .select('id')
      .eq('parent_id', userId)
      .eq('name', filho.nome)
      .single()
      .catch(() => ({ data: null }));

    if (existing) {
      await supabase.from('children')
        .update({ birth_date, life_phase: lifePhase, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await supabase.from('children').insert({
        parent_id: userId, name: filho.nome,
        birth_date, life_phase: lifePhase,
        updated_at: new Date().toISOString()
      });
    }
    console.log(`[Extrator] children: ${filho.nome}`);
  }

  // ── Atualiza relationships (esposa) ─────────────────────
  if (e.nome) {
    const { data: existingRel } = await supabase
      .from('relationships')
      .select('id')
      .eq('user_id_a', userId)
      .eq('relation_type', 'spouse')
      .single()
      .catch(() => ({ data: null }));

    if (existingRel) {
      await supabase.from('relationships')
        .update({ nickname: e.nome, metadata: { birthday: e.aniversario } })
        .eq('id', existingRel.id);
    } else {
      await supabase.from('relationships').insert({
        user_id_a: userId, relation_type: 'spouse',
        nickname: e.nome, metadata: { birthday: e.aniversario },
        created_at: new Date().toISOString()
      });
    }
    console.log(`[Extrator] relationships: esposa ${e.nome}`);
  }

  // ── Atualiza L3 imediatamente ───────────────────────────
  const { data: user } = await supabase
    .from('users')
    .select('current_context')
    .eq('id', userId)
    .single();

  let ctx = user?.current_context || '';
  const patches: Record<string, string> = {};

  if (p.cidade)        patches['Localização'] = p.cidade;
  if (p.cidade_origem) patches['Origem']      = p.cidade_origem;
  if (p.profissao)     patches['Emprego']     = p.profissao;
  if (e.nome)          patches['Esposa']      = e.nome;
  if (extracted.fe)    patches['Fé']          = extracted.fe;

  for (const [key, val] of Object.entries(patches)) {
    const regex = new RegExp(`- ${key}:.*`, 'i');
    const line  = `- ${key}: ${val}`;
    ctx = regex.test(ctx) ? ctx.replace(regex, line) : ctx + `\n${line}`;
  }

  // Adiciona filhos novos ao L3
  for (const filho of filhos) {
    if (!filho.nome) continue;
    if (!ctx.includes(filho.nome)) {
      ctx = ctx.replace(/- Filhos:(.*)/i, (m: string) =>
        m.includes(filho.nome) ? m : `${m}, ${filho.nome} (${filho.idade} anos)`
      );
      if (!ctx.includes('- Filhos:')) {
        ctx += `\n- Filhos: ${filho.nome} (${filho.idade} anos)`;
      }
    }
  }

  await supabase
    .from('users')
    .update({ current_context: ctx.trim(), updated_at: new Date().toISOString() })
    .eq('id', userId);

  console.log('[Extrator] L3 atualizado em tempo real');
}