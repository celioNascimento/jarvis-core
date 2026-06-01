// lib/tools/executors/esportes.ts
// V1.5.0 — Suporte a data específica (ontem) + busca por time sem liga

import {
  coreGetMatchesToday,
  coreGetMatchesByDate,
  coreGetMatchesByTeam,
  coreGetLeagueTable,
  LIGAS_MAP,
} from '@/lib/services/sports.service';
import { searchWeb } from '@/lib/google';

// ── Labels legíveis por liga ──────────────────────────────────────────────────

const LIGAS_LABEL: Record<string, string> = {
  'brasileirao_a':    'Brasileirão Série A',
  'brasileirao_b':    'Brasileirão Série B',
  'premier_league':   'Premier League',
  'champions_league': 'Champions League',
  'la_liga':          'La Liga',
  'serie_a_italiano': 'Serie A italiana',
};

// ── Helpers de data ───────────────────────────────────────────────────────────

function getDataHojeBR(): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
}

/**
 * Converte referências temporais relativas para um objeto Date.
 * Aceita: "hoje", "ontem", "anteontem" ou null (= hoje).
 */
function resolveDate(when?: string): Date {
  const now = new Date();
  if (!when || when === 'hoje') return now;
  if (when === 'ontem') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (when === 'anteontem') return new Date(now.getTime() - 48 * 60 * 60 * 1000);
  // Tenta parsear uma data literal (ex: "2026-05-30")
  const parsed = new Date(when);
  return isNaN(parsed.getTime()) ? now : parsed;
}

function formatDateLabel(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
}

// ── Formatação de partida ─────────────────────────────────────────────────────

function formatMatch(match: any): string {
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
}

// ── Executores ────────────────────────────────────────────────────────────────

export async function executeConsultarPlacarAoVivo(p: any): Promise<string> {
  try {
    const liga       = p.liga_tag || 'brasileirao_a';
    const ligaLabel  = LIGAS_LABEL[liga] || liga;
    const targetDate = resolveDate(p.quando);
    const dateLabel  = formatDateLabel(targetDate);
    const isToday    = !p.quando || p.quando === 'hoje';

    // 1. Tenta API oficial
    const partidas = await coreGetMatchesByDate(liga, targetDate).catch((err) => {
      console.warn(`[ExecutorEsportes] API falhou para ${liga}:`, err.message);
      return [];
    });

    // 2. Fallback web search com query dinâmica
    if (!partidas.length) {
      console.debug(`[ExecutorEsportes] API sem dados para ${liga} em ${dateLabel}. Fallback web...`);

      const query = `${ligaLabel} resultado jogo ${dateLabel}`;
      const webResult = await searchWeb(query).catch(() => null);

      if (webResult) {
        const label = isToday ? 'HOJE' : dateLabel;
        return `[RESULTADOS VIA WEB — ${ligaLabel.toUpperCase()} — ${label}]\n\n${webResult}`;
      }

      const quando = isToday ? 'hoje' : `em ${dateLabel}`;
      return `Não encontrei nenhuma partida da ${ligaLabel} ${quando}.`;
    }

    // 3. Retorno estruturado da API
    return partidas.map(formatMatch).join('\n');

  } catch (err: any) {
    console.error('[executeConsultarPlacarAoVivo] Erro fatal:', err.message);
    return `Erro ao processar dados de esporte: ${err.message}`;
  }
}

/**
 * Busca jogos de um time específico por nome, sem exigir liga.
 * Acionado quando o usuário diz "jogo do São Paulo ontem" sem especificar campeonato.
 */
export async function executeConsultarJogosPorTime(p: any): Promise<string> {
  try {
    const teamName   = p.time as string;
    const targetDate = resolveDate(p.quando);
    const dateLabel  = formatDateLabel(targetDate);
    const daysBack   = p.quando === 'anteontem' ? 2 : p.quando === 'ontem' ? 1 : 0;

    if (!teamName) return 'Nome do time não informado.';

    // 1. Tenta API oficial por time
    const { teamName: resolvedName, matches } = await coreGetMatchesByTeam(teamName, Math.max(daysBack, 1)).catch(() => ({
      teamId: null, teamName, matches: [],
    }));

    if (matches.length) {
      const out = matches.map(formatMatch).join('\n');
      return `[JOGOS — ${resolvedName.toUpperCase()} — ${dateLabel}]\n\n${out}`;
    }

    // 2. Fallback web search
    console.debug(`[ExecutorEsportes] API sem dados para ${teamName}. Fallback web...`);
    const query = `${teamName} resultado jogo ${dateLabel}`;
    const webResult = await searchWeb(query).catch(() => null);

    if (webResult) return `[RESULTADO VIA WEB — ${teamName.toUpperCase()} — ${dateLabel}]\n\n${webResult}`;

    return `Não encontrei jogos do ${teamName} em ${dateLabel}.`;

  } catch (err: any) {
    console.error('[executeConsultarJogosPorTime] Erro fatal:', err.message);
    return `Erro ao buscar jogos do time: ${err.message}`;
  }
}

export async function executeConsultarTabela(p: any): Promise<string> {
  try {
    const liga      = p.liga_tag;
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
