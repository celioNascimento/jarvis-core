// lib/chat/tools-executor.ts
// Dispatcher V9.1.0 — Zero lógica inline + Execution Logging
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
  executeDeletarEvento,
  executeCancelarLembrete,
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

import {
  executeGerenciarProjeto,
  executeListarProjetos,
  executeGerenciarTopico,
  executeListarTopicos,
  executeGerenciarEntry,
  executeListarEntries,
} from '@/lib/tools/executors/projects';

import { searchWeb, getWeatherForecast } from '@/lib/google';
import { logToolExecution } from '@/lib/tools/executors/learning';

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
      return false;
    }
  } catch {
    // não trava a execução
  }
  return true;
}

// ── Dispatcher principal ───────────────────────────────────────────────────────

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string,
  contextSnapshot: Record<string, any>[] = []   // ← opcional, default vazio
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

  let result: string;

  switch (name) {
    // ── Memória ──────────────────────────────────────────────────────────────
    case 'buscar_memoria_longa':        result = await executeBuscarMemoriaLonga(...args); break;
    case 'adicionar_diretriz_dinamica': result = await executeAdicionarDiretrizDinamica(...args); break;

    // ── Agenda ───────────────────────────────────────────────────────────────
    case 'consultar_agenda':       result = await executeConsultarAgenda(...args); break;
    case 'salvar_evento':          result = await executeSalvarEvento(...args); break;
    case 'deletar_evento':         result = await executeDeletarEvento(...args); break;
    case 'criar_evento_agenda':    result = await executeCriarEventoAgenda(...args); break;
    case 'listar_emails_recentes': result = await executeListarEmailsRecentes(...args); break;
    case 'excluir_email':          result = await executeExcluirEmail(...args); break;
    case 'create_reminder':        result = await executeCreateReminder(...args); break;
    case 'consultar_lembretes':    result = await executeConsultarLembretes(...args); break;
    case 'cancelar_lembrete':      result = await executeCancelarLembrete(...args); break;

    // ── Veículos ─────────────────────────────────────────────────────────────
    case 'registrar_abastecimento': result = await executeRegistrarAbastecimento(...args); break;
    case 'registrar_manutencao':    result = await executeRegistrarManutencao(...args); break;
    case 'atualizar_odometro':      result = await executeAtualizarOdometro(...args); break;

    // ── Lugares e Compras ─────────────────────────────────────────────────────
    case 'salvar_lugar':         result = await executeSalvarLugar(...args); break;
    case 'adicionar_item_lista': result = await executeAdicionarItemLista(...args); break;
    case 'ver_lista':            result = await executeVerLista(...args); break;

    // ── TDAH e Diário ─────────────────────────────────────────────────────────
    case 'gerenciar_eisenhower': result = await executeGerenciarEisenhower(...args); break;
    case 'quebrar_tarefa':       result = await executeQuebrarTarefa(...args); break;
    case 'criar_rotina':         result = await executeCriarRotina(...args); break;
    case 'registrar_no_diario':  result = await executeRegistrarNoDiario(...args); break;
    case 'atualizar_meta':       result = await executeAtualizarMeta(...args); break;

    // ── Finanças ──────────────────────────────────────────────────────────────
    case 'registrar_transacao': result = await executeRegistrarTransacao(p, authUserId, numericUserIdStr); break;
    case 'consultar_financas':  result = await executeConsultarFinancas(p, authUserId, numericUserIdStr); break;
    case 'criar_orcamento':     result = await executeCriarOrcamento(p, authUserId, numericUserIdStr); break;
    case 'listar_orcamentos':   result = await executeListarOrcamentos(authUserId, numericUserIdStr); break;

    // ── Web e Clima ───────────────────────────────────────────────────────────
    case 'searchWeb':          result = await searchWeb(p.query); break;
    case 'getWeatherForecast': result = await getWeatherForecast(p.lat, p.lng); break;

    default:
      return `Ferramenta "${name}" não reconhecida pelo dispatcher.`;
  }

  // ── Log assíncrono — nunca bloqueia a resposta ao usuário ─────────────────
  logToolExecution({
    userId: Number(numericUserIdStr),
    toolName: name,
    arguments: p,
    output: result,
    contextSnapshot,                          // ← agora populado
  }).catch(() => {});

  return result;
}
