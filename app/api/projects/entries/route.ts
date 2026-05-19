import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreListarEntriesDoProjeto, coreAtualizarStatusEntry } from '@/lib/services/projects.service';

// Helper de Autenticação (DRY)
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
  if (!projectId) return NextResponse.json({ error: 'ID do projeto ausente' }, { status: 400 });

  try {
    const entries = await coreListarEntriesDoProjeto(projectId);
    return NextResponse.json({ entries, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const payload = await req.json();
    const { id, status } = payload;
    
    if (!id || !status) {
      return NextResponse.json({ error: 'ID da tarefa e novo status são obrigatórios' }, { status: 400 });
    }

    await coreAtualizarStatusEntry(userId, id, status);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}