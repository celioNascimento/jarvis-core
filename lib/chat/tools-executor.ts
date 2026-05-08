// lib/chat/tools-executor.ts
// Dispatcher V9.0.0 — Zero lógica inline
//
// Este arquivo APENAS roteia tool calls para o executor correto.
// Para adicionar uma nova tool:
//   1. Crie ou edite o executor no domínio correspondente em lib/tools/executors/
//   2. Adicione o case aqui (3 linhas)
//   3. Adicione a definição em tools-def.ts
//
// Nunca coloque lógica de negócio aqui.

import { supabase } from '@/lib/jarvis';

// ── Executores por domínio ────────────────────────────────────────────────────
import {
  executeBuscarMemoriaLonga,
  executeAdicionarDiretrizDinamica,
} from '@/lib/tools/executors/memory';

import {
  executeConsultarAgenda,
  executeSalvarEvento,
  executeCriarEventoAgenda,
  executeListarEmailsRecentes,
  executeExcluirEmail,
  executeCreateReminder,
  executeConsultarLembretes,
} from '@/lib/tools/executors/agenda';

import {
  executeRegistrarAbastecimento,
  executeRegistrarManutencao,
  executeAtualizarOdometro,
} from '@/lib/tools/executors/veiculos';

import {
  executeSalvarLugar,
  executeAdicionarItemLista,
  executeVerLista,
} from '@/lib/tools/executors/lugares';

import {
  executeGerenciarEisenhower,
  executeQuebrarTarefa,
  executeCriarRotina,
  executeRegistrarNoDiario,
  executeAtualizarMeta,
} from '@/lib/tools/executors/tdah';

import {
  executeRegistrarTransacao,
  executeConsultarFinancas,
  executeCriarOrcamento,
  executeListarOrcamentos,
} from '@/lib/finances/executor';

import { searchWeb, getWeatherForecast } from '@/lib/google';

// ── Idempotência ──────────────────────────────────────────────────────────────

async function checkIdempotency(
  numericUserId: string,
  name: string,
  callSignature: string
): Promise<boolean> {
  const key = `${numericUserId}_${name}_${callSignature}`;
  try {
    const { error } = await supabase
      .from('idempotency_keys')
      .insert({ key });
    if (error?.code === '23505') {
      console.warn(`[Idempotência] Bloqueado retry: ${name}`);
      return false; // já processado
    }
  } catch {
    // não trava a execução
  }
  return true; // pode executar
}

// ── Dispatcher principal ───────────────────────────────────────────────────────

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  if (!/^\d+$/.test(numericUserIdStr)) {
    return `Erro de identidade: userId inválido "${numericUserIdStr}"`;
  }

  const { name, arguments: rawArgs } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(rawArgs);
  } catch {
    return `Erro: argumentos inválidos para a ferramenta ${name}.`;
  }

  const sig = (toolCall.id || rawArgs).substring(0, 50);
  const canRun = await checkIdempotency(numericUserIdStr, name, sig);
  if (!canRun) return '[SISTEMA] Comando já processado com sucesso.';

  const args = [p, authUserId, numericUserIdStr] as const;

  switch (name) {
    // ── Memória ──────────────────────────────────────────────────────────────
    case 'buscar_memoria_longa':        return executeBuscarMemoriaLonga(...args);
    case 'adicionar_diretriz_dinamica': return executeAdicionarDiretrizDinamica(...args);

    // ── Agenda ───────────────────────────────────────────────────────────────
    case 'consultar_agenda':       return executeConsultarAgenda(...args);
    case 'salvar_evento':          return executeSalvarEvento(...args);
    case 'criar_evento_agenda':    return executeCriarEventoAgenda(...args);
    case 'listar_emails_recentes': return executeListarEmailsRecentes(...args);
    case 'excluir_email':          return executeExcluirEmail(...args);
    case 'create_reminder':        return executeCreateReminder(...args);
    case 'consultar_lembretes':    return executeConsultarLembretes(...args);

    // ── Veículos ─────────────────────────────────────────────────────────────
    case 'registrar_abastecimento': return executeRegistrarAbastecimento(...args);
    case 'registrar_manutencao':    return executeRegistrarManutencao(...args);
    case 'atualizar_odometro':      return executeAtualizarOdometro(...args);

    // ── Lugares e Compras ─────────────────────────────────────────────────────
    case 'salvar_lugar':         return executeSalvarLugar(...args);
    case 'adicionar_item_lista': return executeAdicionarItemLista(...args);
    case 'ver_lista':            return executeVerLista(...args);

    // ── TDAH e Diário ─────────────────────────────────────────────────────────
    case 'gerenciar_eisenhower': return executeGerenciarEisenhower(...args);
    case 'quebrar_tarefa':       return executeQuebrarTarefa(...args);
    case 'criar_rotina':         return executeCriarRotina(...args);
    case 'registrar_no_diario':  return executeRegistrarNoDiario(...args);
    case 'atualizar_meta':       return executeAtualizarMeta(...args);

    // ── Finanças (executor externo já existente) ───────────────────────────────
    case 'registrar_transacao': return executeRegistrarTransacao(p, authUserId, numericUserIdStr);
    case 'consultar_financas':  return executeConsultarFinancas(p, authUserId, numericUserIdStr);
    case 'criar_orcamento':     return executeCriarOrcamento(p, authUserId, numericUserIdStr);
    case 'listar_orcamentos':   return executeListarOrcamentos(authUserId, numericUserIdStr);

    // ── Web e Clima ───────────────────────────────────────────────────────────
    case 'searchWeb':          return searchWeb(p.query);
    case 'getWeatherForecast': return getWeatherForecast(p.lat, p.lng);

    default:
      return `Ferramenta "${name}" não reconhecida pelo dispatcher.`;
  }
}