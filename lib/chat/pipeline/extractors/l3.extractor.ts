// lib/chat/pipeline/extractors/l3.extractor.ts
// V4.0 — Contrato de Rigor: Zero I/O parasita.
// Os dados necessários chegam via masterContext, garantindo latência zero.

export async function updateL3(userId: string, masterContext: any): Promise<void> {
  try {
    if (!masterContext) {
      console.warn('[L3.Extractor] masterContext ausente. Abortando.');
      return;
    }

    // 1. DADOS DE ENTRADA (Extraídos diretamente do masterContext)
    // O masterContext DEVE conter as chaves: user, profile, children, projects, events
    const originalCtx = masterContext.user?.current_context || '';
    const p = masterContext.profile;
    const kids = masterContext.children || [];
    const proj = masterContext.projects || [];
    const evs = masterContext.events || [];

    let ctx = originalCtx;

    // 2. CONSTRUÇÃO DO PATCH (Dados Pessoais)
    const patches: Record<string, string> = {};

    if (p?.full_name) {
      patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    }
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    if (kids.length > 0) patches['Filhos'] = kids.map((k: any) => `${k.name}`).join(', ');

    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      if (rx.test(ctx)) {
        ctx = ctx.replace(rx, `- ${key}: ${val}`);
      } else {
        ctx = `${ctx.trim()}\n- ${key}: ${val}`;
      }
    }

    // 3. BLOCO DE PROJETOS
    const projBlock = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
    const projSection = `## PROJETOS\n${projBlock}`;
    
    if (/## PROJETOS/i.test(ctx)) {
      ctx = ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, projSection);
    } else {
      ctx = `${ctx.trim()}\n\n${projSection}`;
    }

    // 4. BLOCO DE DATAS IMPORTANTES
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

    // 5. DIRTY CHECK & COMMIT
    if (ctx.trim() === originalCtx.trim()) {
      return; // Skip commit
    }

    // Importante: Mantemos apenas esta única escrita necessária
    await import('@/lib/jarvis').then(({ supabase }) => 
      supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId)
    );
      
    console.log('[L3.Extractor] Dossiê persistido.');

  } catch (e) {
    console.error('[L3.Extractor] Erro crítico:', e);
  }
}
