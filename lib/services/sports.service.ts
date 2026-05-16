// lib/services/sports.service.ts
// V1.0.0 — Fonte Única da Verdade para Dados Esportivos (Futebol)

import { supabase } from '@/lib/jarvis';

const API_SPORTS_KEY = process.env.API_SPORTS_KEY!;
const BASE_URL = 'https://v3.football.api-sports.io';

const headers = {
  'x-rapidapi-host': 'v3.football.api-sports.io',
  'x-rapidapi-key': API_SPORTS_KEY,
};

// IDs Oficiais da API-Football para a Temporada Atual (2026)
export const LIGAS_MAP: Record<string, number> = {
  'brasileirao_a': 71,
  'brasileirao_b': 72,
  'premier_league': 39,
  'champions_league': 2,
  'la_liga': 140,
  'serie_a_italiano': 135
};

export async function coreGetLiveMatches(ligaTag?: string) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada nas variáveis de ambiente.');

  let url = `${BASE_URL}/fixtures?live=all`;
  
  if (ligaTag && LIGAS_MAP[ligaTag]) {
    url += `&league=${LIGAS_MAP[ligaTag]}`;
  }

  const res = await fetch(url, { headers, next: { revalidate: 30 } }); // Cache agressivo de 30s para tempo real
  if (!res.ok) throw new Error(`Erro na API de esportes: ${res.statusText}`);

  const data = await res.json();
  return data.response ?? [];
}

export async function coreGetLeagueTable(ligaTag: string, season: number = 2026) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');
  
  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  const url = `${BASE_URL}/standings?league=${ligaId}&season=${season}`;

  const res = await fetch(url, { headers, next: { revalidate: 3600 } }); // Cache de 1 hora para tabelas
  if (!res.ok) throw new Error(`Erro na API de classificação: ${res.statusText}`);

  const data = await res.json();
  return data.response?.[0]?.league?.standings?.[0] ?? [];
}
