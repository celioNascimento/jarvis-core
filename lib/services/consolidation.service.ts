// lib/services/consolidation.service.ts
// V1.0.0 — Consolidação Diária de Memória via Claude

import { supabase } from '@/lib/jarvis';
import { MemoryManager } from '@/lib/memory';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_BRAIN_CHARS = 12000;
const MAX_DOSSIE_CHARS = 3000;

// ── Busca mensagens das últimas 24h ──────────────────────────────────────────

async function fetchTodayBrain(userId: number): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('brain')
    .select('content, metadata, created_at')
    .eq('user_id', userId)
    .neq('category', 'noise')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (!data?.length) return '';

  return data.map(row => {
    const user = row.content || '';
    const assistant = row.metadata?.ai_reply || '';
    return `Usuário: ${user}\nJarvis: ${assistant}`;
  }).join('\n\n').slice(0, MAX_BRAIN_CHARS);
}

// ── Busca dossiê atual ────────────────────────────────────────────────────────

async function fetchCurrentDossie(userId: number): Promise<string> {
  const { data } = await supabase
    .from('users')
    .select('current_context')
    .eq('id', userId)
    .single();

  return (data?.current_context || '').slice(0, MAX_DOSSIE_CHARS);
}

// ── Chama Claude para consolidar ─────────────────────────────────────────────

async function consolidateWithClaude(
  dossie: string,
  brain: string,
  userId: number
): Promise<string | null> {
  const prompt = dossie
    ? `Você é um sistema de memória. Abaixo está o dossiê atual do usuário e as conversas de hoje.\n\nDOSSIÊ ATUAL:\n${dossie}\n\nCONVERSAS DE HOJE:\n${brain}\n\nAtualize o dossiê incorporando fatos novos, decisões tomadas, mudanças de estado emocional ou comportamental, e projetos mencionados. Remova informações desatualizadas. Máximo 800 tokens. Retorne apenas o dossiê atualizado, sem explicações.`
    : `Você é um sistema de memória. Abaixo estão as conversas de hoje com o usuário.\n\nCONVERSAS DE HOJE:\n${brain}\n\nCrie um dossiê inicial sobre este usuário com base nas conversas. Inclua: perfil, projetos, hábitos, estado emocional, fatos relevantes. Máximo 800 tokens. Retorne apenas o dossiê, sem explicações.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    console.error('[Consolidation] Claude error:', response.status);
    return null;
  }

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ── Processa um job da fila ───────────────────────────────────────────────────

async function processJob(jobId: string, userId: number): Promise<void> {
  await supabase
    .from('consolidation_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId);

  try {
    const [brain, dossie] = await Promise.all([
      fetchTodayBrain(userId),
      fetchCurrentDossie(userId),
    ]);

    if (!brain) {
      await supabase
        .from('consolidation_jobs')
        .update({ status: 'done', finished_at: new Date().toISOString() })
        .eq('id', jobId);
      return;
    }

    const newDossie = await consolidateWithClaude(dossie, brain, userId);

    if (newDossie) {
      await MemoryManager.write({
        type: 'l3_patch',
        userId,
        dossie: newDossie,
      });
    }

    await supabase
      .from('consolidation_jobs')
      .update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('id', jobId);

  } catch (error: any) {
    console.error(`[Consolidation] Erro no job ${jobId}:`, error);
    await supabase
      .from('consolidation_jobs')
      .update({ status: 'failed', error: error.message })
      .eq('id', jobId);
  }
}

// ── Entrypoint público — processa próximo job da fila ────────────────────────

export async function runNextConsolidationJob(): Promise<{
  processed: boolean;
  userId?: number;
  jobId?: string;
}> {
  const { data: job } = await supabase
    .from('consolidation_jobs')
    .select('id, user_id')
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true })
    .limit(1)
    .single();

  if (!job) return { processed: false };

  await processJob(job.id, job.user_id);
  return { processed: true, userId: job.user_id, jobId: job.id };
}
