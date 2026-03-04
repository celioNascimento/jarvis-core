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

// 4. MENSAGEIRO TELEGRAM
export async function sendTelegram(chatId: string | number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error("Erro ao enviar Telegram", e); }
}

// 5. O MOTOR DE CONSOLIDAÇÃO (A Mágica das 4 Camadas)
export async function compactMemory(userId: string, authorName: string) {
  try {
    // A. Busca a RAM (Últimas 20 mensagens úteis)
    const { data: messages } = await supabase
      .from('brain')
      .select('content, metadata')
      .eq('user_id', userId)
      .eq('category', 'info')
      .order('created_at', { ascending: true });

    if (!messages || messages.length < 20) return; // Só compacta se a RAM estiver cheia

    // B. Busca o Dossiê Atual (Camada L3) para não sobrescrever o passado
    const { data: userProfile } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .single();
      
    const oldContext = userProfile?.current_context || "Nenhum contexto prévio estabelecido.";
    const fullDialogue = messages.map(m => `${authorName}: ${m.content}\nJarvis: ${m.metadata?.ai_reply}`).join('\n\n');

    // C. Pede para a IA fundir o passado com o presente
    const prompt = `
      Você é o Gerente de Memória do Jarvis.
      
      [CONTEXTO ATUAL DE ${authorName}]:
      ${oldContext}

      [NOVAS INTERAÇÕES (RAM)]:
      ${fullDialogue}

      TAREFA: Atualize o "Contexto Atual" integrando as novas informações.
      - Mantenha o que ainda é válido do contexto antigo.
      - Adicione os novos fatos (horários, rotinas, projetos).
      - Remova o que foi explicitamente cancelado ou alterado.
      - Crie um texto denso, direto e em formato de dossiê técnico. Nada de saudações.
    `;
    
    const newContext = await callOpenRouter(prompt);
    const embedding = await generateEmbedding(newContext);

    if (embedding) {
      // D. Atualiza a Camada L3 (O Perfil do Usuário - Consulta super rápida)
      await supabase.from('users').update({ current_context: newContext }).eq('id', userId);

      // E. Salva na Camada HD (Histórico Vetorial para buscas profundas no futuro)
      await supabase.from('memories').insert([{ summary: newContext, embedding, user_id: userId, metadata: { type: 'snapshot' } }]);

      // F. Limpa a RAM (Libera espaço para a próxima conversa)
      await supabase.from('brain').delete().eq('user_id', userId).eq('category', 'info');
      
      console.log(`🧹 Memória de 4 Camadas consolidada com sucesso para ${authorName}.`);
    }
  } catch (e) { console.error("Erro na compactação:", e); }
}
