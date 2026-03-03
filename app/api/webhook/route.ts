import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";

    if (!messageText) return NextResponse.json({ ok: true });

    // --- 1. COMANDOS DE SISTEMA ---
    if (messageText.startsWith('/ignore')) {
      const termToIgnore = messageText.replace('/ignore', '').trim().toLowerCase();
      if (!termToIgnore) return await sendTelegram(chatId, "⚠️ Celio, falta o termo! Ex: `/ignore Shopee`.");
      await supabase.from('filters').upsert({ term: termToIgnore });
      return await sendTelegram(chatId, `✅ Feito! O termo "${termToIgnore}" não vai mais poluir nossos resumos.`);
    }

    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase.from('brain').select('content, category, project_tag').gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const googleContext = await getGoogleContext();
      const activityData = logs?.map(l => `[${l.project_tag}] ${l.content}`).join('\n') || "Nada registrado nas últimas 24h.";
      const aiSummary = await callOpenRouter(`Resuma o dia para o ${userFirstName}. LOCAIS: \n${activityData}\n GOOGLE: \n${googleContext}`); 
      return await sendTelegram(chatId, `📊 *Resumo do Dia:*\n\n${aiSummary}`);
    }

    // --- 2. IDENTIFICAÇÃO DE CONTEXTO ---
    const textLower = messageText.toLowerCase();
    const cleanMessage = messageText.replace(/#(claude|gemini)/ig, '');
    const projectTag = (cleanMessage.match(/#(\w+)/i) || [])[1];
    const contextTag = (cleanMessage.match(/@(\w+)/i) || [])[1];

    const queryEmbedding = await generateEmbedding(cleanMessage);

    // --- 3. BUSCA HD (MEMÓRIA LONGA) ---
    let hdContext = "Sem registros profundos.";
    if (projectTag && queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, filter_project: projectTag, match_threshold: 0.6, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => r.summary).join('\n');
    }

    // --- 4. BUSCA RAM (HISTÓRICO RECENTE) ---
    let ramQuery = supabase.from('brain').select('content, metadata').order('created_at', { ascending: false }).limit(12);
    if (projectTag) ramQuery = ramQuery.eq('project_tag', projectTag);
    const { data: history } = await ramQuery;
    const ramMemory = history?.reverse().map(h => `User: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n');

    // --- 5. SELEÇÃO DO MOTOR ---
    let modelToUse = "google/gemini-2.0-flash-001";
    if (textLower.includes('code') || projectTag === 'PQF' || textLower.includes('#claude')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
    }

    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const finalPrompt = `USUÁRIO: ${userFirstName}\nDATA: ${dataAtual}\nPROJETO: ${projectTag || 'Geral'}\nHD: ${hdContext}\nRAM: ${ramMemory}\nENTRADA: ${cleanMessage}`;

    let aiReply = await callOpenRouter(finalPrompt, modelToUse);

    // --- 6. INTERCEPTADORES (GMAIL / AGENDA / BRAÇO) ---
    if (aiReply.includes('[LER_CONTEXTO]')) {
      const context = await getGoogleContext();
      aiReply = aiReply.replace('[LER_CONTEXTO]', `\n\n🔍 **Aqui está o que encontrei:**\n${context}`);
    }

    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim());
      aiReply = aiReply.replace(scheduleRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    // --- 7. PERSISTÊNCIA E FINALIZAÇÃO ---
    await supabase.from('brain').insert([{
      content: cleanMessage,
      project_tag: projectTag || 'Geral',
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: userFirstName }
    }]);

    await sendTelegram(chatId, aiReply);

    // --- 8. GATILHO DE CONSOLIDAÇÃO (TRAVADO PARA EVITAR LOOPS) ---
    // Ative apenas via rota admin à tarde para limpar o legado com segurança.
    // if (projectTag) await consolidateKnowledge(projectTag);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: true }); 
  }
}

// ==========================================
// INTEGRAÇÕES GOOGLE (MANTIDAS E BLINDADAS)
// ==========================================

async function createGoogleEvent(summary: string, startTime: string) {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: JSON.stringify({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: data.value, grant_type: 'refresh_token' }) });
    const accessToken = (await tokenRes.json()).access_token;

    let startIso = startTime.trim().replace(' ', 'T');
    if (!startIso.includes('-') && !startIso.endsWith('Z')) startIso += '-03:00';
    const startDate = new Date(startIso);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, start: { dateTime: startDate.toISOString() }, end: { dateTime: endDate.toISOString() } })
    });
    return res.ok ? "Agendado com sucesso! Já está na sua grade." : "O Google barrou o agendamento. Pode ser permissão.";
  } catch { return "Houve um erro técnico ao tentar agendar."; }
}

async function getGoogleContext() {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: JSON.stringify({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: data.value, grant_type: 'refresh_token' }) });
    const accessToken = (await tokenRes.json()).access_token;

    const cal = await (await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=3&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
    const events = cal.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Agenda livre.";

    const mail = await (await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=3`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
    let emails = "Tudo em dia no Gmail.";
    if (mail.messages) {
      const details = await Promise.all(mail.messages.map(async (m: any) => {
        const d = await (await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
        return `- ${d.payload.headers.find((h: any) => h.name === 'Subject')?.value || 'Sem assunto'}`;
      }));
      emails = details.join('\n');
    }
    return `AGENDA:\n${events}\n\nGMAIL:\n${emails}`;
  } catch { return "Falha ao ler dados do Google."; }
}

async function callOpenRouter(prompt: string, model: string = "google/gemini-2.0-flash-001") {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model, 
      messages: [{ role: "system", content: "Você é o Jarvis. Personalidade: Leal, técnico e humano. Use emojis sutis. Se o Celio estiver focado, seja direto. Se ele pedir algo pessoal ou familiar, seja acolhedor. Comemore sucessos, mas seja sério em erros. Se precisar de dados Google, responda APENAS: '[LER_CONTEXTO]'. Para agendar: '[AGENDAR: Titulo | ISO_DATETIME]'. Nunca encha linguiça." }, { role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Estou com dificuldades de conexão agora, Celio.";
}

async function generateEmbedding(text: string) {
  const res = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input: text }) });
  return (await res.json()).data[0].embedding;
}

async function sendTelegram(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) });
}
