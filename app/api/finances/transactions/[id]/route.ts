// app/api/finances/transactions/[id]/route.ts
// PATCH — confirmar, ignorar ou marcar como duplicada

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { updateTransactionStatus } from '@/lib/finances/db';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
  const authClient = createSupabaseClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: { user } } = await authClient.auth.getUser(token);
  if (!user) return null;

  const { data: jarvisUser } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  return jarvisUser ? { authUserId: user.id, jarvisUserId: jarvisUser.id } : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> } // <-- Tipagem corrigida para Promise
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const resolvedParams = await params; // <-- Aguardando a Promise ser resolvida
    const id = parseInt(resolvedParams.id, 10);
    
    if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 });

    const body = await req.json();
    const status = body.status as 'confirmed' | 'ignored' | 'duplicate';
    if (!['confirmed', 'ignored', 'duplicate'].includes(status))
      return NextResponse.json({ error: 'Status inválido' }, { status: 400 });

    // Verifica propriedade
    const { data: tx } = await supabase
      .from('transactions')
      .select('jarvis_user_id')
      .eq('id', id)
      .maybeSingle();

    if (!tx || tx.jarvis_user_id !== user.jarvisUserId)
      return NextResponse.json({ error: 'Transação não encontrada' }, { status: 404 });

    await updateTransactionStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> } // <-- Tipagem corrigida para Promise
) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const resolvedParams = await params; // <-- Aguardando a Promise ser resolvida
    const id = parseInt(resolvedParams.id, 10);
    
    if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 });

    // Verifica propriedade antes de deletar
    const { data: tx } = await supabase
      .from('transactions')
      .select('jarvis_user_id')
      .eq('id', id)
      .maybeSingle();

    if (!tx || tx.jarvis_user_id !== user.jarvisUserId)
      return NextResponse.json({ error: 'Transação não encontrada' }, { status: 404 });

    const { error } = await supabase.from('transactions').delete().eq('id', id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}