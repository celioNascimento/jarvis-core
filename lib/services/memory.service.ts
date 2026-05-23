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
      summary: newContext,
      embedding: embedding,
      user_id: userId,
      relevance_score: 1.0,
      access_count: 0,
      decay_lambda: 0.005,
      emotional_weight: 0.5,
      metadata: {
        type: 'auto_consolidation',
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
        access_count: (data.access_count || 0) + 1,
        relevance_score: Math.min((data.relevance_score || 0) + 0.05, 1.0),
        updated_at: new Date().toISOString(),
      })
      .eq('id', memoryId);
  } catch (e) {
    console.error('[Memory] Erro reinforceMemory:', e);
  }
}

// ── UPDATE L3 ─────────────────────────────────────────────────────────────────

export async function updateL3(userId: string, masterContext: any): Promise<void> {
  try {
    if (!masterContext) {
      console.warn('[L3.Extractor] masterContext ausente. Abortando.');
      return;
    }

    const originalCtx = masterContext.user?.current_context || '';
    const p = masterContext.profile;
    const kids = masterContext.children || [];
    const proj = masterContext.projects || [];
    const evs = masterContext.events || [];

    let ctx = originalCtx;

    // Patches de dados pessoais
    const patches: Record<string, string> = {};
    if (p?.full_name) patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (kids.length > 0) patches['Filhos'] = kids.map((k: any) => k.name).join(', ');

    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      ctx = rx.test(ctx)
        ? ctx.replace(rx, `- ${key}: ${val}`)
        : `${ctx.trim()}\n- ${key}: ${val}`;
    }

    // Bloco de projetos
    if (proj.length > 0) {
      const projBlock = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const projSection = `## PROJETOS\n${projBlock}`;
      ctx = /## PROJETOS/i.test(ctx)
        ? ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, projSection)
        : `${ctx.trim()}\n\n${projSection}`;
    }

    // Bloco de datas importantes
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const dateBlock = highEvs.map((e: any) => `- ${e.title}: ${e.start_at || e.event_date}`).join('\n');
      const dateSection = `## DATAS IMPORTANTES\n${dateBlock}`;
      ctx = /## DATAS IMPORTANTES/i.test(ctx)
        ? ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, dateSection)
        : `${ctx.trim()}\n\n${dateSection}`;
    }

    // Dirty check
    if (ctx.trim() === originalCtx.trim()) return;

    await supabase
      .from('users')
      .update({ current_context: ctx.trim() })
      .eq('id', userId);

    console.log('[L3.Extractor] Dossiê persistido.');

  } catch (e) {
    console.error('[L3.Extractor] Erro crítico:', e);
  }
}



