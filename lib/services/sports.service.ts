// lib/services/sports.service.ts
// V1.2.0 — Correção Definitiva de Fuso Horário (Intl) e Remoção de Redundância de Season

const API_SPORTS_KEY = process.env.API_SPORTS_KEY!;
const BASE_URL = 'https://v3.football.api-sports.io';

const headers = {
  'x-rapidapi-host': 'v3.football.api-sports.io',
  'x-rapidapi-key': API_SPORTS_KEY,
};

export const LIGAS_MAP: Record<string, number> = {
  'brasileirao_a': 71,
  'brasileirao_b': 72,
  'premier_league': 39,
  'champions_league': 2,
  'la_liga': 140,
  'serie_a_italiano': 135
};

export async function coreGetMatchesToday(ligaTag: string) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');
  
  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  // 🔥 CORREÇÃO DE FUSO: Usa Intl com padrão fr-CA para gerar um 'AAAA-MM-DD' exato no fuso de Brasília
  const formatter = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dataStr = formatter.format(new Date());

  // Remove o parâmetro &season para evitar conflitos de indexação junto com o filtro de data estável
  const url = `${BASE_URL}/fixtures?league=${ligaId}&date=${dataStr}`;

  const res = await fetch(url, { headers, next: { revalidate: 60 } }); 
  if (!res.ok) throw new Error(`Erro na API de esportes: ${res.statusText}`);

  const data = await res.json();
  return data.response ?? [];
}

export async function coreGetLeagueTable(ligaTag: string, season: number = 2026) {
  if (!API_SPORTS_KEY) throw new Error('Chave API_SPORTS_KEY não configurada.');
  
  const ligaId = LIGAS_MAP[ligaTag];
  if (!ligaId) throw new Error(`Liga "${ligaTag}" não mapeada no sistema.`);

  const url = `${BASE_URL}/standings?league=${ligaId}&season=${season}`;

  const res = await fetch(url, { headers, next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Erro na API de classificação: ${res.statusText}`);

  const data = await res.json();
  return data.response?.[0]?.league?.standings?.[0] ?? [];
}
