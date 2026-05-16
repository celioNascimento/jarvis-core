// app/api/reminders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { 
  coreListarLembretes, 
  coreCriarLembrete, 
  coreAtualizarLembrete, 
  coreDeletarLembrete 
} from '@/lib/services/reminders.service';

async function getJarvisUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { error: 'Não autorizado', status: 401 };

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return { error: 'Token inválido', status: 401 };

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, auth_user_id')
    .eq('auth_user_id', authData.user.id)
    .single();

  if (profileError || !profile) return { error: 'Perfil não encontrado', status: 404 };
  return { user: profile, authUser: authData.user };
}

export async function GET(req: NextRequest) {
  const { user, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const reminders = await coreListarLembretes(user!.id);
    return NextResponse.json({ ok: true, reminders });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const body = await req.json();
    if (!body.title) return NextResponse.json({ error: 'Título obrigatório' }, { status: 400 });

    const reminder = await coreCriarLembrete(user!.id, authUser!.id, body);
    return NextResponse.json({ ok: true, reminder }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { user, authUser, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const { id, ...updateData } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 });

    const reminder = await coreAtualizarLembrete(user!.id, authUser!.id, id, updateData);
    return NextResponse.json({ ok: true, reminder });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const { user, error, status } = await getJarvisUser(req);
  if (error) return NextResponse.json({ error }, { status });

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 });

    await coreDeletarLembrete(user!.id, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const httpStatus = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status: httpStatus });
  }
}