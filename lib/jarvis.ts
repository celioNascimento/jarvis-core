// lib/jarvis.ts
// Motor Central — Conexões, IA, Vetores e Utilitários
// ✅ CORREÇÕES: LLM Centralizado, Tratamento de Descarte (Gatekeeper) e Erros 406 resolvidos

import { createClient } from '@supabase/supabase-js';
import { getGoogleContext } from './google';
import { Redis } from '@upstash/redis';
import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway'; // <--- IMPORT DO GATEKEEPER

// ============================================================
// 1. CONEXÃO CENTRAL COM O BANCO (SCHEMA JARVIS)
// ============================================================
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ============================================================
// 2. MOTOR DE IA (Encaminhado para o Gatekeeper)
// ============================================================
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Wrapper centralizado. 
 * Joga requisições internas para a fila de background (Prioridade 4).
 */
export async function callOpenRouter(
  input: string | ChatMessage[],
  model: string = "google/gemini-2.0-flash-001",
  temperature: number = 0.7,
  priority: 1 | 2 | 3 | 4 = 4 // Default para Background
): Promise<string> {
  const taskId = `jarvis_internal_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  
  // Tarefas prioritárias (1, 2) nunca caem. Tarefas de background (3, 4) são descartadas sob estresse (Load Shedding).
  const dropPolicy = (priority === 3 || priority === 4) ? 'if_full' : 'never';

  return callOpenRouterWithPriority(
    priority,
    dropPolicy,
    taskId,
    messages,
    [], // Sem tools para chamadas internas genéricas
    model,
    temperature
  );
}

// ============================================================
// 3. MOTOR VETORIAL (Embeddings via OpenRouter)
// ============================================================
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    console.log('[Embedding] Gerando para:', text.substring(0, 60) + (text.length > 60 ? '...' : ''));

    if (!process.env.OPENAI_API_KEY) {
      console.error('[Embedding] OPENAI_API_KEY NÃO DEFINIDA!');
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
        "X-Title": process.env.NEXT_PUBLIC_APP_NAME || 'Jarvis AI',
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
        dimensions: 1536,
      })
    });

    clearTimeout(timeout);

    console.log('[Embedding] HTTP Status:', res.status);

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Embedding] Erro HTTP:', res.status, errorText);
      return null;
    }

    const json = await res.json();

    if (!json.data?.[0]?.embedding) {
      console.error('[Embedding] Resposta inválida:', JSON.stringify(json).substring(0, 200));
      return null;
    }

    const embedding = json.data[0].embedding;
    console.log('[Embedding] Sucesso, dimensões:', embedding.length);
    return embedding;

  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.error('[Embedding] Timeout após 15s');
    } else {
      console.error('[Embedding] Exceção:', e?.message || e);
    }
    return null;
  }
}

// ============================================================
// 4. MENSAGEIRO TELEGRAM
// ============================================================
export async function sendTelegram(chatId: string | number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.error("[Telegram] Erro ao enviar:", e);
  }
}

// ============================================================
// 5. GERENCIADOR DE SESSÃO
// ============================================================
export async function getOrCreateSession(userId: string): Promise<string> {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .gte('last_active', fourHoursAgo)
      .order('last_active', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('sessions')
        .update({ last_active: new Date().toISOString() })
        .eq('id', existing.id);
      return existing.id;
    }

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
    console.error("[Session] Erro getOrCreateSession:", e);
    return 'default';
  }
}

// ============================================================
// 6. GERENCIADOR DE PERGUNTA PENDENTE
// ============================================================
export async function getPendingQuestion(userId: string): Promise<{ question: string | null; context: any }> {
  try {
    const { data } = await supabase
      .from('users')
      .select('pending_question, pending_context')
      .eq('id', userId)
      .maybeSingle();

    return {
      question: data?.pending_question || null,
      context: data?.pending_context || null
    };
  } catch {
    return { question: null, context: null };
  }
}

export async function setPendingQuestion(userId: string, question: string | null, context: any = null): Promise<void> {
  try {
    await supabase
      .from('users')
      .update({
        pending_question: question,
        pending_context: context
      })
      .eq('id', userId);
  } catch (e) {
    console.error("[PendingQuestion] Erro setPendingQuestion:", e);
  }
}

export async function clearPendingQuestion(userId: string): Promise<void> {
  await setPendingQuestion(userId, null, null);
}

// ============================================================
// 7. MOTOR DE CONSOLIDAÇÃO (RAM → L3 → HD)
// ============================================================
const MEMORIA_INVALIDA = [
  'Framework de 4 Etapas',
  'Como posso te ajudar a ser mais produtivo',
  'Olá! 👋',
  'Plano de Ação:',
  'Próximos Passos:',
];

function memoriaEhValida(texto: string): boolean {
  if (MEMORIA_INVALIDA.some(p => texto.includes(p))) return false;
  if (texto.trim().length < 100) return false;
  const linhas = texto.split('\n').filter(l => l.trim().length > 20);
  const unicas = new Set(linhas);
  if (linhas.length > 5 && unicas.size / linhas.length < 0.6) return false;
  return true;
}

export async function compactMemory(userId: string, authorName: string): Promise<void> {
  try {
    const { data: rawBrain } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('user_id', userId)
      .neq('category', 'noise')
      .order('created_at', { ascending: true });

    if (!rawBrain || rawBrain.length < 20) {
      console.log(`[Memory] Insuficiente para compactar: ${rawBrain?.length || 0} entradas`);
      return;
    }

    const { data: userProfile } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .maybeSingle();

    const oldContext = userProfile?.current_context || "Nenhum contexto prévio.";

    const SAUDACOES = [
      /^(olá|oi|e aí|fala|qual a boa|tudo bem|tudo bom|bom dia|boa tarde|boa noite|hey|opa|salve)[!?,. ]*/i,
      /^(ok|certo|entendido|perfeito|ótimo|show|vlw|valeu|obrigad)[!?,. ]*/i,
    ];

    const ehSaudacao = (texto: string) =>
      SAUDACOES.some(r => r.test(texto.trim()));

    const entradasValidas = rawBrain.filter(m => {
      const reply = m.metadata?.ai_reply || '';
      if (ehSaudacao(m.content)) return false;
      if (reply.trim().length > 20 && !MEMORIA_INVALIDA.some(p => reply.includes(p))) return true;
      return false;
    });

    if (entradasValidas.length < 5) {
      console.log(`[Memory] Entradas válidas insuficientes (${entradasValidas.length}) — compactação cancelada`);
      return;
    }

    const brainText = entradasValidas.map(m =>
      `${authorName}: ${m.content}\nJarvis: ${(m.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`
    ).join('\n\n');

    const prompt = `
Você é o Gerente de Memória do Lev. Mantenha o Dossiê do usuário ${authorName} atualizado.

[DOSSIÊ ATUAL]:
${oldContext}

[NOVAS INTERAÇÕES]:
${brainText}

TAREFA: Integre as novas informações ao Dossiê existente.
- Preserve TODOS os dados anteriores relevantes
- Adicione novas informações, decisões, preferências e fatos detectados
- Marque compromissos com datas quando houver
- Seja denso e informativo — este texto alimenta a memória de longo prazo
- Retorne APENAS o Dossiê atualizado em português, sem comentários, sem markdown excessivo
    `.trim();

    // Prioridade 4 + if_full: Se o tráfego estiver ruim, ela será abortada pelo Gateway.
    const newContext = await callOpenRouter(prompt, "google/gemini-2.0-flash-001", 0.3);

    if (!memoriaEhValida(newContext)) {
      console.error('[Memory] Compactação rejeitada — resumo inválido detectado');
      return;
    }

    const embedding = await generateEmbedding(newContext);

    if (embedding) {
      await supabase
        .from('users')
        .update({ current_context: newContext })
        .eq('id', userId);

      import('@/lib/chat/l3-chunks').then(({ indexL3Chunks }) => {
        indexL3Chunks(Number(userId), newContext).catch(e =>
          console.error('[L3Chunks] Reindexação pós-compactação falhou:', e)
        );
      });
      
      await supabase.from('memories').insert([{
        summary: newContext,
        embedding,
        user_id: userId,
        relevance_score: 1.0,
        access_count: 0,
        decay_lambda: 0.005,
        emotional_weight: 0.5,
        metadata: { type: 'auto_consolidation', count: entradasValidas.length }
      }]);

      const lastProcessedDate = entradasValidas[entradasValidas.length - 1].created_at;
      await supabase
        .from('brain')
        .delete()
        .eq('user_id', userId)
        .neq('category', 'noise')
        .lte('created_at', lastProcessedDate);

      console.log(`🧹 Memória de ${authorName} consolidada. ${entradasValidas.length} entradas → L3 + HD.`);
    }
  } catch (e: any) {
    if (e.message === 'GATEKEEPER_DROPPED_TASK') {
      // ✂️ TRATAMENTO DE DESCARTE
      // Como não excluímos as linhas do "brain", o sistema tentará compactar de novo depois!
      console.log(`[Memory/Gateway] ✂️ Compactação da RAM de ${authorName} adiada por alto tráfego. Tentaremos na próxima mensagem.`);
      return;
    }
    console.error("[Memory] Erro crítico na compactação:", e);
  }
}

// ============================================================
// 8. BUSCA EVENTOS PROATIVOS
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
// 9. CHECAGEM DE INTERRUPTORES
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
    console.error("[Interrupts] Erro:", e);
    return { shouldPauseMorningRoutine: false, reason: null };
  }
}

// ============================================================
// 10. REFORÇO DE MEMÓRIA
// ============================================================
export async function reinforceMemory(memoryId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('memories')
      .select('access_count, relevance_score')
      .eq('id', memoryId)
      .maybeSingle();

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
    console.error("[Memory] Erro reinforceMemory:", e);
  }
}
