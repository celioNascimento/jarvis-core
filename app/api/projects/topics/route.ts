// app/api/projects/topics/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

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

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'Project ID ausente' }, { status: 400 });

  try {
    const { data, error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .select('*')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true });

    if (error) throw error;
    return NextResponse.json({ topics: data, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const payload = await req.json();
    const { project_id, tag, name, description } = payload;

    if (!project_id || !tag || !name) {
      return NextResponse.json({ error: 'Campos obrigatórios ausentes' }, { status: 400 });
    }

    const { data, error } = await supabase
      .schema('jarvis')
      .from('project_topics')
      .insert({ project_id, tag, name, description })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ topic: data, ok: true }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}