import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;
    const telegramUserId = body.message?.from?.id;
    const userFirstName = body.message?.from?.first_name || "Usuário";
    const isBot = body.message?.from?.is_bot || false;

    if (isBot || !messageText) return NextResponse.json({ ok: true });

    // 1. IDENTIFICAÇÃO DO PERFIL
    const { data: userProfile } = await supabase.from('users').select('nickname').eq('id', telegramUserId).single();
    const authorName = userProfile?.nickname || userFirstName;

    // 2. HD: MEMÓRIA DE LONGO PRAZO (Busca Vetorial)
    const queryEmbedding = await generateEmbedding(messageText);
    let hdContext = "Sem dados profundos para este assunto.";
    if (queryEmbedding) {
      const { data: search } = await supabase.rpc('match_memories', { 
        query_embedding: queryEmbedding, 
        match_threshold: 0.5, 
        match_count: 3 
      });
      if (search?.length) hdContext = search.map((r: any) => `[Memória Antiga]: ${r.summary}`).join('\n');
    }

    // 3. RAM: MEMÓRIA DE CURTO PRAZO (Filtrando o Ruído/Saudações)
    const { data: history } = await supabase
      .from('brain')
      .select('content, category, metadata')
      .eq('user_id', telegramUserId)
      .neq('category', 'noise') // Ignora o lixo educacional na hora de pensar
      .order('created_at', { ascending: false })
      .limit(12);
    
    const ramMemory = history?.reverse().map(h => {
      const cleanAiReply = (h.metadata?.ai_reply || "").replace(/\[.*?\]/g, '').trim();
      return `${h.metadata?.user || 'Celio'}: ${h.content}\nJarvis: ${cleanAiReply}`;
    }).join('\n') || "Iniciando nova linha de raciocínio.";

    // 4. CACHE: O MOTOR DE IA (Dossiê Unificado)
    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const projectTag = (messageText.match(/#(\w+)/i) || [])[1];

    const finalPrompt = `
SISTEMA CENTRAL: JARVIS | USUÁRIO: ${authorName} | DATA: ${dataAtual}

[HISTÓRICO RECENTE (RAM)]
${ramMemory}

[MEMÓRIA DE LONGO PRAZO (HD)]
${hdContext}

[MENSAGEM ATUAL]
"${messageText}"

DIRETRIZES:
1. Use o HISTÓRICO para manter o fio da conversa. Não ignore o que foi dito antes.
2. Se o usuário pedir para mudar um comportamento ou rotina, aceite e aplique.
3. SÓ agende se houver verbos de comando claros.
4. OBRIGATÓRIO: Termine sua resposta com uma classificação de importância:
   - Se a mensagem do usuário foi apenas saudação/vazia: [CLASSE: noise]
   - Se houve troca de horários, planos, códigos ou decisões: [CLASSE: info]
    `;

    let aiReply = await callOpenRouter(finalPrompt);

    // 5. PROCESSAMENTO DE CLASSIFICAÇÃO E LIMPEZA
    const categoryMatch = aiReply.match(/\[CLASSE:\s*(\w+)\]/i);
    const category = categoryMatch ? categoryMatch[1].toLowerCase() : 'info';
    aiReply = aiReply.replace(/\[CLASSE:\s*\w+\]/g, '').trim();

    // 6. INTERCEPTADORES (AGENDA GOOGLE)
    const updateRegex = /\[ALTERAR_AGENDA:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const updateMatch = aiReply.match(updateRegex);
    if (updateMatch) {
      const result = await updateGoogleEvent(updateMatch[1].trim(), updateMatch[2].trim(), updateMatch[3].trim(), parseInt(updateMatch[4]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    const scheduleRegex = /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i;
    const scheduleMatch = aiReply.match(scheduleRegex);
    if (scheduleMatch) {
      const result = await createGoogleEvent(scheduleMatch[1].trim(), scheduleMatch[2].trim(), parseInt(scheduleMatch[3]));
      aiReply += `\n\n🗓️ **Ação:** ${result}`;
    }

    // 7. PERSISTÊNCIA NO BRAIN
    await supabase.from('brain').insert([{
      content: messageText,
      category: category, 
      project_tag: projectTag || 'Jarvis_AI',
      user_id: telegramUserId,
      embedding: queryEmbedding,
      metadata: { ai_reply: aiReply, user: authorName }
    }]);

    await sendTelegram(chatId, aiReply);

    // 8. MONITOR DE COMPACTAÇÃO
    const { count } = await supabase.from('brain').select('*', { count: 'exact', head: true }).eq('category', 'info');
    if (count && count >= 20) {
       // Sinalização visual no log para sabermos que a hora da faxina chegou
       console.log("🧠 JARVIS: RAM atingiu o limite de 20 blocos de informação. Pronto para compactar.");
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}

// --- FUNÇÕES AUXILIARES (ESTÁVEIS) ---

async function callOpenRouter(prompt: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001", 
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
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

async function getGoogleAccessToken() {
  const { data } = await supabase.from('config').select('value').eq('key', 'google_refresh_token').single();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: JSON.stringify({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: data?.value, grant_type: 'refresh_token' }),
  });
  const json = await res.json();
  return json.access_token;
}

// (Funções createGoogleEvent e updateGoogleEvent mantidas conforme versões testadas anteriormente)
async function createGoogleEvent(summary: string, startTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    let startIso = startTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    const startDate = new Date(startIso);
    const event = {
      summary,
      start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(startDate.getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] }
    };
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? `Agendado: ${summary}` : "Falha Google.";
  } catch { return "Erro."; }
}

async function updateGoogleEvent(searchTerm: string, newSummary: string, newStartTime: string, reminderMinutes: number = 30) {
  try {
    const token = await getGoogleAccessToken();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(searchTerm)}&timeMin=${new Date().toISOString()}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const cal = await calRes.json();
    if (!cal.items?.length) return `Não achei "${searchTerm}".`;
    const startIso = newStartTime.trim().replace(' ', 'T').substring(0, 19) + '-03:00';
    const event = {
      summary: newSummary,
      start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(new Date(startIso).getTime() + 3600000).toISOString(), timeZone: 'America/Sao_Paulo' }
    };
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${cal.items[0].id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return res.ok ? `Corrigido: ${newSummary}` : "Falha Google.";
  } catch { return "Erro."; }
}
