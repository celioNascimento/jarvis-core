// lib/chat/tools-executor.ts
// Dispatcher V9.3.0 — Cache Invalidation após writes + Type-Safe com sessionId
//
// MUDANÇA em relação à V9.2.0:
//   Separação dos imports de lembretes (agora em reminders.ts)
//   Passagem do sessionId explícito para as ferramentas que gerenciam estado de cache.

import { supabase } from '@/lib/jarvis';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

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
  executeDeletarEvento,
} from '@/lib/tools/executors/agenda';

// 🔥 NOVO IMPORT: Lembretes separados da Agenda
import {
  executeCreateReminder,
  executeConsultarLembretes,
  executeCancelarLembrete,
} from '@/lib/tools/executors/reminders';

import {
  executeRegistrarAbastecimento,
  executeRegistrarManutencao,
  executeAtualizarOdometro,
} from '@/lib/tools/executors/veiculos';

import { executeSalvarLugar } from '@/lib/tools/executors/lugares';
import {
  executeAdicionarItemLista,
  executeVerLista,
  executeMarcarItemComprado,
  executeListarComprasProjeto,
} from '@/lib/tools/executors/compras';

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
  executeGerenciarMembrosProjeto,
} from '@/lib/tools/executors/projects';

import { searchWeb, getWeatherForecast } from '@/lib/google';
import { logToolExecution } from '@/lib/tools/executors/learning';
import { executeGerenciarGuideline } from '@/lib/tools/executors/guidelines';
import { executeAlternarPermissao } from '../tools/executors/relationships';

// ── Tools que escrevem dados → invalidam o cache do masterContext ─────────────
const WRITE_TOOLS = new Set([
  'salvar_evento',
  'criar_evento_agenda',
  'deletar_evento',
  'excluir_email',
  'create_reminder',
  'cancelar_lembrete',
  'gerenciar_eisenhower',
  'quebrar_tarefa',
  'criar_rotina',
  'registrar_no_diario',
  'atualizar_meta',
  'registrar_transacao',
  'criar_orcamento',
  'gerenciar_projeto',
  'gerenciar_topico',
  'gerenciar_entry',
  'gerenciar_membros_projeto',
  'salvar_lugar',
  'adicionar_item_lista',
  'marcar_item_comprado',
  'adicionar_diretriz_dinamica',
  'gerenciar_guideline',
  'registrar_abastecimento',
  'registrar_manutencao',
  'atualizar_odometro',
  'alternar_permissao_contato',
]);

// ── Idempotência ──────────────────────────────────────────────────────────────

async function checkIdempotency(
  numericUserId: string,
  name: string,
  callSignature: string
): Promise<boolean> {
  const key = `${numericUserId}_${name}_${callSignature}`;
  try {
    const { error } = await supabase.from('idempotency_keys').insert({ key });
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
  contextSnapshot: Record<string, any>[] = [],
  sessionId?: string,
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
  
  // Garante que o sessionId seja uma string válida para evitar erros de tipagem nas ferramentas
  const safeSessionId = sessionId || 'default-session';

  let result: string;

  switch (name) {
    // ── Memória ──────────────────────────────────────────────────────────────
    case 'buscar_memoria_longa':        result = await executeBuscarMemoriaLonga(...args); break;
    case 'adicionar_diretriz_dinamica': result = await executeAdicionarDiretrizDinamica(...args); break;

    // ── Agenda (Lev e Google) ────────────────────────────────────────────────
    case 'consultar_agenda':       result = await executeConsultarAgenda(...args); break;
    case 'criar_evento_agenda':    result = await executeCriarEventoAgenda(...args); break;
    case 'listar_emails_recentes': result = await executeListarEmailsRecentes(...args); break;
    case 'excluir_email':          result = await executeExcluirEmail(...args); break;
    // Tools de Agenda com Invalidação Direta:
    case 'salvar_evento':          result = await executeSalvarEvento(p, authUserId, numericUserIdStr, safeSessionId); break;
    case 'deletar_evento':         result = await executeDeletarEvento(p, authUserId, numericUserIdStr, safeSessionId); break;

    // ── Lembretes (Notificações) ─────────────────────────────────────────────
    case 'consultar_lembretes':    result = await executeConsultarLembretes(...args); break;
    // Tools de Lembrete com Invalidação Direta:
    case 'create_reminder':        result = await executeCreateReminder(p, authUserId, numericUserIdStr, safeSessionId); break;
    case 'cancelar_lembrete':      result = await executeCancelarLembrete(p, authUserId, numericUserIdStr, safeSessionId); break;

    // ── Veículos ─────────────────────────────────────────────────────────────
    case 'registrar_abastecimento': result = await executeRegistrarAbastecimento(...args); break;
    case 'registrar_manutencao':    result = await executeRegistrarManutencao(...args); break;
    case 'atualizar_odometro':      result = await executeAtualizarOdometro(...args); break;

    // ── Lugares e Compras ─────────────────────────────────────────────────────
    case 'salvar_lugar':            result = await executeSalvarLugar(...args); break;
    case 'adicionar_item_lista':    result = await executeAdicionarItemLista(...args); break;
    case 'ver_lista':               result = await executeVerLista(...args); break;
    case 'marcar_item_comprado':    result = await executeMarcarItemComprado(...args); break;
    case 'listar_compras_projeto':  result = await executeListarComprasProjeto(...args); break;

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

    // ── Projetos ──────────────────────────────────────────────────────────────
    case 'gerenciar_projeto':         result = await executeGerenciarProjeto(...args); break;
    case 'listar_projetos':           result = await executeListarProjetos(...args); break;
    case 'gerenciar_topico':          result = await executeGerenciarTopico(...args); break;
    case 'listar_topicos':            result = await executeListarTopicos(...args); break;
    case 'gerenciar_entry':           result = await executeGerenciarEntry(...args); break;
    case 'listar_entries':            result = await executeListarEntries(...args); break;
    case 'gerenciar_membros_projeto': result = await executeGerenciarMembrosProjeto(...args); break;

    // ── Relacionamentos / Permissões ──────────────────────────────────────────
    case 'alternar_permissao_contato': result = await executeAlternarPermissao(p, authUserId, numericUserIdStr); break;

    // ── Guidelines / System Prompts ──────────────────────────────────────────
    case 'gerenciar_guideline': result = await executeGerenciarGuideline(...args); break;

    default:
      return `Ferramenta "${name}" não reconhecida pelo dispatcher.`;
  }

  // ── Invalidação de cache global (redundância de segurança) ───────────────
  if (WRITE_TOOLS.has(name) && sessionId) {
    invalidateMasterContextCache(Number(numericUserIdStr), sessionId).catch(() => {});
  }

  // ── Log assíncrono — nunca bloqueia a resposta ─────────────────────────────
  logToolExecution({
    userId:      Number(numericUserIdStr),
    toolName:    name,
    ['arguments']: p,
    output:      result,
    contextSnapshot,
  }).catch(() => {});

  return result;
}