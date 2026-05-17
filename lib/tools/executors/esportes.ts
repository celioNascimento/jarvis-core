// lib/tools/executors/esportes.ts
// V1.3.0 — Executor de Esportes com Automação de Fallback Interno via Web Search (Anti-Robô)

import { coreGetMatchesToday, coreGetLeagueTable } from '@/lib/services/sports.service';
import { searchWeb } from '@/lib/google'; // Reaproveita a infraestrutura de busca global existente

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const liga = p.liga_tag || 'brasileirao_a';
    
    // 1. Tenta buscar os dados oficiais na API de Esportes
    const partidas = await coreGetMatchesToday(liga).catch(() => []);
    
    // 2. 🔥 FALLBACK AUTOMÁTICO: Se a API falhar ou vier vazia, o executor varre a Web imediatamente
    if (!partidas.length) {
      console.debug(`[ExecutorEsportes] API vazia para hoje. Disparando Fallback Web Search interno...`);
      
      const termoBusca = `jogos do campeonato brasileiro serie a hoje placar resultados ao vivo campeonato brasileiro`;
      const resumoWeb = await searchWeb(termoBusca).catch(() => null);
      
      if (resumoWeb) {
        return `[RESULTADOS VIA BUSCA WEB - GOOGLE]
A API oficial está temporariamente sem registros para esta rodada, mas localizei estas informações atualizadas diretamente na internet:

${resumoWeb}`;
      }
      
      return `Não encontrei nenhuma partida agendada ou acontecendo para o Brasileirão hoje, nem mesmo via busca externa de contingência.`;
    }

    // 3. Se encontrar dados na API, segue o fluxo de formatação estruturado padrão
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
