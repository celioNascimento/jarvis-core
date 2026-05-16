// app/api/projects/route.ts
// Motor V1.0.0 — Consome SSOT de Projetos

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { 
  coreListarProjetos, 
  coreCriarProjeto, 
  coreAtualizarProjeto, 
  coreDeletarProjeto 
} from '@/lib/services/projects.service';

async function getUserIdFromReq(req: NextRequest): Promise<number | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  const { data: profile } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single();
  return profile?.id || null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;

    const projects = await coreListarProjetos(userId, status);
    return NextResponse.json({ projects, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const payload = await req.json();
    if (!payload.tag) return NextResponse.json({ error: 'A tag é obrigatória' }, { status: 400 });

    const project = await coreCriarProjeto(userId, payload);
    return NextResponse.json({ project, ok: true }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const payload = await req.json();
    const { id, ...updates } = payload;
    
    if (!id) return NextResponse.json({ error: 'ID do projeto ausente' }, { status: 400 });

    await coreAtualizarProjeto(userId, id, updates);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID ausente' }, { status: 400 });

    await coreDeletarProjeto(userId, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}
