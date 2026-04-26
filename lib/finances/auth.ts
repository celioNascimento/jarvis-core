// lib/finances/auth.ts
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
    const authHeader = req.headers.get('authorization');
    
    // LOG 1: Verificar se o header sequer existe
    if (!authHeader) {
      console.error('[resolveUser] Bloqueado: Header Authorization ausente.');
      return null;
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      console.error('[resolveUser] Bloqueado: Token vazio após replace.');
      return null;
    }

    // LOG 2: Verificar se a lib/auth consegue decodificar
    const jarvisUserId = await getUserFromToken(token);
    if (!jarvisUserId) {
      console.error('[resolveUser] Bloqueado: getUserFromToken retornou nulo. Token inválido ou Secret expirada.');
      return null;
    }

    // LOG 3: Verificar consulta ao banco
    const { data: userRecord, error: dbError } = await supabase
      .from('users')
      .select('auth_user_id, nickname, assistant_name')
      .eq('id', jarvisUserId)
      .maybeSingle();

    if (dbError) {
      console.error('[resolveUser] Erro de Banco:', dbError.message);
      return null;
    }

    if (!userRecord?.auth_user_id) {
      console.error(`[resolveUser] Bloqueado: jarvisUserId ${jarvisUserId} encontrado, mas sem auth_user_id vinculado.`);
      return null;
    }

    return {
      authUserId:    userRecord.auth_user_id,
      jarvisUserId,
      nickname:      userRecord.nickname      || undefined,
      assistantName: userRecord.assistant_name || undefined,
    };
  } catch (e: any) {
    console.error('[resolveUser] Erro Crítico Exceção:', e.message);
    return null;
  }
}
