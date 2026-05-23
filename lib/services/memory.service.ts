// lib/services/memory.service.ts
// V2.0.0 — Responsabilidade única: compactação e reforço de memória HD
// generateEmbedding migrado para lib/memory/generate-embedding.ts

import { supabase, callOpenRouter } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';
import { generateEmbedding } from '@/lib/memory';

// ── Filtro de qualidade ───────────────────────────────────────────────────────

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

// ── COMPACTAÇÃO ───────────────────────────────────────────────────────────────

export async function compactMemory(userId: string, authorName: string): Promise<void> {
  try {
    const { data: rawBrain } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('user_id', userId)
      .neq('category', 'noise')
      .order('created_at', { ascending: true });

    if (!rawBrain || rawBrain.length < 20) return;

    const { data: userProfile } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .maybeSingle();

    const oldContext = userProfile?.current_context || 'Nenhum contexto prévio.';

    const SAUDACOES = [
      /^(olá|oi|e aí|fala|qual a boa|tudo bem|tudo bom|bom dia|boa tarde|boa noite|hey|opa|salve)[!?,. ]*/i,
      /^(ok|certo|entendido|perfeito|ótimo|show|vlw|valeu|obrigad)[!?,. ]*/i,
    ];
    const ehSaudacao = (texto: string) => SAUDACOES.some(r => r.test(texto.trim()));

    const entradasValidas = rawBrain.filter(m => {
      const reply = m.metadata?.ai_reply || '';
      if (ehSaudacao(m.content)) return false;
      return reply.trim().length > 20 && !MEMORIA_INVALIDA.some(p => reply.includes(p));
    });

    if (entradasValidas.length < 5) return;

    const brainText = entradasValidas
      .map(m =>
        `${authorName}: ${m.content}\nJarvis: ${(m.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`
      )
      .join('\n\n');

    const prompt = `Você é o Gerente de Memória do Lev. Mantenha o Dossiê do usuário ${authorName} atualizado.\n[DOSSIÊ ATUAL]:\n${oldContext}\n\n[NOVAS INTERAÇÕES]:\n${brainText}\nTAREFA: Integre as novas informações ao Dossiê. Retorne apenas o texto puro.`;

    const newContext = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.3);
    if (!memoriaEhValida(newContext)) return;

    // Gera embedding do novo dossiê via módulo centralizado
    const embedding = await generateEmbedding(newContext);
    if (!embedding) return;

    // Salva dossiê atualizado
    await supabase
      .from('users')
      .update({ current_context: newContext })
      .eq('id', userId);

    // Invalida persons — campo mais próximo que inclui dados de perfil
    await invalidateContextField(Number(userId), 'persons').catch(console.error);

    // Salva memória no HD
    await supabase.from('memories').insert([{
      summary:          newContext,
      embedding:        embedding,
      user_id:          userId,
      relevance_score:  1.0,
      access_count:     0,
      decay_lambda:     0.005,
      emotional_weight: 0.5,
      metadata: {
        type:  'auto_consolidation',
        count: entradasValidas.length,
      },
    }]);

    // Arquiva entradas já consolidadas
    const lastDate = entradasValidas[entradasValidas.length - 1].created_at;
    await supabase
      .from('brain')
      .delete()
      .eq('user_id', userId)
      .neq('category', 'noise')
      .lte('created_at', lastDate);

  } catch (e: any) {
    console.error('[Memory] Erro crítico na compactação:', e);
  }
}

// ── REFORÇO DE MEMÓRIA ────────────────────────────────────────────────────────

export async function reinforceMemory(memoryId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('memories')
      .select('access_count, relevance_score')
      .eq('id', memoryId)
      .maybeSingle();

    if (!data) return;

    await supabase
      .from('memories')
      .update({
        access_count:    (data.access_count || 0) + 1,
        relevance_score: Math.min((data.relevance_score || 0) + 0.05, 1.0),
        updated_at:      new Date().toISOString(),
      })
      .eq('id', memoryId);
  } catch (e) {
    console.error('[Memory] Erro reinforceMemory:', e);
  }
}

// ── UPDATE L3 ─────────────────────────────────────────────────────────────────

export async function updateL3(userId: string, masterContext?: any): Promise<void> {
  try {
    // Prioridade: masterContext injetado → sem queries
    // Fallback: busca mínima no banco
    const [p, kids] = masterContext
      ? [masterContext.profile, masterContext.children || []]
      : await Promise.all([
          supabase.from('user_profiles').select('full_name, preferred_name').eq('user_id', userId).maybeSingle().then(r => r.data),
          supabase.from('children').select('name').eq('parent_id', userId).then(r => r.data || []),
        ]);

    let ctx = masterContext?.dossier_summary
      || masterContext?.user?.current_context
      || '';

    const patches: Record<string, string> = {};

    if (p?.full_name) {
      patches['Nome'] = p.preferred_name
        ? `${p.full_name} (prefere: ${p.preferred_name})`
        : p.full_name;
    }
    if (kids?.length > 0) {
      patches['Filhos'] = kids.map((k: any) => k.name).join(', ');
    }

    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      ctx = rx.test(ctx)
        ? ctx.replace(rx, `- ${key}: ${val}`)
        : `${ctx}\n- ${key}: ${val}`;
    }

    await supabase
      .from('users')
      .update({ current_context: ctx.trim() })
      .eq('id', userId);

    // current_context vem em masterContext.user — recarregado no próximo RPC
    // Não precisa invalidar campo separado

    console.log(`[MemoryService] Contexto L3 consolidado para user ${userId}`);
  } catch (e) {
    console.error('[MemoryService/updateL3] Erro:', e);
    throw e;
  }
}