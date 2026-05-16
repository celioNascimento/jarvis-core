// app/api/shopping/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';
import { coreListarCompras, coreCriarCompra, coreAtualizarStatusCompra, coreDeletarCompra } from '@/lib/services/shopping.service';

// Helper local para obter o ID numérico (BigInt) consistente
async function getUserId(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const authUserId = await getUserFromToken(token); // UUID
  if (!authUserId) return null;
  const { data } = await supabase.from('users').select('id').eq('auth_user_id', authUserId).single();
  return data?.id || null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const [items, { data: metadata }] = await Promise.all([
      coreListarCompras(userId),
      supabase.from('shopping_list_metadata').select('*').eq('user_id', userId)
    ]);
    return NextResponse.json({ items, metadata, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const payload = await req.json();
    const item = await coreCriarCompra(userId, payload);
    return NextResponse.json({ item, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { id, done } = await req.json();
    await coreAtualizarStatusCompra(userId, id, done);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID ausente' }, { status: 400 });
    await coreDeletarCompra(userId, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}
