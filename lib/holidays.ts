// lib/holidays.ts
export interface Holiday {
  id: string;
  name: string;
  date: string;
}

async function fetchHolidaysFromBrasilAPI(year: number): Promise<Holiday[]> {
  const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((h: any) => ({ id: h.date, name: h.name, date: h.date }));
}

export async function getUpcomingHolidays(limit = 10): Promise<Holiday[]> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const currentYear = today.getFullYear();

  const [thisYear, nextYear] = await Promise.all([
    fetchHolidaysFromBrasilAPI(currentYear),
    fetchHolidaysFromBrasilAPI(currentYear + 1),
  ]);

  return [...thisYear, ...nextYear]
    .filter(h => h.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}