// app/api/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { decrypt } from '@/lib/crypto-utils';

const PAGE_SIZE = 15;

function safeDecrypt(value: string): string {
  if (!value) return value;
  const parts = value.split(':');
  if (parts.length !== 3) return value;
  const [iv, authTag, ciphertext] = parts;
  // IV = 12 bytes = 24 hex | authTag = 16 bytes = 32 hex
  if (iv.length !== 24 || authTag.length !== 32 || ciphertext.length === 0) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId    = searchParams.get('userId');
    const sessionId = searchParams.get('sessionId') || null;
    const page      = parseInt(searchParams.get('page') || '0');

    if (!userId) {
      return NextResponse.json({ error: 'userId obrigatório' }, { status: 400 });
    }

    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const email = authData?.user?.email;
    if (!email) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

    const { data: userProfile } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (!userProfile) return NextResponse.json({ error: 'Perfil não encontrado' }, { status: 404 });

    const userId_ = String(userProfile.id);
    const from = page * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;

    let query = supabase
      .from('brain')
      .select('id, content, metadata, created_at, is_encrypted', { count: 'exact' })
      .eq('user_id', userId_)
      .neq('category', 'archived')
      .order('created_at', { ascending: false })
      .range(from, to);

    let resolvedSessionId: string | null = sessionId;

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    } else {
      const { data: lastSession } = await supabase
        .from('brain')
        .select('session_id')
        .eq('user_id', userId_)
        .neq('category', 'archived')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lastSession?.session_id) {
        return NextResponse.json({ messages: [], hasMore: false, total: 0, resolvedSessionId: null });
      }

      resolvedSessionId = lastSession.session_id;
      query = query.eq('session_id', resolvedSessionId);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[history] Erro:', error);
      return NextResponse.json({ error: 'Erro ao buscar histórico' }, { status: 500 });
    }

    // Descriptografa content e metadata.ai_reply antes de entregar ao app
    const messages = (data || []).reverse().map((row) => {
      const content = row.is_encrypted ? safeDecrypt(row.content) : row.content;

      let metadata = row.metadata;
      if (metadata?.ai_reply) {
        metadata = {
          ...metadata,
          ai_reply: safeDecrypt(metadata.ai_reply),
        };
      }

      return { ...row, content, metadata };
    });

    const hasMore = (count || 0) > (page + 1) * PAGE_SIZE;

    return NextResponse.json({ messages, hasMore, total: count, resolvedSessionId });

  } catch (e: any) {
    console.error('[history] Erro:', e.message);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}