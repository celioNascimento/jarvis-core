// lib/services/sports.service.ts
// V1.0.0 — Fonte Única da Verdade para Dados Esportivos

const API_SPORTS_KEY = process.env.API_SPORTS_KEY!;
const BASE_URL = 'https://v3.football.api-sports.io';

const headers = {
  'x-rapidapi-host': 'v3.football.api-sports.io',
  'x-rapidapi-key': API_SPORTS_KEY,
};

// Mapeamento de IDs da API para o Brasileirão e principais ligas
export const LEAGUE_IDS = {
  brasileirao_a: 71,
  premier_league: 39,
  champions_league: 2,
};

export async function coreGetLiveMatches(leagueId?: number) {
  let url = `${BASE_URL}/fixtures?live=all`;
  if (leagueId) {
    url += `&league=${leagueId}`;
  }

  const res = await fetch(url, { headers, next: { revalidate: 60 } }); // Cache de 1 min
  if (!res.ok) throw new Error('Falha ao buscar placares ao vivo');
  
  const data = await res.json();
  return data.response ?? [];
}

export async function coreGetLeagueTable(leagueId: number, season: number = 2026) {
  const url = `${BASE_URL}/standings?league=${leagueId}&season=${season}`;
  
  const res = await fetch(url, { headers, next: { revalidate: 3600 } }); // Cache de 1 hora
  if (!res.ok) throw new Error('Falha ao buscar tabela do campeonato');
  
  const data = await res.json();
  return data.response?.[0]?.league?.standings?.[0] ?? [];
}
