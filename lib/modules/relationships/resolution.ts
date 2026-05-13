// lib/modules/relationships/resolution.ts
import { supabase } from '@/lib/jarvis';

/**
 * HIERARQUIA DE NOMES (Padrão Único do Sistema)
 * Define como o nome de um usuário deve ser exibido em qualquer lugar.
 */
export function formatDisplayName(user: any): string {
  if (!user) return 'Usuário Desconhecido';
  return user.nickname || user.preferred_name || user.name || user.email || 'Membro';
}

/**
 * RESOLVEDOR DE USUÁRIO (Amplitude Máxima)
 * Busca um usuário por qualquer identificador possível.
 */
export async function resolveUser(identifier: string): Promise<any | null> {
  if (!identifier) return null;
  
  const query = supabase.from('users').select('id, auth_user_id, name, preferred_name, nickname, email, push_token');

  // Se for ID numérico (BigInt)
  if (/^\d+$/.test(identifier)) {
    const { data } = await query.eq('id', Number(identifier)).maybeSingle();
    return data;
  }

  // Se for UUID (Auth)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier)) {
    const { data } = await query.eq('auth_user_id', identifier).maybeSingle();
    return data;
  }

  // Busca por Texto (Email, Nome, Apelido) - A AMPLITUDE ESTÁ AQUI
  const { data } = await query
    .or(`email.ilike.%${identifier}%,name.ilike.%${identifier}%,preferred_name.ilike.%${identifier}%,nickname.ilike.%${identifier}%`)
    .limit(1)
    .maybeSingle();

  return data || null;
}

/**
 * RESOLVEDOR DE PROJETO
 * Busca o UUID de um projeto por Nome, Tag ou ID.
 */
export async function resolveProject(identifier: string, ownerId: string | number): Promise<any | null> {
  if (!identifier) return null;

  const query = supabase.from('projects').select('*').eq('user_id', Number(ownerId));

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier)) {
    const { data } = await query.eq('id', identifier).maybeSingle();
    return data;
  }

  const { data } = await query
    .or(`tag.eq.${identifier},name.ilike.%${identifier}%`)
    .limit(1)
    .maybeSingle();

  return data || null;
}