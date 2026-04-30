// lib/holidays.ts
import { supabase } from '@/lib/jarvis';

const nationalHolidayCache = new Map<string, any[]>();

export interface Holiday {
  id: string;
  name: string;
  date: string;
}

async function fetchNationalHolidays(year: number): Promise<Holiday[]> {
  const cacheKey = `national_${year}`;
  if (nationalHolidayCache.has(cacheKey)) {
    return nationalHolidayCache.get(cacheKey)!;
  }

  try {
    const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const holidays = data.map((h: any) => ({
      id: h.date,
      name: h.name,
      date: h.date,
    }));
    nationalHolidayCache.set(cacheKey, holidays);
    setTimeout(() => nationalHolidayCache.delete(cacheKey), 86400000);
    return holidays;
  } catch (err) {
    console.error('[Holiday] Erro ao buscar feriados nacionais:', err);
    return [];
  }
}

export async function isNationalHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const holidays = await fetchNationalHolidays(year);
  const dateStr = date.toISOString().slice(0, 10);
  return holidays.some(h => h.date === dateStr);
}

export async function isMunicipalHoliday(date: Date, city: string, state: string): Promise<boolean> {
  const dateStr = date.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('municipal_holidays')
    .select('id')
    .eq('city_name', city)
    .eq('state_uf', state)
    .eq('date', dateStr)
    .maybeSingle();

  if (error) {
    console.error('[Holiday] Erro ao buscar feriado municipal:', error);
    return false;
  }
  return !!data;
}

export async function getUpcomingHolidays(
  limit = 10,
  city?: string,
  state?: string
): Promise<Holiday[]> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const currentYear = today.getFullYear();

  const [thisYear, nextYear] = await Promise.all([
    fetchNationalHolidays(currentYear),
    fetchNationalHolidays(currentYear + 1),
  ]);

  const national = [...thisYear, ...nextYear].filter(h => h.date >= todayStr);

  let municipal: Holiday[] = [];
  if (city && state) {
    const { data, error } = await supabase
      .from('municipal_holidays')
      .select('id, name, date')
      .eq('city_name', city)
      .eq('state_uf', state)
      .gte('date', todayStr)
      .order('date', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[Holiday] Erro ao buscar feriados municipais:', error);
    } else {
      municipal = (data || []).map(h => ({
        id: h.id,
        name: `${h.name} (municipal)`,
        date: h.date,
      }));
    }
  }

  return [...national, ...municipal]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((h, i, arr) => arr.findIndex(x => x.date === h.date && x.name === h.name) === i)
    .slice(0, limit);
}

export async function isBusinessDay(date: Date, city?: string, state?: string): Promise<boolean> {
  const dayOfWeek = date.getDay();
  
  // 0 = Domingo, 6 = Sábado
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  // Verifica se é feriado nacional
  const isNatHoliday = await isNationalHoliday(date);
  if (isNatHoliday) {
    return false;
  }

  // Verifica feriado municipal (se cidade/estado forem fornecidos)
  if (city && state) {
    const isMunHoliday = await isMunicipalHoliday(date, city, state);
    if (isMunHoliday) {
      return false;
    }
  }

  return true;
}
