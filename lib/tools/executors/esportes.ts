// lib/tools/executors/esportes.ts
// V1.2.0 — Executor de Esportes com Redirecionamento Dinâmico de Fallback (Anti-Robô)

import { coreGetMatchesToday, coreGetLeagueTable } from '@/lib/services/sports.service';

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const liga = p.liga_tag || 'brasileirao_a';
    const partidas = await coreGetMatchesToday(liga);
    
    if (!partidas.length) {
      // 🔥 AGENT STEERING: O retorno da ferramenta força a IA a encadear a busca web em vez de encerrar a execução
      return `[AVISO DO SISTEMA]: Nenhuma partida agendada ou realizada para a liga "${liga}" na data de hoje.
      DIRETRIZ MANDATÓRIA: Não responda de forma vazia ou incompleta para o usuário. Como ele perguntou de um time específico, acione IMEDIATAMENTE a ferramenta de fallback 'web_pesquisar' agora mesmo para descobrir quando joga este time ou o resultado recente dele na internet, ou consulte a classificação com 'esportes_consultar_tabela'.`;
    }

    return partidas.map((match: any) => {
      const { fixture, teams, goals } = match;
      const shortStatus = fixture.status.short;
      
      let statusFormatado = '';
      if (shortStatus === 'NS') {
        const hora = new Date(fixture.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        statusFormatado = `Não Iniciado - às ${hora}`;
      } else if (['FT', 'AET', 'PEN'].includes(shortStatus)) {
        statusFormatado = 'Encerrado';
      } else if (shortStatus === 'HT') {
        statusFormatado = 'Intervalo';
      } else {
        statusFormatado = `Em Andamento: ${fixture.status.elapsed}'`;
      }

      const placarCasa = goals.home !== null ? goals.home : 0;
      const placarFora = goals.away !== null ? goals.away : 0;

      return `⚽ [${match.league.name}] ${teams.home.name} ${placarCasa} x ${placarFora} ${teams.away.name} (${statusFormatado})`;
    }).join('\n');

  } catch (err: any) {
    return `Erro ao buscar dados de jogos: ${err.message}`;
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
