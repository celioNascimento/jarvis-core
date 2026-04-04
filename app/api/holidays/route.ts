// app/api/holidays/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUpcomingHolidays } from '@/lib/holidays'; // ← agora compartilhado

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return NextResponse.json({ error: 'Token inválido' }, { status: 401 });

    const holidays = await getUpcomingHolidays(10);
    return NextResponse.json({ holidays });
  } catch (error: any) {
    console.error('[API /holidays]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}