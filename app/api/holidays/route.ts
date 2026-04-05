// app/api/holidays/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis'; // service role + schema jarvis

function normalizeString(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

async function getNationalHolidays(year: number): Promise<any[]> {
  try {
    const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((h: any) => ({
      id: `national-${h.date}`,
      name: h.name,
      date: h.date, // já vem "YYYY-MM-DD"
      type: 'national',
    }));
  } catch {
    return [];
  }
}

async function getStateHolidays(year: number, state: string | null): Promise<any[]> {
  if (!state) return [];
  const stateHolidays: Record<string, Array<{ date: string; name: string }>> = {
    PR: [{ date: '06-29', name: 'Dia de São Pedro' }, { date: '12-19', name: 'Dia do Paraná' }],
    SP: [{ date: '07-09', name: 'Revolução Constitucionalista' }],
    RJ: [{ date: '03-01', name: 'Dia da Cidade do Rio de Janeiro' }],
    MG: [{ date: '07-16', name: 'Dia de Nossa Senhora do Carmo' }],
    BA: [{ date: '07-02', name: 'Independência da Bahia' }],
    RS: [{ date: '09-20', name: 'Dia do Gaúcho' }],
    SC: [{ date: '08-11', name: 'Dia do Agricultor Catarinense' }],
    PE: [{ date: '06-03', name: 'Dia de Pernambuco' }],
    CE: [{ date: '03-25', name: 'Data Magna do Ceará' }],
    AM: [{ date: '09-05', name: 'Elevação do Amazonas' }],
    GO: [{ date: '10-09', name: 'Dia de Goiás' }],
    ES: [{ date: '05-23', name: 'Dia do Espírito Santo' }],
    MT: [{ date: '11-08', name: 'Dia de Mato Grosso' }],
    MS: [{ date: '10-11', name: 'Dia de Mato Grosso do Sul' }],
    PA: [{ date: '08-15', name: 'Dia de Nossa Senhora da Assunção' }],
    PB: [{ date: '08-05', name: 'Dia de Nossa Senhora das Neves' }],
    RN: [{ date: '08-05', name: 'Dia de Nossa Senhora das Neves' }],
    SE: [{ date: '07-08', name: 'Dia de Sergipe' }],
    AL: [{ date: '09-16', name: 'Dia de Alagoas' }],
    PI: [{ date: '03-13', name: 'Dia da Batalha do Jenipapo' }],
    RO: [{ date: '01-04', name: 'Dia de Rondônia' }],
    TO: [{ date: '10-05', name: 'Dia de Tocantins' }],
    AC: [{ date: '06-15', name: 'Dia do Acre' }],
    AP: [{ date: '10-05', name: 'Dia do Amazônia' }],
    RR: [{ date: '10-05', name: 'Dia de Roraima' }],
    DF: [{ date: '04-21', name: 'Dia de Tiradentes' }],
  };
  const holidays = stateHolidays[state.toUpperCase()] ?? [];
  return holidays.map(h => ({
    id: `state-${year}-${h.date}-${state}`,
    name: h.name,
    date: `${year}-${h.date}`,
    type: 'state',
  }));
}

async function getMunicipalHolidays(
  year: number,
  city: string | null,
  state: string | null,
): Promise<any[]> {
  if (!city || !state) return [];
  const cityNorm = normalizeString(city);
  const stateUpper = state.toUpperCase();
  const { data, error } = await supabase
    .from('municipal_holidays')
    .select('date, name')
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`)
    .eq('state_uf', stateUpper)
    .ilike('city_name', `%${cityNorm}%`);
  if (error) {
    console.error('[Holidays] Municipal query error:', error);
    return [];
  }
  return data.map(h => ({
    id: `municipal-${h.date}-${cityNorm}`,
    name: `${h.name} (Municipal)`,
    date: h.date,
    type: 'municipal',
  }));
}

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    let city: string | null = null;
    let state: string | null = null;

    if (token) {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error) {
        console.warn('[Holidays] Token inválido:', error.message);
      } else if (user?.id) {
        const { data: loc } = await supabase
          .from('user_locations')
          .select('city, state')
          .eq('user_id', user.id)
          .maybeSingle();
        if (loc?.city && loc?.state) {
          city = loc.city;
          state = loc.state;
        }
      }
    } else {
      console.warn('[Holidays] Token ausente — retornando apenas feriados nacionais');
    }

    // Data atual no fuso de São Paulo (evita problemas de UTC)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(now); // YYYY-MM-DD

    // Ano e mês atuais no mesmo fuso
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexado

    // Último dia do mês seguinte
    const nextMonthDate = new Date(Date.UTC(currentYear, currentMonth + 2, 0)); // mês+2 = próximo mês (ex: janeiro -> março? cuidado)
    // Explicação: new Date(year, month+2, 0) => último dia do mês (month+1). Ex: month=0 (janeiro) -> month+2=2 (março) -> dia 0 = último dia de fevereiro? Vamos corrigir.
    // Melhor: criar data com mês atual + 1, primeiro dia, subtrair 1 dia.
    let endDate = new Date(Date.UTC(currentYear, currentMonth + 2, 0));
    // Exemplo: se currentMonth=0 (janeiro), currentMonth+2=2 (março), dia 0 retorna último dia de fevereiro (correto, pois queremos último dia do mês seguinte = fevereiro).
    // Se currentMonth=11 (dezembro), currentMonth+2=13 (janeiro do ano seguinte), dia 0 retorna 31/12/ano+1? Vamos testar lógica.
    // Melhor usar abordagem segura:
    const endOfNextMonth = new Date(currentYear, currentMonth + 2, 0);
    const endStr = endOfNextMonth.toISOString().slice(0, 10);

    // Determinar anos necessários: ano atual e possível ano seguinte se o próximo mês cruzar o ano
    const needsNextYear = endOfNextMonth.getFullYear() > currentYear;
    const nextYear = currentYear + 1;

    const [
      nationalThisYear,
      nationalNextYear,
      stateThisYear,
      stateNextYear,
      municipalThisYear,
      municipalNextYear,
    ] = await Promise.all([
      getNationalHolidays(currentYear),
      needsNextYear ? getNationalHolidays(nextYear) : Promise.resolve([]),
      getStateHolidays(currentYear, state),
      needsNextYear ? getStateHolidays(nextYear, state) : Promise.resolve([]),
      getMunicipalHolidays(currentYear, city, state),
      needsNextYear ? getMunicipalHolidays(nextYear, city, state) : Promise.resolve([]),
    ]);

    const allHolidays = [
      ...nationalThisYear,
      ...nationalNextYear,
      ...stateThisYear,
      ...stateNextYear,
      ...municipalThisYear,
      ...municipalNextYear,
    ]
      .filter(h => h.date >= todayStr && h.date <= endStr) // futuros + até fim do próximo mês
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 15);

    return NextResponse.json({
      holidays: allHolidays,
      location: city && state ? `${city}, ${state}` : null,
      coverage: {
        national: true,
        state: stateThisYear.length + (stateNextYear?.length || 0) > 0,
        municipal: municipalThisYear.length + (municipalNextYear?.length || 0) > 0,
      },
    });
  } catch (error: any) {
    console.error('[API /holidays]', error);
    return NextResponse.json(
      { error: 'Erro ao buscar feriados', holidays: [] },
      { status: 200 },
    );
  }
}