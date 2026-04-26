// lib/finances/auth.ts
// Wrapper sobre lib/auth.ts para as rotas de finanças
// Retorna authUserId + jarvisUserId juntos

import { getUserFromToken } from '@/lib/auth';
import { supabase } from '@/lib/jarvis';

export interface ResolvedUser {
  authUserId: string;
  jarvisUserId: number;
  nickname?: string;
  assistantName?: string;
}

export async function resolveUser(req: Request): Promise<ResolvedUser | null> {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
    if (!token) return null;

    // Usa o helper já existente no projeto
    const jarvisUserId = await getUserFromToken(token);
    if (!jarvisUserId) return null;

    // Busca authUserId e dados extras
    const { data: userRecord } = await supabase
      .from('users')
      .select('auth_user_id, nickname, assistant_name')
      .eq('id', jarvisUserId)
      .maybeSingle();

    if (!userRecord?.auth_user_id) return null;

    return {
      authUserId:    userRecord.auth_user_id,
      jarvisUserId,
      nickname:      userRecord.nickname      || undefined,
      assistantName: userRecord.assistant_name || undefined,
    };
  } catch (e: any) {
    console.error('[resolveUser]', e.message);
    return null;
  }
}

