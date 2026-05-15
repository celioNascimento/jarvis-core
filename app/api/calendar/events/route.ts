// app/api/calendar/events/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreBuscarEventosApp, coreCriarEvento } from '@/lib/services/agenda.service';

async function getUserIdFromReq(req: NextRequest): Promise<number | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  const { data: profile } = await supabase.schema('jarvis').from('users').select('id').eq('auth_user_id', data.user.id).single();
  return profile?.id || null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const from = searchParams.get('from') ?? new Date().toISOString().split('T')[0];
    const to = searchParams.get('to') ?? null;

    const events = await coreBuscarEventosApp(userId, from, to);
    return NextResponse.json({ ok: true, events });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromReq(req);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  try {
    const body = await req.json();
    if (!body.title || !body.start_at) return NextResponse.json({ error: 'title e start_at são obrigatórios' }, { status: 400 });

    const { evento } = await coreCriarEvento(userId, {
      titulo: body.title,
      data_hora_inicio: body.start_at,
      data_hora_fim: body.end_at,
      categoria: body.category,
      notas: body.description,
      minutos_lembrete: body.reminder_minutes,
      source: 'app'
    });

    return NextResponse.json({ ok: true, event: evento }, { status: 201 });
  } catch (e: any) {
    const status = e.message.includes('CONFLITO') ? 409 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}
