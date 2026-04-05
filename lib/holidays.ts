// lib/holiday.ts
import { supabase } from '@/lib/jarvis';

// Cache em memória para feriados nacionais (evita chamadas repetidas à BrasilAPI)
const nationalHolidayCache = new Map<string, any[]>();

export interface Holiday {
  id: string;
  name: string;
  date: string;
}

/**
 * Busca feriados nacionais de um ano específico na BrasilAPI
 */
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
    // Limpar cache após 1 dia
    setTimeout(() => nationalHolidayCache.delete(cacheKey), 86400000);
    return holidays;
  } catch (err) {
    console.error('[Holiday] Erro ao buscar feriados nacionais:', err);
    return [];
  }
}

/**
 * Verifica se uma data é feriado nacional
 * @param date Data a ser verificada
 * @returns boolean
 */
export async function isNationalHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const holidays = await fetchNationalHolidays(year);
  const dateStr = date.toISOString().slice(0, 10);
  return holidays.some(h => h.date === dateStr);
}

/**
 * Verifica se uma data é feriado municipal (baseado na tabela jarvis.municipal_holidays)
 * @param date Data a ser verificada
 * @param city Nome da cidade (ex: 'São Paulo')
 * @param state UF (ex: 'SP')
 * @returns boolean
 */
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

/**
 * Retorna os próximos N feriados nacionais a partir de hoje
 * @param limit Quantidade máxima de feriados
 * @returns Lista de feriados
 */
export async function getUpcomingHolidays(limit = 10): Promise<Holiday[]> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const currentYear = today.getFullYear();

  const [thisYear, nextYear] = await Promise.all([
    fetchNationalHolidays(currentYear),
    fetchNationalHolidays(currentYear + 1),
  ]);

  return [...thisYear, ...nextYear]
    .filter(h => h.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}