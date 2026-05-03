import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { event_id, shared_with_id } = await req.json();

  if (!event_id || !shared_with_id) {
    return NextResponse.json({ error: 'Parâmetros ausentes (event_id, shared_with_id)' }, { status: 400 });
  }

  // 1. Rigor Técnico: Verificar se o usuário logado é o dono real do evento
  const { data: eventData, error: eventError } = await supabase
    .from('events')
    .select('user_id')
    .eq('id', event_id)
    .single();

  if (eventError || !eventData) {
    return NextResponse.json({ error: 'Evento não encontrado.' }, { status: 404 });
  }

  if (String(eventData.user_id) !== String(userId)) {
    return NextResponse.json({ error: 'Você não tem permissão para compartilhar este evento.' }, { status: 403 });
  }

  // 2. Inserir na tabela calendar_event_shares respeitando o schema
  const { error } = await supabase
    .from('calendar_event_shares')
    .insert({ 
      event_id, 
      shared_with_id 
    });

  if (error) {
    // 23505 = constraint unique_violation (usuário já possui acesso a este evento específico)
    if (error.code === '23505') {
      return NextResponse.json({ ok: true, message: 'Já compartilhado' });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const event_id = searchParams.get('event_id');
  const shared_with_id = searchParams.get('shared_with_id');

  if (!event_id || !shared_with_id) {
    return NextResponse.json({ error: 'Parâmetros ausentes' }, { status: 400 });
  }

  // 1. Validar se quem tenta remover é o dono do evento
  const { data: eventData } = await supabase
    .from('events')
    .select('user_id')
    .eq('id', event_id)
    .single();

  if (!eventData || String(eventData.user_id) !== String(userId)) {
    return NextResponse.json({ error: 'Sem permissão para remover compartilhamento.' }, { status: 403 });
  }

  const { error } = await supabase
    .from('calendar_event_shares')
    .delete()
    .eq('event_id', event_id)
    .eq('shared_with_id', shared_with_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const userId = await getUserFromToken(token);
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const event_id = searchParams.get('event_id');

  // Cenário A: Quero saber com quem EU compartilhei este evento específico
  if (event_id) {
    // Validação de segurança
    const { data: eventData } = await supabase
      .from('events')
      .select('user_id')
      .eq('id', event_id)
      .single();

    if (!eventData || String(eventData.user_id) !== String(userId)) {
      return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 });
    }

    const { data, error } = await supabase
      .from('calendar_event_shares')
      .select('shared_with_id')
      .eq('event_id', event_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, shares: data });
  }

  // Cenário B: Quero carregar no MEU calendário todos os eventos que os outros compartilharam COMIGO
  const { data, error } = await supabase
    .from('calendar_event_shares')
    .select('event_id')
    .eq('shared_with_id', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, shares: data });
}
