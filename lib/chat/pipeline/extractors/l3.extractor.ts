// lib/chat/pipeline/extractors/l3.extractor.ts
import { supabase } from '@/lib/jarvis';

export async function updateL3(userId: string): Promise<void> {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    const { data: sharedWithMe } = await supabase.from('calendar_event_shares').select('event_id').eq('shared_with_id', userId);
    const sharedIds = sharedWithMe?.map(s => s.event_id) || [];
    
    const eventOrFilter = sharedIds.length > 0
      ? `user_id.eq.${userId},id.in.(${sharedIds.join(',')})`
      : `user_id.eq.${userId}`;

    const [profRes, kidsRes, projRes, evRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date').eq('parent_id', userId),
      supabase.from('projects').select('name, description, status').eq('user_id', userId).limit(10),
      supabase.from('events').select('title, start_at, emotional_weight').or(eventOrFilter).gte('start_at', today).order('start_at', { ascending: true }).limit(15),
      supabase.from('users').select('current_context').eq('id', userId).single(),
    ]);

    const p = profRes.data;
    const kids = kidsRes.data || [];
    const proj = projRes.data || [];
    const evs = evRes.data || [];
    let ctx = userRes.data?.current_context || '';

    const patches: Record<string, string> = {};
    if (p?.full_name) patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.spouse_name) patches['Cônjuge'] = `${p.spouse_name}${p.spouse_birthday ? ` (aniv: ${p.spouse_birthday})` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;

    if (kids.length > 0) {
      patches['Filhos'] = kids.map((k: any) => `${k.name}`).join(', ');
    }

    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      const match = ctx.match(rx);
      if (match?.[1]?.trim() === val) continue;
      ctx = match ? ctx.replace(rx, `- ${key}: ${val}`) : `${ctx}\n- ${key}: ${val}`;
    }

    if (proj.length > 0) {
      const block = proj.map((r: any) => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      ctx = ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, `## PROJETOS\n${block}`);
    }

    const highEvs = evs.filter((e: any) => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block = highEvs.map((e: any) => `- ${e.title}: ${e.start_at}`).join('\n');
      ctx = ctx.replace(/## DATAS IMPORTANTES\n[\s\S]*?(?=\n##|$)/i, `## DATAS IMPORTANTES\n${block}`);
    }

    await supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId);
  } catch (e) {
    console.error('[Pipeline/L3] Erro crítico:', e);
  }
}