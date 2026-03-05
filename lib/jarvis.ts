import { createClient } from '@supabase/supabase-js';
import { getGoogleContext } from './google';

// ============================================================
// 1. CONEXÃO CENTRAL COM O BANCO (SCHEMA JARVIS)
// ============================================================
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ============================================================
// 2. MOTOR DE IA (OpenRouter - Gemini 2.0 Flash)
// ============================================================
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function callOpenRouter(
  input: string | ChatMessage[],
  model: string = "google/gemini-2.0-flash-001"
) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    // Aceita string simples ou array estruturado de messages
    const messages: ChatMessage[] = typeof input === 'string'
      ? [{ role: 'user', content: input }]
      : input;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        temperature: 0.7,
        messages
      })
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.error) {
      console.error("OpenRouter erro:", JSON.stringify(data.error));
      return data.error.message || "❌ Erro IA.";
    }

    return data.choices?.[0]?.message?.content || "❌ Erro IA.";

  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.error("OpenRouter timeout após 8s");
      return "Timeout — tenta de novo em instantes.";
    }
    console.error("Erro callOpenRouter:", e);
    return "❌ Erro na conexão com a IA.";
  }
}

// ============================================================
// 3. MOTOR VETORIAL
// ============================================================
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

// ============================================================
// 4. MENSAGEIRO TELEGRAM
// ============================================================
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

// ============================================================
// 5. GERENCIADOR DE SESSÃO (L3 — Contexto da Conversa Atual)
// Resolve o problema de contexto perdido entre turnos
// ============================================================
export async function getOrCreateSession(userId: string): Promise<string> {
  try {
    // Busca sessão ativa criada nas últimas 4 horas
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .gte('last_active', fourHoursAgo)
      .order('last_active', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      // Atualiza timestamp da sessão ativa
      await supabase
        .from('sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('id', existing.id);
      return existing.id;
    }

    // Sem sessão ativa: encerra antigas e cria nova
    await supabase
      .from('sessions')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('is_active', true);

    const { data: newSession } = await supabase
      .from('sessions')
      .insert({ user_id: userId, is_active: true })
      .select('id')
      .single();

    return newSession?.id || 'default';
  } catch (e) {
    console.error("Erro getOrCreateSession:", e);
    return 'default';
  }
}

// ============================================================
// 6. GERENCIADOR DE PERGUNTA PENDENTE
// Resolve o "sim" perdido — a fila de intenções abertas
// ============================================================
export async function getPendingQuestion(userId: string): Promise<{ question: string | null; context: any }> {
  try {
    const { data } = await supabase
      .from('users')
      .select('pending_question, pending_context')
      .eq('id', userId)
      .single();

    return {
      question: data?.pending_question || null,
      context: data?.pending_context || null
    };
  } catch {
    return { question: null, context: null };
  }
}

export async function setPendingQuestion(userId: string, question: string | null, context: any = null) {
  try {
    await supabase
      .from('users')
      .update({
        pending_question: question,
        pending_context: context
      })
      .eq('id', userId);
  } catch (e) {
    console.error("Erro setPendingQuestion:", e);
  }
}

export async function clearPendingQuestion(userId: string) {
  await setPendingQuestion(userId, null, null);
}

// ============================================================
// 7. MOTOR DE CONSOLIDAÇÃO (RAM → L3 → HD) — CORRIGIDO
// Compacta a cada 5 mensagens (era 20 — muito lento)
// ============================================================
export async function compactMemory(userId: string, authorName: string) {
  try {
    // CORRIGIDO: filtra por user_id (coluna agora existe)
    const { data: rawBrain } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('user_id', userId)
      .neq('category', 'noise')
      .order('created_at', { ascending: true });

    // CORRIGIDO: threshold reduzido de 20 para 5
    if (!rawBrain || rawBrain.length < 5) return;

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
      Você é o Gerente de Memória do Jarvis. Mantenha o Dossiê do usuário ${authorName} atualizado.
      
      [DOSSIÊ ATUAL]:
      ${oldContext}
      
      [NOVAS INTERAÇÕES]:
      ${brainText}
      
      TAREFA: Integre as novas informações ao Dossiê existente.
      - Preserve TODOS os dados anteriores relevantes
      - Adicione novas informações, decisões e preferências detectadas
      - Marque compromissos com datas quando houver
      - Retorne APENAS o Dossiê atualizado, sem comentários
    `;

    const newContext = await callOpenRouter(prompt);
    const embedding = await generateEmbedding(newContext);

    if (embedding) {
      // Atualiza L3 (Dossiê no perfil do usuário)
      await supabase
        .from('users')
        .update({ current_context: newContext })
        .eq('id', userId);

      // Alimenta HD com peso emocional neutro (será ajustado pelo decay)
      await supabase.from('memories').insert([{
        summary: newContext,
        embedding,
        user_id: userId,
        relevance_score: 1.0,
        access_count: 0,
        decay_lambda: 0.005, // Dossiê decai lentamente
        emotional_weight: 0.5,
        metadata: { type: 'auto_consolidation', count: rawBrain.length }
      }]);

      // Limpa RAM processada
      const lastProcessedDate = rawBrain[rawBrain.length - 1].created_at;
      await supabase
        .from('brain')
        .delete()
        .eq('user_id', userId)
        .neq('category', 'noise')
        .lte('created_at', lastProcessedDate);

      console.log(`🧹 Memória de ${authorName} consolidada. ${rawBrain.length} entradas → L3 atualizado.`);
    }
  } catch (e) {
    console.error("Erro na compactação:", e);
  }
}

// ============================================================
// 8. BUSCA EVENTOS PROATIVOS (Radares)
// ============================================================
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

// ============================================================
// 9. CHECAGEM DE INTERRUPTORES (Feriados/Comodidade)
// ============================================================
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

// ============================================================
// 10. REFORÇO DE MEMÓRIA (Aumenta relevância ao acessar)
// Chamado toda vez que uma memória HD é usada
// ============================================================
export async function reinforceMemory(memoryId: string) {
  try {
    const { data } = await supabase
      .from('memories')
      .select('access_count, relevance_score')
      .eq('id', memoryId)
      .single();

    if (!data) return;

    const newAccessCount = (data.access_count || 0) + 1;
    const newRelevance = Math.min((data.relevance_score || 0) + 0.05, 1.0);

    await supabase
      .from('memories')
      .update({
        access_count: newAccessCount,
        relevance_score: newRelevance,
        updated_at: new Date().toISOString()
      })
      .eq('id', memoryId);
  } catch (e) {
    console.error("Erro reinforceMemory:", e);
  }
        }

                                         }
