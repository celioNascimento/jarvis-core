// lib/services/session.service.ts
import { supabase } from '@/lib/jarvis';

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
