// lib/chat/pipeline/extractors/l3.extractor.ts
// V3.0 — Rigor Técnico: Dirty Check implementado. 
// Otimização de I/O: Só persiste no banco se houver derivação real do estado.

import { supabase } from '@/lib/jarvis';

export async function updateL3(userId: string, masterContext: any): Promise<void> {
  try {
    if (!masterContext) {
      console.warn('[L3.Extractor] masterContext ausente. Abortando.');
      return;
    }

    // 1. LEITURA ATÔMICA E PARALELA
    // Buscamos apenas o contexto atual (para Dirty Check) e dados de perfil (que não estão no God RPC)
    const [userRes, profRes, kidsRes] = await Promise.all([
      supabase.from('users').select('current_context').eq('id', userId).single(),
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date').eq('parent_id', userId),
    ]);

    const originalCtx = userRes.data?.current_context || '';
    let ctx = originalCtx;

    // 2. CONSTRUÇÃO DO PATCH (Dados Pessoais)
    const p = profRes.data;
    const kids = kidsRes.data || [];
    const patches: Record<string, string> = {};

    if (p?.full_name) {
      patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    }
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (kids.length > 0) patches['Filhos'] = kids.map((k: any) => `${k.name}`).join(', ');

    // Aplicação de Patches
    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      if (rx.test(ctx)) {
        ctx = ctx.replace(rx, `- ${key}: ${val}`);
      } else {
        ctx = `${ctx.trim()}\n- ${key}: ${val}`;
      }
    }

    // 3. BLOCO DE PROJETOS (MasterContext Source)
    const proj = masterContext.projects || [];
    const projBlock = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
    const projSection = `## PROJETOS\n${projBlock}`;
    
    if (/## PROJETOS/i.test(ctx)) {
      ctx = ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, projSection);
    } else {
      ctx = `${ctx.trim()}\n\n${projSection}`;
    }

    // 4. BLOCO DE DATAS IMPORTANTES (MasterContext Source)
    const evs = masterContext.events || [];
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    
    if (highEvs.length > 0) {
      const dateBlock = highEvs.map((e: any) => `- ${e.title}: ${e.start_at || e.event_date}`).join('\n');
      const dateSection = `## DATAS IMPORTANTES\n${dateBlock}`;
      
      if (/## DATAS IMPORTANTES/i.test(ctx)) {
        ctx = ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, dateSection);
      } else {
        ctx = `${ctx.trim()}\n\n${dateSection}`;
      }
    }

    // 5. DIRTY CHECK (O segredo da latência zero)
    if (ctx.trim() === originalCtx.trim()) {
      console.log('[L3.Extractor] Nenhuma alteração detectada. Skip commit.');
      return;
    }

    // 6. COMMIT
    await supabase
      .from('users')
      .update({ current_context: ctx.trim() })
      .eq('id', userId);
      
    console.log('[L3.Extractor] Dossiê persistido com sucesso.');

  } catch (e) {
    console.error('[L3.Extractor] Erro crítico:', e);
  }
}
