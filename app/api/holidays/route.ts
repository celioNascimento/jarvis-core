// app/api/holidays/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Função para buscar feriados do BrasilAPI
async function getBrazilianHolidays(year: number) {
  const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((h: any) => ({
    id: h.date,
    name: h.name,
    date: h.date,
  }));
}

export async function GET(req: NextRequest) {
  try {
    // Autenticação (mesmo padrão do endpoint de clima)
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }
    const token = authHeader.split(' ')[1];
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: () => cookieStore }
    );
    const { error: userError } = await supabase.auth.getUser(token);
    if (userError) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
    }

    // Buscar feriados do ano atual e próximo ano
    const today = new Date();
    const currentYear = today.getFullYear();
    const nextYear = currentYear + 1;

    const [holidaysThisYear, holidaysNextYear] = await Promise.all([
      getBrazilianHolidays(currentYear),
      getBrazilianHolidays(nextYear),
    ]);
    const allHolidays = [...holidaysThisYear, ...holidaysNextYear];

    // Filtrar apenas os que ainda não passaram (ou estão hoje)
    const todayStr = today.toISOString().slice(0, 10);
    const upcoming = allHolidays
      .filter(h => h.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 10); // próximos 10 feriados

    return NextResponse.json({ holidays: upcoming });
  } catch (error: any) {
    console.error('[API /holidays]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}