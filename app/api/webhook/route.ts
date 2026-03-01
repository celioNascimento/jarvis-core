import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'jarvis' } });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messageText = body.message?.text || "";
    const chatId = body.message?.chat?.id;

    if (!messageText) return NextResponse.json({ ok: true });

    // --- 1. COMANDO: /IGNORE (Filtro de Ruído) ---
    if (messageText.startsWith('/ignore')) {
      const termToIgnore = messageText.replace('/ignore', '').trim().toLowerCase();
      if (!termToIgnore) {
        await sendTelegram(chatId, "⚠️ Celio, diga o que devo ignorar. Ex: `/ignore Shopee`.");
        return NextResponse.json({ ok: true });
      }
      
      await supabase.from('filters').upsert({ term: termToIgnore });
      await sendTelegram(chatId, `✅ Entendido. O termo "${termToIgnore}" será filtrado dos seus próximos resumos.`);
      return NextResponse.json({ ok: true });
    }

    // --- 2. LÓGICA DE COMANDO: /RESUMO ---
    if (messageText.startsWith('/resumo')) {
      const { data: logs } = await supabase
        .from('brain')
        .select('content, category, project_tag, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true });

      const googleContext = await getGoogleContext();
      
      const activityData = logs?.map(l => `[${l.project_tag && l.project_tag !== 'Jarvis_AI' ? l.project_tag : l.category}] ${l.content}`).join('\n') || "Sem notas locais hoje.";
      
      const summaryPrompt = `
      Você é o Jarvis. Resuma as últimas 24h para o Celio (Dev com TDAH).
      
      DADOS LOCAIS (Supabase):
      ${activityData}
      
      DADOS GOOGLE (Agenda/Gmail):
      ${googleContext}
      
      Estruture em: 1. Compromissos Urgentes, 2. Progresso Técnico e 3. Próximo Passo Sugerido.
      `;

      const aiSummary = await callOpenRouter(summaryPrompt); 
      await sendTelegram(chatId, `📊 *Resumo Consolidado (Stark System):*\n\n${aiSummary}`);
      return NextResponse.json({ ok: true });
    }

    // --- 3. MEMÓRIA DE CONTEXTO E RESPOSTA COMUM ---
    const { data: history } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('project_tag', 'Jarvis_AI')
      .order('created_at', { ascending: false })
      .limit(5);

    const memory = history?.reverse().map(h => `User: ${h.content}\nJarvis: ${h.metadata?.ai_reply}`).join('\n') || "";
    
    // --- LÓGICA DE SELEÇÃO DE MOTOR IA (Com Override Manual) ---
    let modelToUse = "google/gemini-2.0-flash-001";
    let engineName = "Gemini Flash";
    const textLower = messageText.toLowerCase();

    // Regras automáticas (Projetos/Bugs ativam o Claude)
    if (textLower.includes('code') || 
        textLower.includes('bug') || 
        textLower.includes('#pqf') || 
        textLower.includes('#expertfrotas')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5 Sonnet";
    }

    // Override manual (O usuário manda! Se tiver a tag, força a troca)
    if (textLower.includes('#claude')) {
      modelToUse = "anthropic/claude-3.5-sonnet";
      engineName = "Claude 3.5 Sonnet (Forçado)";
    } else if (textLower.includes('#gemini')) {
      modelToUse = "google/gemini-2.0-flash-001";
      engineName = "Gemini Flash (Forçado)";
    }

    let aiReply = await callOpenRouter(`Contexto recente:\n${memory}\n\nUsuário atual: ${messageText}`, modelToUse);

    // Adiciona feedback visual se NÃO for o Gemini padrão E se não tiver ativado o fallback de erro
    if (modelToUse !== "google/gemini-2.0-flash-001" && !aiReply.includes("⚠️ Fallback")) {
      aiReply += `\n\n*(Motor: ${engineName})*`;
    }

    // EXTRATOR DE TAG INTELIGENTE (#tag) - Ignora as tags de sistema de IA
    let extractedTag = 'Jarvis_AI';
    const cleanMessage = messageText.replace(/#claude/ig, '').replace(/#gemini/ig, '');
    const tagMatch = cleanMessage.match(/#(\w+)/i);
    if (tagMatch) extractedTag = tagMatch[1];

    // Persistência no Cérebro (Supabase)
    await supabase.from('brain').insert([{
      content: messageText,
      category: tagMatch ? 'Contexto' : 'Nota',
      project_tag: extractedTag,
      metadata: { ai_reply: aiReply }
    }]);

    await sendTelegram(chatId, aiReply);
    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error("Erro Jarvis:", error.message);
    return NextResponse.json({ ok: true }); 
  }
}

// --- FUNÇÕES DE INTEGRAÇÃO GOOGLE ---
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

// --- FUNÇÕES AUXILIARES (Com Fallback Blindado) ---
async function callOpenRouter(prompt: string, model: string = "google/gemini-2.0-flash-001") {
  const defaultModel = "google/gemini-2.0-flash-001";

  // Função interna para fazer a requisição de IA
  const fetchAI = async (modelName: string) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        "model": modelName, 
        "messages": [
          { 
            "role": "system", 
            "content": "Você é o Jarvis. Assistente de produtividade para um dev com TDAH. DIRETRIZ CRÍTICA: Nunca responda apenas com perguntas ou confirmações vazias. Sempre confirme explicitamente que a informação foi SALVA no seu cérebro. Se o usuário não deu horário para uma tarefa, diga: 'Entendido, Celio. Registrei [Tarefa]. Quando tiver os horários, me avise para eu agendar o alerta'. Use o Framework de 4 Etapas: Capturar, Processar, Agendar e Executar." 
          },
          { "role": "user", "content": prompt }
        ]
      })
    });
    return await res.json();
  };

  let data = await fetchAI(model);

  // SE DEU ERRO (Ex: Falta de crédito, limite de API) E não era o Gemini...
  if (data.error && model !== defaultModel) {
    console.warn(`[JARVIS FALLBACK] Falha no modelo ${model}. Acionando ${defaultModel}...`);
    // Faz o Fallback (Retenta com o Gemini Flash)
    data = await fetchAI(defaultModel);
    
    if (!data.error && data.choices) {
      return data.choices[0].message.content + "\n\n*(⚠️ Fallback de Emergência: O Claude falhou/sem saldo. O Gemini atendeu seu pedido para não te deixar na mão.)*";
    }
  }

  // Se deu certo de primeira, ou após o fallback
  if (!data.error && data.choices) {
    return data.choices[0].message.content;
  }

  // Se tudo falhar (inclusive o Gemini)
  return "❌ Erro Crítico: Nenhum motor de IA pôde responder. Verifique seus créditos ou status da API OpenRouter.";
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