// app/api/calendar/events/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { verificarPermissaoEvento, coreAtualizarEvento, coreDeletarEventoPorId } from '@/lib/services/agenda.service';

async function getAuthContext(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  const { data: profile } = await supabase.schema('jarvis').from('users').select('id').eq('auth_user_id', data.user.id).single();
  return profile ? { userId: profile.id, authUserId: data.user.id } : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthContext(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { allowed, event } = await verificarPermissaoEvento(id, auth.userId);
  
  if (!allowed || !event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ event });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthContext(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id } = await params;
    const body = await req.json();
    const event = await coreAtualizarEvento(auth.userId, id, auth.authUserId, body);
    return NextResponse.json({ event });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthContext(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id } = await params;
    await coreDeletarEventoPorId(auth.userId, id);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    const status = e.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}
