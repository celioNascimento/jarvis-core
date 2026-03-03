import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    
    // --- 1. IDENTIFICAÇÃO DO SUJEITO (QUEM) ---
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";

    if (!messageText) return NextResponse.json({ ok: true });

    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, role')
      .eq('id', telegramUserId)
      .single();

    const authorName = userProfile?.nickname || userFirstName;
    const isKnownUser = !!userProfile;

    // --- 2. COMANDOS DE SISTEMA ---
    if (messageText.startsWith('/ignore')) {
      const termToIgnore = messageText.replace('/ignore', '').trim().toLowerCase();
      if (!termToIgnore) return await sendTelegram(chatId, "⚠️ Diga o que devo ignorar. Ex: `/ignore Shopee`.");
      await supabase.from('filters').upsert({ term: termToIgnore });
      return await sendTelegram(chatId, `✅ Entendido! O termo "${termToIgnore}" foi filtrado dos seus resumos.`);
    }

    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, project_tag, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true });

      const googleContext = await getGoogleContext();
      const activityData = logs?.map(l => `[${l.project_tag || l.category}] ${l.content}`).join('\n') || "Sem notas locais nas últimas 24h.";
      
      const summaryPrompt = `Resuma as últimas 24h para o ${authorName}. DADOS LOCAIS: \n${activityData}\n DADOS GOOGLE: \n${googleContext}`;
      const aiSummary = await callOpenRouter(summaryPrompt); 
      return await sendTelegram(chatId, `📊 *Resumo Consolidado:*\n\n${aiSummary}`);
    }

    // --- 3. EXTRATOR DE HIERARQUIA (ONDE) ---
    const textLower = messageText.toLowerCase();
    const cleanMessage = messageText.replace(/#(claude|gemini)/ig, '');
    const projectTag = (cleanMessage.match(/#(\w+)/i) || [])[1];
    const contextTag = (cleanMessage.match(/@(\w+)/i) || [])[1];
    const moduleTag = (cleanMessage.match(/\[(.*?)\]/i) || [])[1];

    let projectId = null;
    if (projectTag) {
      const { data: proj } = await supabase.from('projects').select('id').ilike('tag', projectTag).single();
      projectId = proj?.id || null;
    }

    // --- 4. A PORTARIA (Filtro de Ambiguidade) ---
    const ambiguous = ['senha', 'bug', 'erro', 'falha', 'login', 'banco', 'deploy'].some(w => textLower.includes(w));
    if (ambiguous && !projectTag) {
      return await sendTelegram(chatId, "⚠️ **Contexto Ausente:** Use `#` (ex: #PQF) para eu saber onde procurar essa informação.");
    }

    const queryEmbedding = await generateEmbedding(cleanMessage);

    // --- 5. BUSCA HD (Memórias Consolidadas) ---
    let hdContext = "Sem dados no HD vetorial para este assunto.";
    if (projectTag && queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, filter_project: projectTag, match_threshold: 0.6, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => `[HD]: ${r.summary}`).join('\n');
    }

    // --- 6. BUSCA RAM (Histórico Recente) ---
    let ramQuery = supabase.from('brain').select('content, metadata').order('created_at', { ascending: false }).limit(15);
    if (projectTag) ramQuery = ramQuery.eq('project_tag', projectTag);
    const { data: history } = await ramQuery;
    const ramMemory = history?.reverse().map(h => `${h.metadata?.user || 'Desconhecido'}: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n') || "RAM Vazia.";

    // --- 7. SELEÇÃO DO MOTOR DE IA ---
    let modelToUse = "google/gemini-2.0-flash-001";
    let engineName = "Gemini Flash";
    if (textLower.includes('code') || textLower.includes('bug') || projectTag === 'PQF' || projectTag === 'ExpertFrotas' || textLower.includes('#claude')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5";
    }

    // --- 8. O PROMPT MESTRE DO JARVIS ---
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const finalPrompt = `
      USUÁRIO ATUAL: ${authorName} (${isKnownUser ? 'Membro Registrado' : 'Visitante/Novo'})
      CONTEXTO HD: ${hdContext}
      RAM: ${ramMemory}
      DATA DO SISTEMA: ${dataAtual}
      PROJETO: ${projectTag || 'Geral'}
      ENTRADA (${authorName} disse): "${cleanMessage}"
    `;

    let aiReply = await callOpenRouter(finalPrompt, modelToUse);

    // --- 9. INTERCEPTADORES (Os Olhos e o Braço Mecânico) ---
    if (aiReply.includes('[LER_CONTEXTO]')) {
      const context = await getGoogleContext();
      aiReply = aiReply.replace('[LER_CONTEXTO]', `\n\n🔍 **Dados Recuperados do Google:**\n${context}`);
    }

    // Interceptador: CRIAR
    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim());
      aiReply = aiReply.replace(scheduleRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    // Interceptador: ALTERAR
    const updateRegex = /\[ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\]/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim());
      aiReply = aiReply.replace(updateRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    // Interceptador: APAGAR
    const deleteRegex = /\[APAGAR_AGENDA:\s*(.*?)\]/i;
    const deleteMatch = aiReply.match(deleteRegex);
    if (deleteMatch) {
      const result = await deleteGoogleEvent(deleteMatch[1].trim());
      aiReply = aiReply.replace(deleteRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    if (!aiReply.includes("⚠️ Fallback") && modelToUse.includes("claude")) aiReply += `\n\n*(Motor: ${engineName})*`;

    // --- 10. FINALIZAÇÃO E PERSISTÊNCIA ---
    await supabase.from('brain').insert([{
      content: cleanMessage,
      category: projectTag ? 'Contexto' : 'Nota',
      project_tag: projectTag || 'Jarvis_AI',
      project_id: projectId, 
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, context: contextTag, module: moduleTag, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}

// ==========================================
// FUNÇÕES AUXILIARES E INTEGRAÇÕES
// ==========================================

async function createGoogleEvent(summary: string, startTime: string) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro: Token ausente no banco.";
    let startIso = startTime.trim().replace(' ', 'T');
    if (!startIso.includes('-') && !startIso.endsWith('Z')) startIso += '-03:00'; 
    const startDate = new Date(startIso);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Sao_Paulo' },
    };
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? "Agendado com sucesso na sua Google Agenda!" : "Falha na API do Google Agenda.";
  } catch { return "Erro interno no agendamento."; }
}

async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro de token.";
    
    // 1. Busca o evento pelo nome (API nativa do Google faz a busca pra nós)
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    if (!cal.items || cal.items.length === 0) return `Não encontrei nenhum evento contendo "${searchTerm}" para alterar.`;
    
    const eventId = cal.items[0].id;
    
    // 2. Prepara nova data e hora
    let startIso = newStartTime.trim().replace(' ', 'T');
    if (!startIso.includes('-') && !startIso.endsWith('Z')) startIso += '-03:00';
    const startDate = new Date(startIso);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
    
    const event = {
      summary: newSummary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Sao_Paulo' },
    };
    
    // 3. Atualiza usando PATCH
    const updateRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    
    return updateRes.ok ? `Evento corrigido para: ${newSummary} (${startDate.toLocaleString('pt-BR')})` : "Falha ao atualizar o evento.";
  } catch { return "Erro interno ao alterar agenda."; }
}

async function deleteGoogleEvent(searchTerm: string) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro de token.";
    
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    if (!cal.items || cal.items.length === 0) return `Não encontrei nenhum evento contendo "${searchTerm}" para apagar.`;
    
    const eventId = cal.items[0].id;
    
    const deleteRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    return deleteRes.ok ? `O evento "${searchTerm}" foi removido da sua agenda.` : "Falha ao apagar o evento.";
  } catch { return "Erro interno ao apagar agenda."; }
}

async function getGoogleContext() {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Token Google ausente.";
    
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=3&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    const events = cal.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Nenhum evento próximo.";

    const mailRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=3`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const mailData = await mailRes.json();
    let emails = "Caixa de entrada limpa.";
    if (mailData.messages) {
      const details = await Promise.all(mailData.messages.map(async (m: any) => {
        const d = await (await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
        const subject = d.payload.headers.find((h: any) => h.name === 'Subject')?.value || 'Sem Assunto';
        return `- ${subject}`;
      }));
      emails = details.join('\n');
    }
    return `AGENDA:\n${events}\n\nGMAIL:\n${emails}`;
  } catch { return "Erro ao ler dados do Google."; }
}

async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
  if (!data) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: JSON.stringify({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: data.value, grant_type: 'refresh_token' }),
  });
  return (await res.json()).access_token;
}

async function callOpenRouter(prompt: string, model: string = "google/gemini-2.0-flash-001") {
  const fetchAI = async (m: string) => {
    return await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m, 
        messages: [
          { 
            role: "system", 
            content: "Você é o Jarvis. Personalidade: Empático, focado e inteligente. Adapte-se ao contexto: vibre com vitórias, seja prestativo em erros técnicos e acolhedor com assuntos familiares. SEJA SUCINTO, não enrole ou crie textos gigantes. DIRETRIZ CRÍTICA: Se precisar consultar algo, use '[LER_CONTEXTO]'. Para agendar evento novo: '[AGENDAR: Titulo | YYYY-MM-DDTHH:mm:ss]'. Para alterar ou corrigir um evento: '[ALTERAR_AGENDA: Termo de Busca (Nome atual) | Novo Titulo | YYYY-MM-DDTHH:mm:ss]'. Para cancelar ou apagar: '[APAGAR_AGENDA: Termo de Busca (Nome atual)]'. Não narre o que vai fazer, apenas execute ou responda com naturalidade." 
          }, 
          { role: "user", content: prompt }
        ]
      })
    });
  };
  let res = await fetchAI(model);
  let data = await res.json();
  if (data.error && model !== "google/gemini-2.0-flash-001") data = await (await fetchAI("google/gemini-2.0-flash-001")).json();
  return data.choices?.[0]?.message?.content || "❌ Estou enfrentando instabilidade na minha rede neural agora.";
}

async function generateEmbedding(text: string) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text })
    });
    return (await res.json()).data[0].embedding;
  } catch { return null; }
}

async function sendTelegram(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}