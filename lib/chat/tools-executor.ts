// lib/chat/tools-executor.ts
// Dispatcher V10.1.0 — Arquitetura de Roteamento por Dicionário (Zero Switch)

import { supabase } from '@/lib/jarvis';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

// ── Imports dos Executores ───────────────────────────────────────────────────
import { executeBuscarMemoriaLonga, executeAdicionarDiretrizDinamica } from '@/lib/tools/executors/memory';
import { executeConsultarAgenda, executeSalvarEvento, executeDeletarEvento } from '@/lib/tools/executors/agenda';
import { executeCreateReminder, executeConsultarLembretes, executeCancelarLembrete } from '@/lib/tools/executors/reminders';
import { executeGoogleListarEmails, executeGoogleExcluirEmail } from '@/lib/tools/executors/google-context';
import { executeMicrosoftListarEmails } from '@/lib/tools/executors/microsoft-context';
import { executeRegistrarAbastecimento, executeRegistrarManutencao, executeAtualizarOdometro } from '@/lib/tools/executors/veiculos';
import { executeSalvarLugar } from '@/lib/tools/executors/lugares';
import { executeAdicionarItemLista, executeVerLista, executeMarcarItemComprado, executeListarComprasProjeto } from '@/lib/tools/executors/compras';
import { executeGerenciarEisenhower, executeQuebrarTarefa, executeCriarRotina, executeRegistrarNoDiario, executeAtualizarMeta } from '@/lib/tools/executors/tdah';
import { executeRegistrarTransacao, executeConsultarFinancas, executeCriarOrcamento, executeListarOrcamentos } from '@/lib/finances/executor';
import { executeGerenciarProjeto, executeListarProjetos, executeGerenciarTopico, executeListarTopicos, executeGerenciarEntry, executeListarEntries, executeGerenciarMembrosProjeto } from '@/lib/tools/executors/projects';
import { searchWeb, getWeatherForecast } from '@/lib/google';
import { logToolExecution } from '@/lib/tools/executors/learning';
import { executeGerenciarGuideline } from '@/lib/tools/executors/guidelines';
import { executeAlternarPermissao } from '../tools/executors/relationships';

// ── Tools que escrevem dados (Invalidação de Cache) ──────────────────────────
const WRITE_TOOLS = new Set([
  'agenda_salvar_evento', 'agenda_deletar_evento', 'email_excluir', 'rem_criar_lembrete', 'rem_cancelar',
  'gerenciar_eisenhower', 'quebrar_tarefa', 'criar_rotina', 'registrar_no_diario', 'atualizar_meta',
  'registrar_transacao', 'criar_orcamento', 'gerenciar_projeto', 'gerenciar_topico', 'gerenciar_entry',
  'gerenciar_membros_projeto', 'salvar_lugar', 'adicionar_item_lista', 'marcar_item_comprado',
  'adicionar_diretriz_dinamica', 'gerenciar_guideline', 'registrar_abastecimento', 'registrar_manutencao',
  'atualizar_odometro', 'alternar_permissao_contato'
]);

// ── Tipagem do Handler Modular ───────────────────────────────────────────────
type ToolHandler = (p: any, authUserId: string, numericUserIdStr: string, sessionId: string) => Promise<string>;

// ── Roteador Modular (O Fim do Switch Gigante) ────────────────────────────────
const TOOL_ROUTER: Record<string, ToolHandler> = {
  // ── Memória
  'buscar_memoria_longa':        (p, a, n) => executeBuscarMemoriaLonga(p, a, n),
  'adicionar_diretriz_dinamica': (p, a, n) => executeAdicionarDiretrizDinamica(p, a, n),

  // ── Agenda
  'agenda_consultar':      (p, a, n) => executeConsultarAgenda(p, a, n),
  'agenda_salvar_evento':  (p, a, n, s) => executeSalvarEvento(p, a, n, s),
  'agenda_deletar_evento': (p, a, n, s) => executeDeletarEvento(p, a, n, s),

  // ── Lembretes
  'rem_consultar_ativos': (p, a, n) => executeConsultarLembretes(p, a, n),
  'rem_criar_lembrete':   (p, a, n, s) => executeCreateReminder(p, a, n, s),
  'rem_cancelar':         (p, a, n, s) => executeCancelarLembrete(p, a, n, s),

  // ── E-mails (Lógica Isolada)
  'email_listar_recentes': async (p) => {
    if (p.provedor === 'google') return await executeGoogleListarEmails(p);
    if (p.provedor === 'outlook') return await executeMicrosoftListarEmails(p);
    const [g, m] = await Promise.all([executeGoogleListarEmails(p), executeMicrosoftListarEmails(p)]);
    return `${g}\n\n${m}`;
  },
  'email_excluir': async (p) => {
    if (p.provedor === 'google') return await executeGoogleExcluirEmail(p);
    return "Exclusão automática não disponível para Outlook.";
  },

  // ── Veículos
  'registrar_abastecimento': (p, a, n) => executeRegistrarAbastecimento(p, a, n),
  'registrar_manutencao':    (p, a, n) => executeRegistrarManutencao(p, a, n),
  'atualizar_odometro':      (p, a, n) => executeAtualizarOdometro(p, a, n),

  // ── Lugares e Compras
  'salvar_lugar':           (p, a, n) => executeSalvarLugar(p, a, n),
  'adicionar_item_lista':   (p, a, n) => executeAdicionarItemLista(p, a, n),
  'ver_lista':              (p, a, n) => executeVerLista(p, a, n),
  'marcar_item_comprado':   (p, a, n) => executeMarcarItemComprado(p, a, n),
  'listar_compras_projeto': (p, a, n) => executeListarComprasProjeto(p, a, n),

  // ── TDAH e Diário
  'gerenciar_eisenhower': (p, a, n) => executeGerenciarEisenhower(p, a, n),
  'quebrar_tarefa':       (p, a, n) => executeQuebrarTarefa(p, a, n),
  'criar_rotina':         (p, a, n) => executeCriarRotina(p, a, n),
  'registrar_no_diario':  (p, a, n) => executeRegistrarNoDiario(p, a, n),
  'atualizar_meta':       (p, a, n) => executeAtualizarMeta(p, a, n),

  // ── Finanças
  'registrar_transacao': (p, a, n) => executeRegistrarTransacao(p, a, n),
  'consultar_financas':  (p, a, n) => executeConsultarFinancas(p, a, n),
  'criar_orcamento':     (p, a, n) => executeCriarOrcamento(p, a, n),
  'listar_orcamentos':   (_, a, n) => executeListarOrcamentos(a, n),

  // ── Projetos
  'gerenciar_projeto':         (p, a, n) => executeGerenciarProjeto(p, a, n),
  'listar_projetos':           (p, a, n) => executeListarProjetos(p, a, n),
  'gerenciar_topico':          (p, a, n) => executeGerenciarTopico(p, a, n),
  'listar_topicos':            (p, a, n) => executeListarTopicos(p, a, n),
  'gerenciar_entry':           (p, a, n) => executeGerenciarEntry(p, a, n),
  'listar_entries':            (p, a, n) => executeListarEntries(p, a, n),
  'gerenciar_membros_projeto': (p, a, n) => executeGerenciarMembrosProjeto(p, a, n),

  // ── Integrações Externas e Outros
  'searchWeb':                  (p) => searchWeb(p.query),
  'getWeatherForecast':         (p) => getWeatherForecast(p.lat, p.lng),
  'alternar_permissao_contato': (p, a, n) => executeAlternarPermissao(p, a, n),
  'gerenciar_guideline':        (p, a, n) => executeGerenciarGuideline(p, a, n),
};

// ── Idempotência ──────────────────────────────────────────────────────────────
async function checkIdempotency(numericUserId: string, name: string, callSignature: string): Promise<boolean> {
  const key = `${numericUserId}_${name}_${callSignature}`;
  try {
    const { error } = await supabase.from('idempotency_keys').insert({ key });
    if (error?.code === '23505') return false;
  } catch {}
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
  if (!/^\d+$/.test(numericUserIdStr)) return `Erro: userId inválido.`;

  const { name, arguments: rawArgs } = toolCall.function;
  let p: any;
  try { p = JSON.parse(rawArgs); } catch { return `Erro: argumentos inválidos.`; }

  const sig = (toolCall.id || rawArgs).substring(0, 50);
  const canRun = await checkIdempotency(numericUserIdStr, name, sig);
  if (!canRun) return '[SISTEMA] Comando já processado.';

  const safeSessionId = sessionId || 'default-session';

  // Executa o Roteamento Dinâmico
  const handler = TOOL_ROUTER[name];
  if (!handler) {
    return `Ferramenta "${name}" não reconhecida pelo dispatcher.`;
  }

  const result = await handler(p, authUserId, numericUserIdStr, safeSessionId);

  // Invalidação e Logs
  if (WRITE_TOOLS.has(name) && sessionId) {
    invalidateMasterContextCache(Number(numericUserIdStr), sessionId).catch(() => {});
  }

  logToolExecution({
    userId: Number(numericUserIdStr),
    toolName: name,
    ['arguments']: p,
    output: result,
    contextSnapshot,
  }).catch(() => {});

  return result;
}
