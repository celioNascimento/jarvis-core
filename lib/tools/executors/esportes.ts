// lib/tools/executors/esportes.ts
// V1.4.0 — Fallback web search dinâmico por liga + season fix

import { coreGetMatchesToday, coreGetLeagueTable, LIGAS_MAP } from '@/lib/services/sports.service';
import { searchWeb } from '@/lib/google';

// Nomes legíveis para usar nas queries de fallback
const LIGAS_LABEL: Record<string, string> = {
  'brasileirao_a':    'Brasileirão Série A',
  'brasileirao_b':    'Brasileirão Série B',
  'premier_league':   'Premier League',
  'champions_league': 'Champions League',
  'la_liga':          'La Liga',
  'serie_a_italiano': 'Serie A italiana',
};

function getDataHojeBR(): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
}

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const liga = p.liga_tag || 'brasileirao_a';
    const ligaLabel = LIGAS_LABEL[liga] || liga;
    const dataFormatada = getDataHojeBR();

    // 1. Tenta a API oficial
    const partidas = await coreGetMatchesToday(liga).catch((err) => {
      console.warn(`[ExecutorEsportes] API falhou para ${liga}:`, err.message);
      return [];
    });

    // 2. Fallback web search — query dinâmica pela liga solicitada
    if (!partidas.length) {
      console.debug(`[ExecutorEsportes] API sem registros para ${liga}. Acionando fallback web search...`);

      const query = `${ligaLabel} jogos hoje ${dataFormatada} placar resultados ao vivo`;
      const resumoWeb = await searchWeb(query).catch(() => null);

      if (resumoWeb) {
        return `[RESULTADOS VIA WEB — ${ligaLabel.toUpperCase()} — ${dataFormatada}]\n\n${resumoWeb}`;
      }

      return `Não encontrei nenhuma partida da ${ligaLabel} agendada para hoje (${dataFormatada}).`;
    }

    // 3. Retorno estruturado da API
    return partidas.map((match: any) => {
      const { fixture, teams, goals } = match;
      const shortStatus = fixture.status.short;

      let statusFormatado = '';
      if (shortStatus === 'NS') {
        const hora = new Date(fixture.date).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        });
        statusFormatado = `Não iniciado — às ${hora}`;
      } else if (['FT', 'AET', 'PEN'].includes(shortStatus)) {
        statusFormatado = 'Encerrado';
      } else if (shortStatus === 'HT') {
        statusFormatado = 'Intervalo';
      } else {
        statusFormatado = `Em andamento: ${fixture.status.elapsed}'`;
      }

      const placarCasa = goals.home ?? 0;
      const placarFora = goals.away ?? 0;

      return `⚽ [${match.league.name}] ${teams.home.name} ${placarCasa} x ${placarFora} ${teams.away.name} (${statusFormatado})`;
    }).join('\n');

  } catch (err: any) {
    console.error('[executeConsultarPlacarAoVivo] Erro fatal:', err.message);
    return `Erro ao processar dados de esporte: ${err.message}`;
  }
}

export async function executeConsultarTabela(p: any): Promise<string> {
  try {
    const liga = p.liga_tag;
    const ligaLabel = LIGAS_LABEL[liga] || liga;

    const tabela = await coreGetLeagueTable(liga);
    if (!tabela.length) return `Não consegui recuperar a classificação da ${ligaLabel}.`;

    let out = `📊 [CLASSIFICAÇÃO — ${ligaLabel.toUpperCase()}]\n`;
    tabela.forEach((pos: any) => {
      out += `${pos.rank}º ${pos.team.name} | Pts: ${pos.points} | J: ${pos.all.played} | V: ${pos.all.win} | SG: ${pos.goalsDiff}\n`;
    });

    return out;
  } catch (err: any) {
    return `Erro ao processar classificação: ${err.message}`;
  }
}
