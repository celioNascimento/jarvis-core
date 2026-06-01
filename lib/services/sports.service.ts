// lib/services/sports.service.ts
// V1.4.0 — Adiciona coreGetMatchesByDate para consultas de ontem/data específica

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
const LIGAS_COM_SEASON: Set<string> = new Set([
  'champions_league',
  'premier_league',
  'la_liga',
  'serie_a_italiano',
]);

function resolveSeasonCrossYear(): number {
  const month = new Date().getMonth();
  return month < 6 ? new Date().getFullYear() - 1 : new Date().getFullYear();
}

function resolveSeasonNational(): number {
  return new Date().getFullYear();
}

// Formata uma data JS para YYYY-MM-DD no fuso de Brasília
function formatDateBR(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// ── Hoje ──────────────────────────────────────────────────────────────────────

export async function coreGetMatchesToday(ligaTag: string) {
  return coreGetMatchesByDate(ligaTag, new Date());
}

// ── Data específica (ontem, anteontem, etc.) ──────────────────────────────────
//
// Aceita um objeto Date — o executor converte "ontem", "anteontem" etc. antes de chamar.

export async function coreGetMatchesByDate(ligaTag: string, date: Date) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');

  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  const dataStr = formatDateBR(date);
  const isCrossYear = LIGAS_COM_SEASON.has(ligaTag);
  const season = isCrossYear ? resolveSeasonCrossYear() : resolveSeasonNational();

  const url = `${BASE_URL}/fixtures?league=${ligaId}&date=${dataStr}&season=${season}`;
  console.debug(`[SportsService] GET ${url}`);

  const res = await fetch(url, { headers, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`Erro na API de esportes: ${res.statusText}`);

  const data = await res.json();
  return data.response ?? [];
}

// ── Busca por time (sem filtro de liga) ───────────────────────────────────────
//
// Útil para "jogo do São Paulo ontem" quando o usuário não especifica a liga.
// Busca por nome do time nos últimos N dias.

export async function coreGetMatchesByTeam(teamName: string, daysBack: number = 1) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');

  // 1. Resolve o ID do time pelo nome
  const searchUrl = `${BASE_URL}/teams?search=${encodeURIComponent(teamName)}&country=Brazil`;
  const searchRes = await fetch(searchUrl, { headers });
  if (!searchRes.ok) throw new Error(`Erro ao buscar time: ${searchRes.statusText}`);

  const searchData = await searchRes.json();
  const team = searchData.response?.[0]?.team;
  if (!team) return { teamId: null, matches: [], teamName };

  // 2. Busca jogos do time na janela de datas
  const dateTo   = formatDateBR(new Date());
  const dateFrom = formatDateBR(new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000));
  const season   = resolveSeasonNational();

  const fixturesUrl = `${BASE_URL}/fixtures?team=${team.id}&from=${dateFrom}&to=${dateTo}&season=${season}`;
  console.debug(`[SportsService] GET ${fixturesUrl}`);

  const fixturesRes = await fetch(fixturesUrl, { headers, next: { revalidate: 60 } });
  if (!fixturesRes.ok) throw new Error(`Erro ao buscar jogos do time: ${fixturesRes.statusText}`);

  const fixturesData = await fixturesRes.json();
  return {
    teamId: team.id,
    teamName: team.name,
    matches: fixturesData.response ?? [],
  };
}

// ── Tabela ────────────────────────────────────────────────────────────────────

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
