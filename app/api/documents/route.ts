// app/api/documents/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }
    const token = authHeader.split(' ')[1];
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: () => cookieStore }
    );
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
    }

    // Buscar documentos do usuário
    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('id, label, expires_at, icon')
      .eq('user_id', user.id)
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