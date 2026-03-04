import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    
    // 1. IDENTIFICAÇÃO E TRAVA DE ECO
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";
    const isBot = body.message?.from?.is_bot || false;

    if (isBot || !messageText) return NextResponse.json({ ok: true });

    const { data: userProfile } = await supabase
      .from('users')
      .select('nickname, role')
      .eq('id', telegramUserId)
      .single();

    const authorName = userProfile?.nickname || userFirstName;
    const isKnownUser = !!userProfile;

    // 2. COMANDOS DE SISTEMA
    if (messageText.startsWith('/ignore')) {
      const termToIgnore = messageText.replace('/ignore', '').trim().toLowerCase();
      if (!termToIgnore) return await sendTelegram(chatId, "⚠️ Diga o que devo ignorar.");
      await supabase.from('filters').upsert({ term: termToIgnore });
      return await sendTelegram(chatId, `✅ Termo "${termToIgnore}" filtrado.`);
    }

    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, project_tag, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true });

      const googleContext = await getGoogleContext();
      const activityData = logs?.map(l => `[${l.project_tag || l.category}] ${l.content}`).join('\n') || "Sem notas locais.";
      
      const summaryPrompt = `Resuma as últimas 24h para o ${authorName}. DADOS: \n${activityData}\n GOOGLE: \n${googleContext}`;
      const aiSummary = await callOpenRouter(summaryPrompt); 
      return await sendTelegram(chatId, `📊 *Resumo:*\n\n${aiSummary}`);
    }

    // 3. EXTRATOR DE HIERARQUIA
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

    // 4. HD: MEMÓRIA DE LONGO PRAZO (O QUE NÃO PODE SER ESQUECIDO)
    const queryEmbedding = await generateEmbedding(cleanMessage);
    let hdContext = "Sem dados profundos para este assunto.";
    if (queryEmbedding) {
      // Modificado para sempre buscar contexto geral se não houver tag de projeto
      const filter = projectTag ? projectTag : null;
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, filter_project: filter, match_threshold: 0.6, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    // 5. RAM: MEMÓRIA DE CURTO PRAZO (O FIO DA CONVERSA)
    let ramQuery = supabase.from('brain').select('content, metadata').order('created_at', { ascending: false }).limit(10);
    if (projectTag) ramQuery = ramQuery.eq('project_tag', projectTag);
    // Assegura que ele veja a conversa do usuário atual
    ramQuery = ramQuery.eq('user_id', telegramUserId); 
    
    const { data: history } = await ramQuery;
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `Celio: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Nenhuma conversa recente registrada.";

    // 6. CACHE: O MOTOR DE IA (PROMPT UNIFICADO)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    
    // O Dossiê que ensina a IA como pensar
    const finalPrompt = `
SISTEMA CENTRAL: JARVIS
USUÁRIO ATUAL: ${authorName}
DATA/HORA EXATA AGORA: ${dataAtual} (Fuso: São Paulo -03:00)

--- CACHE DE CONHECIMENTO ---

[1. HD (MEMÓRIA DE LONGO PRAZO)]
Use isso para lembrar de regras antigas, rotinas ou decisões de projetos.
${hdContext}

[2. RAM (HISTÓRICO DA CONVERSA ATUAL)]
Use isso APENAS para manter o contexto e a naturalidade. Siga a linha de raciocínio do usuário. Não trate isso como tarefas pendentes.
${ramMemory}

[3. MENSAGEM ATUAL (AÇÃO EXIGIDA)]
O usuário acabou de dizer: "${cleanMessage}"

--- REGRAS DE EXECUÇÃO (OBRIGAÇÃO CRÍTICA) ---
- Responda de forma natural, empática e prestativa à MENSAGEM ATUAL.
- SE o usuário pedir a hora, olhe para "DATA/HORA EXATA AGORA" no topo deste documento.
- VOCÊ ESTÁ PROIBIDO DE AGENDAR EVENTOS a menos que a MENSAGEM ATUAL contenha verbos imperativos explícitos de agendamento (Ex: "Agende", "Marque", "Crie um lembrete").
- Para agendamentos REAIS solicitados agora, gere exatamente: [AGENDAR: Titulo | YYYY-MM-DDTHH:mm:ss | 0]
    `;

    // Chamada limpa. O OpenRouter agora não tem regras conflitantes no "system".
    let aiReply = await callOpenRouter(finalPrompt);

    // 7. INTERCEPTADORES
    if (aiReply.includes('[LER_CONTEXTO]')) {
      const context = await getGoogleContext();
      aiReply = aiReply.replace('[LER_CONTEXTO]', `\n\n🔍 **Dados Recuperados:**\n${context}`);
    }

    const updateRegex = /\[ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim(), parseInt(updateMatch[4]));
      aiReply = aiReply.replace(updateRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim(), parseInt(scheduleMatch[3]));
      aiReply = aiReply.replace(scheduleRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    const deleteRegex = /\[APAGAR_AGENDA:\s*(.*?)\]/i;
    const deleteMatch = aiReply.match(deleteRegex);
    if (deleteMatch) {
      const result = await deleteGoogleEvent(deleteMatch[1].trim());
      aiReply = aiReply.replace(deleteRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    // 8. PERSISTÊNCIA NO BRAIN (Gravando na RAM)
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

// --- FUNÇÕES AUXILIARES ---

async function createGoogleEvent(summary: string, startTime: string, reminderMinutes: number = 30) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro: Token ausente.";
    
    let startIso = startTime.trim().replace(' ', 'T').substring(0, 19);
    startIso += '-03:00'; 
    
    const startDate = new Date(startIso);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); 
    
    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? `Agendado: ${summary} (Aviso ${reminderMinutes}min antes)` : "Falha API Google.";
  } catch { return "Erro interno."; }
}

async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro de token.";
    
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime&maxResults=1`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    if (!cal.items || cal.items.length === 0) return `Não encontrei "${searchTerm}".`;
    
    const eventId = cal.items[0].id;

    let cleanTime = newStartTime.trim().replace(' ', 'T').substring(0, 19);
    cleanTime += '-03:00';
    const localDate = new Date(cleanTime);

    const isoString = localDate.toISOString().replace('Z', '-03:00');
    const endDate = new Date(localDate.getTime() + 60 * 60 * 1000);
    const endIsoString = endDate.toISOString().replace('Z', '-03:00');
    
    const event = {
      summary: newSummary,
      start: { dateTime: isoString, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endIsoString, timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    
    const updateRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    
    const displayTime = localDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return updateRes.ok ? `Corrigido: ${newSummary} para as ${displayTime} (Aviso ${reminderMinutes}min antes)` : "Falha na atualização.";
  } catch (e: any) { return `Erro interno: ${e.message}`; }
}

async function deleteGoogleEvent(searchTerm: string) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro de token.";
    
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime&maxResults=1`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    if (!cal.items || cal.items.length === 0) return `Não encontrei "${searchTerm}".`;
    
    const deleteRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    return deleteRes.ok ? `Removido: "${searchTerm}".` : "Falha ao apagar.";
  } catch { return "Erro interno."; }
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

// O MOTOR AGORA RECEBE UM PROMPT LIMPO E DIRETO (SEM MÚLTIPLAS REGRAS DE SISTEMA)
async function callOpenRouter(prompt: string, model: string = "google/gemini-2.0-flash-001") {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model, 
      messages: [
        { role: "user", content: prompt } // Tudo foi unificado no Dossiê de Contexto
      ]
    })
  });
  let data = await res.json();
  return data.choices?.[0]?.message?.content || "❌ Instabilidade na rede neural.";
}

async function generateEmbedding(text: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text })
    });
    const json = await res.json();
    return json.data[0].embedding;
  } catch { return null; }
}

async function sendTelegram(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
                                                                    }
