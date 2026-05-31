// lib/services/sports.service.ts
// V1.3.0 — season obrigatório para Champions + outras ligas com calendário cross-year

const API_SPORTS_KEY = process.env.API_SPORTS_KEY!;
const BASE_URL = 'https://v3.football.api-sports.io';

const headers = {
  'x-rapidapi-host': 'v3.football.api-sports.io',
  'x-rapidapi-key': API_SPORTS_KEY,
};

export const LIGAS_MAP: Record<string, number> = {
  'brasileirao_a':    71,
  'brasileirao_b':    72,
  'premier_league':   39,
  'champions_league': 2,
  'la_liga':          140,
  'serie_a_italiano': 135,
};

// Ligas que cruzam o ano (ex: 2024/25) e precisam de season explícito no filtro por data.
// Sem season, a API retorna vazio mesmo com data válida.
const LIGAS_COM_SEASON: Set<string> = new Set([
  'champions_league',
  'premier_league',
  'la_liga',
  'serie_a_italiano',
]);

// Retorna o ano da temporada atual para ligas cross-year:
// Jan–Jun → temporada anterior (ex: em maio/2026 → 2025)
// Jul–Dez → temporada corrente (ex: em ago/2026 → 2026)
function resolveSeasonCrossYear(): number {
  const month = new Date().getMonth(); // 0-indexed
  return month < 6 ? new Date().getFullYear() - 1 : new Date().getFullYear();
}

// Retorna o ano corrente para ligas nacionais (Brasileirão, etc.)
function resolveSeasonNational(): number {
  return new Date().getFullYear();
}

export async function coreGetMatchesToday(ligaTag: string) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');

  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  const formatter = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dataStr = formatter.format(new Date());

  const isCrossYear = LIGAS_COM_SEASON.has(ligaTag);
  const season = isCrossYear ? resolveSeasonCrossYear() : resolveSeasonNational();

  const url = `${BASE_URL}/fixtures?league=${ligaId}&date=${dataStr}&season=${season}`;

  console.debug(`[SportsService] GET ${url}`);

  const res = await fetch(url, { headers, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`Erro na API de esportes: ${res.statusText}`);

  const data = await res.json();
  return data.response ?? [];
}

export async function coreGetLeagueTable(ligaTag: string) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');

  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  const isCrossYear = LIGAS_COM_SEASON.has(ligaTag);
  const season = isCrossYear ? resolveSeasonCrossYear() : resolveSeasonNational();

  const url = `${BASE_URL}/standings?league=${ligaId}&season=${season}`;

  const res = await fetch(url, { headers, next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Erro na API de classificação: ${res.statusText}`);

  const data = await res.json();
  return data.response?.[0]?.league?.standings?.[0] ?? [];
}
