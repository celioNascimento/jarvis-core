// lib/tools/executors/esportes.ts
// V1.0.0 — Executor de Esportes integrado à SSOT

import { coreGetLiveMatches, coreGetLeagueTable } from '@/lib/services/sports.service';

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const partidas = await coreGetLiveMatches(p.liga_tag);
    if (!partidas.length) return 'Não há partidas acontecendo ao vivo no momento para este filtro.';

    return partidas.map((match: any) => {
      const { fixture, teams, goals } = match;
      const status = fixture.status.short === 'HT' ? 'Intervalo' : `${fixture.status.elapsed}'`;
      return `⚽ [${match.league.name}] ${teams.home.name} ${goals.home} x ${goals.away} ${teams.away.name} (${status})`;
    }).join('\n');

  } catch (err: any) {
    return `Erro ao buscar placares: ${err.message}`;
  }
}

export async function executeConsultarTabela(p: any): Promise<string> {
  try {
    const tabela = await coreGetLeagueTable(p.liga_tag);
    if (!tabela.length) return 'Não consegui recuperar a classificação desse campeonato.';

    let out = `📊 [CLASSIFICAÇÃO - ${p.liga_tag.toUpperCase()}]\n`;
    tabela.forEach((pos: any) => {
      out += `${pos.rank}º ${pos.team.name} | Pts: ${pos.points} | J: ${pos.all.played} | V: ${pos.all.win} | SG: ${pos.goalsDiff}\n`;
    });

    return out;
  } catch (err: any) {
    return `Erro ao processar classificação: ${err.message}`;
  }
}
