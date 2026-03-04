import { createClient } from '@supabase/supabase-js';

// 1. CONEXÃO COM O BANCO DE DADOS
export const supabase = createClient(
  process.env.SUPABASE_URL!, 
  process.env.SUPABASE_SERVICE_ROLE_KEY!, 
  { db: { schema: 'jarvis' } }
);

// 2. MOTOR DE IA PRINCIPAL (OpenRouter)
export async function callOpenRouter(prompt: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.0-flash-001", messages: [{ role: "user", content: prompt }] })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "❌ Erro IA.";
  } catch { return "❌ Erro na conexão com a IA."; }
}

// 3. MOTOR VETORIAL (Para o HD)
export async function generateEmbedding(text: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text })
    });
    const json = await res.json();
    return json.data?.[0]?.embedding || null;
  } catch { return null; }
}

// 4. MENSAGEIRO
export async function sendTelegram(chatId: string | number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error("Erro ao enviar Telegram", e); }
}

// 5. O FAXINEIRO (Compactação Automática)
// Note que passamos o authorName para ele resumir "A rotina do Celio" em vez de só "A rotina"
export async function compactMemory(userId: string, authorName: string) {
  try {
    const { data: messages } = await supabase.from('brain').select('content, metadata').eq('user_id', userId).eq('category', 'info').order('created_at', { ascending: true });
    if (!messages || messages.length < 20) return;

    const fullDialogue = messages.map(m => `${authorName}: ${m.content}\nJarvis: ${m.metadata?.ai_reply}`).join('\n\n');
    const prompt = `Gere um resumo denso, factual e técnico deste diálogo de ${authorName}, focando em horários, rotinas, preferências e decisões tomadas. Ignore conversas fiadas: \n\n${fullDialogue}`;
    
    const summary = await callOpenRouter(prompt);
    const embedding = await generateEmbedding(summary);

    if (embedding) {
      await supabase.from('memories').insert([{ summary, embedding, user_id: userId, metadata: { type: 'snapshot' } }]);
      await supabase.from('brain').delete().eq('user_id', userId).eq('category', 'info');
      console.log(`🧹 Memória compactada para ${authorName}.`);
    }
  } catch (e) { console.error("Erro compactação:", e); }
}
