// lib/chat/pipeline/extractors/l3.extractor.ts
// V2.0 — Zero-Waste: Consome masterContext, elimina consultas redundantes e previne race conditions.

import { supabase } from '@/lib/jarvis';

export async function updateL3(userId: string, masterContext: any): Promise<void> {
  try {
    if (!masterContext) {
      console.warn('[Pipeline/L3] masterContext ausente. Pulando extração.');
      return;
    }

    // 1. DADOS INJETADOS: Puxa projetos e eventos diretamente da memória do God RPC
    const proj = masterContext.projects || [];
    const evs = masterContext.events || [];

    // 2. DADOS ESTRITOS DO L3: Busca apenas o essencial que não está no God RPC
    const [profRes, kidsRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date').eq('parent_id', userId),
      supabase.from('users').select('current_context').eq('id', userId).single(),
    ]);

    const p = profRes.data;
    const kids = kidsRes.data || [];
    let ctx = userRes.data?.current_context || '';

    // 3. MONTAGEM DE PATCHES (Dados Pessoais Estáticos)
    const patches: Record<string, string> = {};
    if (p?.full_name) {
      patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    }
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;

    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => `${k.name}`).join(', ');
    }

    // Aplica os patches linha a linha
    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      const match = ctx.match(rx);
      if (match?.[1]?.trim() === val) continue;
      ctx = match ? ctx.replace(rx, `- ${key}: ${val}`) : `${ctx}\n- ${key}: ${val}`;
    }

    // 4. BLOCO DE PROJETOS (Sobrescreve com os dados do masterContext)
    if (proj.length > 0) {
      const block = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const sectionRegex = /## PROJETOS[\s\S]*?(?=\n##|$)/i;
      
      if (sectionRegex.test(ctx)) {
        ctx = ctx.replace(sectionRegex, `## PROJETOS\n${block}`);
      } else {
        ctx = `${ctx.trim()}\n\n## PROJETOS\n${block}`;
      }
    }

    // 5. BLOCO DE DATAS IMPORTANTES (Sobrescreve com os dados do masterContext)
    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block = highEvs.map((e: any) => `- ${e.title}: ${e.start_at || e.event_date}`).join('\n');
      const sectionRegex = /## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i;
      
      if (sectionRegex.test(ctx)) {
        ctx = ctx.replace(sectionRegex, `## DATAS IMPORTANTES\n${block}`);
      } else {
        ctx = `${ctx.trim()}\n\n## DATAS IMPORTANTES\n${block}`;
      }
    }

    // 6. ATUALIZAÇÃO NO BANCO
    await supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId);
    
  } catch (e) {
    console.error('[Pipeline/L3] Erro crítico no Extrator L3:', e);
  }
}