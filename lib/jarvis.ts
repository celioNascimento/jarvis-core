import { createClient } from '@supabase/supabase-js';
import { getGoogleContext } from './google';

// 1. CONEXÃO CENTRAL COM O BANCO (SCHEMA JARVIS)
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// 2. MOTOR DE IA (OpenRouter - Gemini 2.0 Flash)
export async function callOpenRouter(prompt: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "❌ Erro IA.";
  } catch (e) {
    console.error("Erro callOpenRouter:", e);
    return "❌ Erro na conexão com a IA.";
  }
}

// 3. MOTOR VETORIAL (Busca no HD / Longo Prazo)
export async function generateEmbedding(text: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text
      })
    });
    const json = await res.json();
    return json.data?.[0]?.embedding || null;
  } catch (e) {
    console.error("Erro generateEmbedding:", e);
    return null;
  }
}

// 4. MENSAGEIRO TELEGRAM
export async function sendTelegram(chatId: string | number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.error("Erro ao enviar Telegram", e);
  }
}

// 5. MOTOR DE CONSOLIDAÇÃO (RAM -> L3 -> HD)
export async function compactMemory(userId: string, authorName: string) {
  try {
    const { data: rawBrain } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('user_id', userId)
      .eq('category', 'info')
      .order('created_at', { ascending: true });

    if (!rawBrain || rawBrain.length < 20) return;

    const { data: userProfile } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .single();

    const oldContext = userProfile?.current_context || "Nenhum contexto prévio.";

    const brainText = rawBrain.map(m =>
      `${authorName}: ${m.content}\nJarvis: ${m.metadata?.ai_reply || ''}`
    ).join('\n\n');

    const prompt = `
      Você é o Gerente de Memória do Jarvis. Sua missão é manter o Dossiê do usuário atualizado.
      [DOSSIÊ ATUAL (L3)]: ${oldContext}
      [NOVAS INTERAÇÕES]: ${brainText}
      TAREFA: Integre as informações ao Dossiê, mantenha rigor técnico e foco nos projetos 'Procuro Quem Faça' e 'ExpertFrotas'. Retorne APENAS o novo Dossiê estruturado.
    `;

    const newContext = await callOpenRouter(prompt);
    const embedding = await generateEmbedding(newContext);

    if (embedding) {
      // Atualiza L3 (Dossiê)
      await supabase.from('users').update({ current_context: newContext }).eq('id', userId);
      // Alimenta HD (Memória Histórica)
      await supabase.from('memories').insert([{
        summary: newContext,
        embedding,
        user_id: userId,
        metadata: { type: 'auto_consolidation', count: rawBrain.length }
      }]);
      // Limpa RAM
      const lastProcessedDate = rawBrain[rawBrain.length - 1].created_at;
      await supabase.from('brain').delete().eq('user_id', userId).eq('category', 'info').lte('created_at', lastProcessedDate);
      console.log(`🧹 Memória de ${authorName} consolidada.`);
    }
  } catch (e) {
    console.error("Erro na compactação:", e);
  }
}

// 6. BUSCA EVENTOS PROATIVOS (Radares)
export async function getProactiveEvents(userId: string) {
  const hoje = new Date();
  const seteDiasDepois = new Date();
  seteDiasDepois.setDate(hoje.getDate() + 7);

  const { data: events } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .filter('last_notified_year', 'neq', hoje.getFullYear());

  if (!events) return [];

  return events.filter(event => {
    const d = new Date(event.event_date);
    const isHoje = d.getDate() === hoje.getDate() && d.getMonth() === hoje.getMonth();
    const isSeteDias = d.getDate() === seteDiasDepois.getDate() && d.getMonth() === seteDiasDepois.getMonth();
    return isHoje || isSeteDias;
  });
}

// 7. CHECAGEM DE INTERRUPTORES (Feriados/Comodidade)
export async function checkSystemInterrupts(userId: string) {
  try {
    const agenda = await getGoogleContext();
    const temFolga = agenda.toLowerCase().includes("feriado") || agenda.toLowerCase().includes("folga");

    return {
      shouldPauseMorningRoutine: temFolga,
      reason: temFolga ? "Feriado/Folga detectado" : null
    };
  } catch (e) {
    return { shouldPauseMorningRoutine: false, reason: null };
  }
}
export async function transcribeAudio(fileUrl: string) {
  try {
    const response = await fetch(fileUrl);
    const arrayBuffer = await response.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'audio/ogg' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-1');

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    const data = await res.json();
    return data.text || "";
  } catch (e) {
    console.error("Erro na transcrição:", e);
    return "";
  }
}