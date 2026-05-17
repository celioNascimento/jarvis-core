// lib/tools/executors/esportes.ts
// V1.3.1 — Fix de Contingência: Query de Busca Amarrada à Data Correta do Sistema

import { coreGetMatchesToday, coreGetLeagueTable } from '@/lib/services/sports.service';
import { searchWeb } from '@/lib/google';

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const liga = p.liga_tag || 'brasileirao_a';
    
    // 1. Tenta buscar os dados oficiais na API de Esportes
    const partidas = await coreGetMatchesToday(liga).catch(() => []);
    
    // 2. FALLBACK AUTOMÁTICO CRÍTICO
    if (!partidas.length) {
      console.debug(`[ExecutorEsportes] API sem registros. Disparando Fallback Web Search amarrado à data...`);
      
      // 🔥 CAPTURA DA DATA EXATA: Pega o dia de hoje no fuso BR (Ex: "16/05/2026")
      const formatterBR = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const dataFormatada = formatterBR.format(new Date());
      
      // Injeta a data exata na query para evitar que o Google traga rodadas passadas por SEO
      const termoBusca = `jogos brasileirao serie a ${dataFormatada} placar resultados rodada de hoje`;
      const resumoWeb = await searchWeb(termoBusca).catch(() => null);
      
      if (resumoWeb) {
        return `[RESULTADOS CONTINGÊNCIA - DATA: ${dataFormatada}]
A API oficial está atualizando, mas localizei estas informações em tempo real na internet para o dia de hoje:

${resumoWeb}`;
      }
      
      return `Não encontrei nenhuma partida agendada ou acontecendo para o Brasileirão na data de hoje (${dataFormatada}).`;
    }

    // 3. Retorno estruturado padrão caso a API tenha os dados
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
    console.error('[executeConsultarPlacarAoVivo] Erro fatal:', err.message);
    return `Erro ao processar dados de esporte: ${err.message}`;
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
