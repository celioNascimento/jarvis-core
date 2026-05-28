// lib/services/profile.service.ts
// Fonte única da verdade para jarvis.users e jarvis.user_profiles

import { supabase } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';

export interface UserProfileUpdate {
  // user_profiles
  full_name?: string;
  birth_date?: string;
  birth_city?: string;
  birth_state?: string;
  gender?: string;
  father_name?: string;
  mother_name?: string;
  siblings_count?: number;
  faith_profile?: string;
  faith_notes?: string;
  education_level?: string;
  schools?: string[];
  current_job?: string;
  company?: string;
  career_notes?: string;
  whatsapp?: string;
  city?: string;
  state?: string;
  personality_notes?: string;
  spouse_name?: string;
  spouse_user_id?: string;
  spouse_birthday?: string;
  spouse_phone?: string;
  profession?: string;
  job_start_date?: string;
  phone?: string;
}

export interface UserUpdate {
  // jarvis.users
  nickname?: string;
  preferred_name?: string;
  assistant_name?: string;
  timezone?: string;
  avatar_url?: string;
  notification_hour?: number;
  preferred_voice?: string;
}

// ─── 1. BUSCAR PERFIL COMPLETO ────────────────────────────────────────────────
export async function coreBuscarPerfil(userId: number): Promise<{
  user: any;
  profile: any;
}> {
  const [userRes, profileRes] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
  ]);

  if (userRes.error) throw new Error(`Falha ao buscar usuário: ${userRes.error.message}`);

  return {
    user: userRes.data,
    profile: profileRes.data ?? null,
  };
}

// ─── 2. ATUALIZAR USER (jarvis.users) ─────────────────────────────────────────
export async function coreAtualizarUser(
  userId: number,
  payload: UserUpdate
): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) throw new Error(`Falha ao atualizar usuário: ${error.message}`);
}

// ─── 3. ATUALIZAR PERFIL (jarvis.user_profiles) ───────────────────────────────
export async function coreAtualizarPerfil(
  userId: number,
  payload: UserProfileUpdate
): Promise<void> {
  const { error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: userId, ...payload, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (error) throw new Error(`Falha ao atualizar perfil: ${error.message}`);
}

// ─── 4. ATUALIZAR PERSONALITY_NOTES (append seguro) ──────────────────────────
export async function coreAppendPersonalityNotes(
  userId: number,
  novaLinha: string
): Promise<void> {
  const { data: prof } = await supabase
    .from('user_profiles')
    .select('personality_notes')
    .eq('user_id', userId)
    .maybeSingle();

  const old = prof?.personality_notes || '';
  if (old.includes(novaLinha)) return; // dedup

  const updated = old ? `${old} | ${novaLinha}` : novaLinha;

  await coreAtualizarPerfil(userId, { personality_notes: updated });
}

// ─── 5. ATUALIZAR BLOCO DE ROTINA (replace seguro) ───────────────────────────
export async function coreAtualizarRotina(
  userId: number,
  novoBloco: string
): Promise<void> {
  const { data: prof } = await supabase
    .from('user_profiles')
    .select('personality_notes')
    .eq('user_id', userId)
    .maybeSingle();

  const old = prof?.personality_notes || '';
  const updated = /\[ROTINA\]/i.test(old)
    ? old.replace(/\[ROTINA\][^\n]*/i, novoBloco)
    : old ? `${old}\n${novoBloco}` : novoBloco;

  await coreAtualizarPerfil(userId, { personality_notes: updated.trim() });
}

export const profileService = {
  // Chamado por: extractRotina
  async updateRoutine(userId: number, rotina: { despertar?: string; dormir?: string }) {
    const parts = [];
    if (rotina.despertar) parts.push(`Despertar: ${rotina.despertar}`);
    if (rotina.dormir) parts.push(`Dormir: ${rotina.dormir}`);

    if (parts.length > 0) {
      const bloco = `[ROTINA] ${parts.join(' | ')}`;
      await coreAtualizarRotina(userId, bloco);
      await invalidateContextField(userId, 'profile').catch(() => { });
    }
  },

  // Chamado por: extractPreferencia
  async addPreferences(userId: number, preferencias: Array<{ tipo: string; descricao: string }>) {
    const novasLinhas = preferencias.map(p => `[${p.tipo.toUpperCase()}] ${p.descricao}`);

    for (const linha of novasLinhas) {
      await coreAppendPersonalityNotes(userId, linha);
    }
    await invalidateContextField(userId, 'profile').catch(() => { });
  }
};