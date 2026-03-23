// app/api/history/route.ts
// Retorna histórico de mensagens da sessão atual com paginação
// GET /api/history?userId=<auth_uuid>&sessionId=<id>&page=0

import { supabase } from '@/lib/jarvis';

const PAGE_SIZE = 15;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId    = searchParams.get('userId');
    const sessionId = searchParams.get('sessionId');
    const page      = parseInt(searchParams.get('page') || '0');

    if (!userId || !sessionId) {
      return Response.json({ error: 'userId e sessionId obrigatórios' }, { status: 400 });
    }

    // Resolve o bigint do jarvis.users via admin lookup do auth UUID
    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const email = authData?.user?.email;

    if (!email) {
      return Response.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    const { data: userProfile } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (!userProfile) {
      return Response.json({ error: 'Perfil não encontrado' }, { status: 404 });
    }

    const userId_ = String(userProfile.id);

    // Busca mensagens com paginação — mais recentes primeiro, depois inverte
    const from = page * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;

    const { data, error, count } = await supabase
      .from('brain')
      .select('id, content, metadata, created_at', { count: 'exact' })
      .eq('user_id', userId_)
      .eq('session_id', sessionId)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error('[history] Erro:', error);
      return Response.json({ error: 'Erro ao buscar histórico' }, { status: 500 });
    }

    // Retorna em ordem cronológica (mais antigo primeiro)
    const messages = (data || []).reverse();
    const hasMore  = (count || 0) > (page + 1) * PAGE_SIZE;

    return Response.json({ messages, hasMore, total: count });

  } catch (e: any) {
    console.error('[history] Erro:', e.message);
    return Response.json({ error: 'Erro interno' }, { status: 500 });
  }
}