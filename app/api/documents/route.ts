// app/api/documents/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return NextResponse.json({ error: 'Token inválido' }, { status: 401 });

    // documents usa auth_user_id ou numeric? Cola o schema se não souber
    const { data: userRecord } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const numericUserId = userRecord ? String(userRecord.id) : user.id;

    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('id, label, expires_at, icon')
      .eq('user_id', numericUserId)
      .order('expires_at', { ascending: true });

    if (docsError) throw docsError;

    return NextResponse.json({
      documents: documents?.map(doc => ({
        id: doc.id,
        label: doc.label,
        expiresAt: doc.expires_at,
        icon: doc.icon || '📄',
      })) || [],
    });
  } catch (error: any) {
    console.error('[API /documents]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}