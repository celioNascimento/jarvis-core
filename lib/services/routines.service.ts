// lib/services/routines.service.ts
// V1.0.0 — Fonte Única da Verdade (SSOT) para Rotinas e Check-ins

import { supabase } from '@/lib/jarvis';

// ─── 1. ROTINAS ───────────────────────────────────────────────────────────────

export async function coreGetRoutines(userId: number) {
  const { data, error } = await supabase
    .from('routines')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function coreCreateRoutine(userId: number, payload: any) {
  const { anchor, action, period = 'anytime', goal_tag, linked_to_child } = payload;

  if (!anchor?.trim() || !action?.trim()) throw new Error('anchor e action são obrigatórios');
  if (!['morning', 'afternoon', 'evening', 'anytime'].includes(period)) throw new Error('period inválido');

  const { data: existing } = await supabase
    .from('routines')
    .select('sort_order')
    .eq('user_id', userId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from('routines')
    .insert({
      user_id: userId,
      anchor: anchor.trim(),
      action: action.trim(),
      period,
      goal_tag: goal_tag?.trim() || null,
      linked_to_child: linked_to_child ?? null,
      sort_order: nextOrder,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function coreUpdateRoutine(userId: number, routineId: string, payload: any) {
  const allowed = ['anchor', 'action', 'period', 'goal_tag', 'sort_order', 'is_active'];
  const updates: Record<string, any> = {};
  
  for (const key of allowed) {
    if (key in payload) updates[key] = payload[key];  
  }

  if (!Object.keys(updates).length) throw new Error('Nenhum campo para atualizar');

  const { data, error } = await supabase
    .from('routines')
    .update(updates)
    .eq('id', routineId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function coreDeleteRoutine(userId: number, routineId: string) {
  const { error } = await supabase
    .from('routines')
    .update({ is_active: false })
    .eq('id', routineId)
    .eq('user_id', userId);

  if (error) throw new Error(error.message);
  return true;
}

// ─── 2. CHECK-INS ─────────────────────────────────────────────────────────────

export async function coreGetCheckins(userId: number, date: string) {
  const { data, error } = await supabase
    .from('routine_checkins')
    .select('routine_id, status, note')
    .eq('user_id', userId)
    .eq('date', date);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function coreProcessCheckin(userId: number, payload: any) {
  const { routine_id, status, date, note } = payload;
  if (!routine_id) throw new Error('routine_id é obrigatório');

  const checkinDate = date ?? new Date().toISOString().split('T')[0];

  // Caso nulo, remove o check-in (Reset)
  if (status === null) {
    const { error } = await supabase
      .from('routine_checkins')
      .delete()
      .eq('routine_id', routine_id)
      .eq('user_id', userId)
      .eq('date', checkinDate);
    if (error) throw new Error(error.message);
    return { removed: true };
  }

  // Caso preenchido, valida e insere/atualiza
  if (!['done', 'skipped'].includes(status)) throw new Error('status inválido');

  const { data, error } = await supabase
    .from('routine_checkins')
    .upsert(
      { routine_id, user_id: userId, date: checkinDate, status, note: note ?? null },
      { onConflict: 'routine_id,user_id,date' },
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return { checkin: data };
}
