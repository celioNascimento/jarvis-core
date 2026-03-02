import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;

    if (!messageText) return NextResponse.json({ ok: true });

    // --- 1. COMANDOS DE SISTEMA (/ignore e /resumo) ---
    if (messageText.startsWith('/ignore')) {
      const termToIgnore = messageText.replace('/ignore', '').trim().toLowerCase();
      if (!termToIgnore) {
        await sendTelegram(chatId, "⚠️ Celio, diga o que devo ignorar. Ex: `/ignore Shopee`.");
        return NextResponse.json({ ok: true });
      }
      await supabase.from('filters').upsert({ term: termToIgnore });
      await sendTelegram(chatId, `✅ Entendido. O termo "${termToIgnore}" será filtrado dos resumos.`);
      return NextResponse.json({ ok: true });
    }

    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, project_tag, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true });

      const googleContext = await getGoogleContext();
      const activityData = logs?.map(l => `[${l.project_tag || l.category}] ${l.content}`).join('\n') || "Sem notas locais hoje.";
      
      const summaryPrompt = `
      Você é o Jarvis. Resuma as últimas 24h para o Celio.
      DADOS LOCAIS: \n${activityData}\n
      DADOS GOOGLE: \n${googleContext}\n
      Estruture em: 1. Compromissos Urgentes, 2. Progresso Técnico, 3. Próximo Passo Sugerido.
      `;

      const aiSummary = await callOpenRouter(summaryPrompt); 
      await sendTelegram(chatId, `📊 *Resumo Consolidado:*\n\n${aiSummary}`);
      return NextResponse.json({ ok: true });
    }

    // --- 2. EXTRATOR DE HIERARQUIA (Tags, Contextos e Módulos) ---
    const textLower = messageText.toLowerCase();
    const cleanMessage = messageText.replace(/#claude/ig, '').replace(/#gemini/ig, '');
    
    const projectMatch = cleanMessage.match(/#(\w+)/i);
    const contextMatch = cleanMessage.match(/@(\w+)/i);
    const moduleMatch = cleanMessage.match(/\[(.*?)\]/i);

    const projectTag = projectMatch ? projectMatch[1] : null;
    const contextTag = contextMatch ? contextMatch[1] : null;
    const moduleTag = moduleMatch ? moduleMatch[1] : null;

    // --- 3. A PORTARIA (Filtro de Ambiguidade Estático - Em breve Dinâmico) ---
    const ambiguousWords = ['senha', 'bug', 'erro', 'falha', 'login', 'banco', 'deploy'];
    const isAmbiguous = ambiguousWords.some(w => textLower.includes(w));

    if (isAmbiguous && !projectTag) {
      await sendTelegram(chatId, "⚠️ **Contexto Ausente:**\nCelio, de qual projeto estamos falando? Identifique usando `#` (ex: #PQF, #ExpertFrotas) para eu saber em qual gaveta procurar.");
      return NextResponse.json({ ok: true });
    }

    if (projectTag === 'PQF' && isAmbiguous && !contextTag) {
      await sendTelegram(chatId, "🤔 **Em qual perfil do #PQF?**\nUse `@Prestador` ou `@Cliente` para eu ser cirúrgico e não misturar os fluxos.");
      return NextResponse.json({ ok: true });
    }

    // --- 4. GERAÇÃO DO VETOR MATEMÁTICO (DNA da Pergunta) ---
    const queryEmbedding = await generateEmbedding(cleanMessage);

    // --- 5. BUSCA NO HD (Vetores na tabela 'memories') ---
    let hdContext = "Sem resumos consolidados relevantes no HD.";
    if (projectTag && queryEmbedding) {
      const { data: searchResults } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        filter_project: projectTag,
        match_threshold: 0.6,
        match_count: 2
      });

      if (searchResults && searchResults.length > 0) {
        hdContext = searchResults.map((r: any) => `[HD - Resumo Técnico]: ${r.summary}`).join('\n\n');
      }
    }

    // --- 6. BUSCA NA RAM (Últimas 15 mensagens do Cérebro) ---
    let ramQuery = supabase.from('brain').select('content, metadata').order('created_at', { ascending: false }).limit(15);
    if (projectTag) ramQuery = ramQuery.eq('project_tag', projectTag);
    
    const { data: history } = await ramQuery;
    const ramMemory = history?.reverse().map(h => `User: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n') || "RAM Vazia.";

    // --- 7. SELEÇÃO DO MOTOR DE IA ---
    let modelToUse = "google/gemini-2.0-flash-001";
    let engineName = "Gemini Flash";

    if (textLower.includes('code') || textLower.includes('bug') || projectTag === 'pqf' || projectTag === 'expertfrotas') {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5 Sonnet";
    }
    if (textLower.includes('#claude')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5 Sonnet (Forçado)";
    } else if (textLower.includes('#gemini')) {
      modelToUse = "google/gemini-2.0-flash-001";
      engineName = "Gemini Flash (Forçado)";
    }

    // --- 8. O PROMPT MESTRE DO JARVIS ---
    const finalPrompt = `
      DADOS DO HD (Conhecimento Profundo / Vetores):
      ${hdContext}

      RAM RECENTE (Fio da meada - Últimas 15 msgs):
      ${ramMemory}

      NOVA ENTRADA DO USUÁRIO:
      Contexto Endereçado: Projeto: ${projectTag || 'Geral'} | Perfil: ${contextTag || 'N/A'} | Módulo: ${moduleTag || 'N/A'}
      Mensagem: ${cleanMessage}
    `;

    let aiReply = await callOpenRouter(finalPrompt, modelToUse);

    if (modelToUse !== "google/gemini-2.0-flash-001" && !aiReply.includes("⚠️ Fallback")) {
      aiReply += `\n\n*(Motor: ${engineName})*`;
    }

    // --- 9. PERSISTÊNCIA BRUTA NA RAM ---
    await supabase.from('brain').insert([{
      content: cleanMessage,
      category: projectTag ? 'Contexto' : 'Nota',
      project_tag: projectTag || 'Jarvis_AI',
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, context: contextTag, module: moduleTag }
    }]);

    await sendTelegram(chatId, aiReply);

    // --- 10. GATILHO DE APRENDIZADO SILENCIOSO (Usando Gemini) ---
    // Roda em background antes de fechar a requisição
    if (projectTag) {
      await consolidateKnowledge(projectTag);
    }

    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}

// ==========================================
// INTEGRAÇÕES E FUNÇÕES AUXILIARES
// ==========================================

// --- NOVO: Motor de Aprendizado Contínuo ---
async function consolidateKnowledge(projectTag: string) {
  try {
    // Busca quantas mensagens ainda não foram consolidadas para esse projeto
    const { data: logs, count } = await supabase
      .from('brain')
      .select('id, content', { count: 'exact' })
      .eq('project_tag', projectTag)
      .is('metadata->consolidated', null)
      .limit(6); // Pegamos lotes curtos para manter a precisão

    // Se tivermos acumulado 5 ou mais mensagens, ativamos o aprendizado
    if (count && count >= 5 && logs) {
      const batchText = logs.map(l => l.content).join('\n');
      const logIds = logs.map(l => l.id);

      const summaryPrompt = `Você é um engenheiro de software documentando um projeto. 
      Resuma as seguintes anotações do projeto #${projectTag}. 
      Extraia apenas decisões técnicas, regras de negócio resolvidas ou correções de bugs. 
      Seja direto, técnico e mantenha os nomes de variáveis/arquivos.
      
      Anotações brutas:
      ${batchText}`;

      // Usa explicitamente o Gemini Flash para fazer o resumo (Custo quase zero)
      const summary = await callOpenRouter(summaryPrompt, "google/gemini-2.0-flash-001");
      const embedding = await generateEmbedding(summary);

      if (embedding) {
        // Grava no HD Vetorial
        await supabase.from('memories').insert({
          project_tag: projectTag,
          summary: summary,
          embedding: embedding
        });

        // Marca as mensagens do 'brain' como consolidadas para não repetir
        await supabase.from('brain')
          .update({ metadata: { consolidated: true } })
          .in('id', logIds);
      }
    }
  } catch (e) {
    console.error("Falha ao consolidar memória:", e);
  }
}

async function generateEmbedding(text: string) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text
      })
    });
    const data = await res.json();
    return data.data[0].embedding;
  } catch (e) {
    console.error("Erro ao gerar Embedding:", e);
    return null;
  }
}

async function getGoogleContext() {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Não foi possível acessar os dados do Google (Token ausente).";

    const { data: ignoreList } = await supabase.from('filters').select('term');
    const ignoreQuery = ignoreList?.map(f => ` -"${f.term}"`).join('') || "";

    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const calData = await calRes.json();
    const events = calData.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda vazia.";

    const mailRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread${ignoreQuery}&maxResults=3`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const mailData = await mailRes.json();
    let emails = "Sem e-mails novos.";
    
    if (mailData.messages) {
      const emailDetails = await Promise.all(mailData.messages.map(async (m: any) => {
        const det = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const d = await det.json();
        return `- ${d.snippet}`;
      }));
      emails = emailDetails.join('\n');
    }

    return `AGENDA:\n${events}\n\nGMAIL (Snippets):\n${emails}`;
  } catch (e) {
    return "Erro ao buscar dados no Google.";
  }
}

async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
  if (!data) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.value,
      grant_type: 'refresh_token',
    }),
  });
  const tokens = await res.json();
  return tokens.access_token;
}

async function callOpenRouter(prompt: string, model: string = "google/gemini-2.0-flash-001") {
  const defaultModel = "google/gemini-2.0-flash-001";

  const fetchAI = async (modelName: string) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        "model": modelName, 
        "messages": [
          { 
            "role": "system", 
            "content": "Você é o Jarvis. Assistente focado e técnico. DIRETRIZ CRÍTICA: Nunca responda apenas com perguntas ou confirmações vazias. Sempre confirme explicitamente que a informação foi SALVA. Use o Framework de 4 Etapas: Capturar, Processar, Agendar e Executar. Seja cirúrgico, mantenha nomes de variáveis exatos." 
          },
          { "role": "user", "content": prompt }
        ]
      })
    });
    return await res.json();
  };

  let data = await fetchAI(model);

  if (data.error && model !== defaultModel) {
    console.warn(`[JARVIS FALLBACK] Falha no modelo ${model}. Acionando ${defaultModel}...`);
    data = await fetchAI(defaultModel);
    if (!data.error && data.choices) {
      return data.choices[0].message.content + "\n\n*(⚠️ Fallback de Emergência: O Claude falhou/sem saldo. O Gemini assumiu.)*";
    }
  }

  if (!data.error && data.choices) {
    return data.choices[0].message.content;
  }

  return "❌ Erro Crítico: Nenhum motor de IA pôde responder.";
}

async function sendTelegram(chatId: number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });

    if (!res.ok) {
      console.warn("Falha no Markdown, enviando como texto puro...");
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }
  } catch (error) {
    console.error("Erro fatal na comunicação com o Telegram:", error);
  }
}