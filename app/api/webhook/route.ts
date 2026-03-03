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
      if (!termToIgnore) return await sendTelegram(chatId, "⚠️ Diga o que ignorar. Ex: `/ignore Shopee`.");
      await supabase.from('filters').upsert({ term: termToIgnore });
      return await sendTelegram(chatId, `✅ Termo "${termToIgnore}" filtrado dos resumos.`);
    }

    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, project_tag, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true });

      const googleContext = await getGoogleContext();
      const activityData = logs?.map(l => `[${l.project_tag || l.category}] ${l.content}`).join('\n') || "Sem notas locais.";
      
      const summaryPrompt = `Resuma as últimas 24h: LOCAIS: \n${activityData}\n GOOGLE: \n${googleContext}`;
      const aiSummary = await callOpenRouter(summaryPrompt); 
      return await sendTelegram(chatId, `📊 *Resumo Consolidado:*\n\n${aiSummary}`);
    }

    // --- 2. EXTRATOR DE HIERARQUIA ---
    const textLower = messageText.toLowerCase();
    const cleanMessage = messageText.replace(/#(claude|gemini)/ig, '');
    const projectTag = (cleanMessage.match(/#(\w+)/i) || [])[1];
    const contextTag = (cleanMessage.match(/@(\w+)/i) || [])[1];
    const moduleTag = (cleanMessage.match(/\[(.*?)\]/i) || [])[1];

    // --- 3. A PORTARIA (Filtro de Ambiguidade) ---
    const ambiguous = ['senha', 'bug', 'erro', 'falha', 'login', 'banco', 'deploy'].some(w => textLower.includes(w));
    if (ambiguous && !projectTag) {
      return await sendTelegram(chatId, "⚠️ **Contexto Ausente:** Use `#` (ex: #PQF) para eu saber onde procurar.");
    }

    const queryEmbedding = await generateEmbedding(cleanMessage);

    // --- 4. BUSCA HD (Memórias) ---
    let hdContext = "Sem dados no HD.";
    if (projectTag && queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { query_embedding: queryEmbedding, filter_project: projectTag, match_threshold: 0.6, match_count: 2 });
      if (search?.length) hdContext = search.map((r: any) => `[HD]: ${r.summary}`).join('\n');
    }

    // --- 5. BUSCA RAM (Histórico) ---
    let ramQuery = supabase.from('brain').select('content, metadata').order('created_at', { ascending: false }).limit(15);
    if (projectTag) ramQuery = ramQuery.eq('project_tag', projectTag);
    const { data: history } = await ramQuery;
    const ramMemory = history?.reverse().map(h => `User: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n') || "RAM Vazia.";

    // --- 6. SELEÇÃO DO MOTOR ---
    let modelToUse = "google/gemini-2.0-flash-001";
    let engineName = "Gemini Flash";
    if (textLower.includes('code') || textLower.includes('bug') || projectTag === 'PQF' || projectTag === 'ExpertFrotas' || textLower.includes('#claude')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5";
    }

    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const finalPrompt = `CONTEXTO HD: ${hdContext}\nRAM: ${ramMemory}\nDATA: ${dataAtual}\nPROJETO: ${projectTag || 'Geral'}\nENTRADA: ${cleanMessage}`;

    let aiReply = await callOpenRouter(finalPrompt, modelToUse);

    // --- 7. INTERCEPTADORES (GMAIL & AGENDA) ---
    
    // Interceptador de Leitura (GMAIL/AGENDA)
    if (aiReply.includes('[LER_CONTEXTO]')) {
      const context = await getGoogleContext();
      aiReply = aiReply.replace('[LER_CONTEXTO]', `\n\n🔍 **Dados do Google:**\n${context}`);
    }

    // Interceptador de Agendamento (BRAÇO MECÂNICO)
    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim());
      aiReply = aiReply.replace(scheduleRegex, `\n\n🗓️ **Ação:** ${result}`);
    }

    // --- 8. FINALIZAÇÃO E PERSISTÊNCIA ---
    if (!aiReply.includes("⚠️ Fallback") && modelToUse.includes("claude")) aiReply += `\n\n*(Motor: ${engineName})*`;

    await supabase.from('brain').insert([{
      content: cleanMessage,
      category: projectTag ? 'Contexto' : 'Nota',
      project_tag: projectTag || 'Jarvis_AI',
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, context: contextTag, module: moduleTag }
    }]);

    await sendTelegram(chatId, aiReply);
    if (projectTag) await consolidateKnowledge(projectTag);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}

// ==========================================
// FUNÇÕES AUXILIARES (CONSOLIDADAS)
// ==========================================

async function createGoogleEvent(summary: string, startTime: string) {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Erro: Token ausente.";
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
    return res.ok ? "Agendado com sucesso!" : "Falha na API Google.";
  } catch { return "Erro no agendamento."; }
}

async function getGoogleContext() {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "Token ausente.";
    
    // Agenda
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=3&timeMin=${new Date().toISOString()}&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const cal = await calRes.json();
    const events = cal.items?.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n') || "Sem eventos.";

    // Gmail (Assuntos)
    const mailRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=3`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const mailData = await mailRes.json();
    let emails = "Sem e-mails.";
    if (mailData.messages) {
      const details = await Promise.all(mailData.messages.map(async (m: any) => {
        const d = await (await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
        const subject = d.payload.headers.find((h: any) => h.name === 'Subject')?.value || 'Sem Assunto';
        return `- ${subject}`;
      }));
      emails = details.join('\n');
    }
    return `AGENDA:\n${events}\n\nGMAIL:\n${emails}`;
  } catch { return "Erro ao ler Google."; }
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
        messages: [{ role: "system", content: "Você é o Jarvis. Seja sucinto e direto. Se precisar ler e-mails ou agenda, responda APENAS: '[LER_CONTEXTO]'. Se precisar agendar, use: '[AGENDAR: Titulo | ISO_DATETIME]'. Não narre o que vai fazer, apenas execute." }, { role: "user", content: prompt }]
      })
    });
  };
  let res = await fetchAI(model);
  let data = await res.json();
  if (data.error && model !== "google/gemini-2.0-flash-001") data = await (await fetchAI("google/gemini-2.0-flash-001")).json();
  return data.choices?.[0]?.message?.content || "❌ Erro na IA.";
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

async function consolidateKnowledge(projectTag: string) { /* ... lógica mantida ... */ }
