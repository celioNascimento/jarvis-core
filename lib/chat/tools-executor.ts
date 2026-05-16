// lib/chat/tools-executor.ts
// Dispatcher V10.4.0 — Imports Corrigidos (TDAH & Rotinas SSOT)

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
import { executeGerenciarEisenhower, executeQuebrarTarefa, executeRegistrarDespejo, executeRegistrarSessaoFoco, executeConsultarResumoFoco } from '@/lib/tools/executors/tdah';
import { executeRegistrarTransacao, executeConsultarFinancas, executeCriarOrcamento, executeListarOrcamentos } from '@/lib/finances/executor';
import { executeGerenciarProjeto, executeListarProjetos, executeGerenciarTopico, executeListarTopicos, executeGerenciarEntry, executeListarEntries, executeGerenciarMembrosProjeto } from '@/lib/tools/executors/projects';
import { executeListarRotinas, executeGerenciarRotina, executeFazerCheckinRotina } from '@/lib/tools/executors/routines';
import { searchWeb, getWeatherForecast } from '@/lib/google';
import { logToolExecution } from '@/lib/tools/executors/learning';
import { executeGerenciarGuideline } from '@/lib/tools/executors/guidelines';
import { executeAlternarPermissao } from '../tools/executors/relationships';

// ── Tools que escrevem dados (Invalidação de Cache) ──────────────────────────
const WRITE_TOOLS = new Set([
  'agenda_salvar_evento', 'agenda_deletar_evento', 'email_excluir', 
  'lembrete_criar', 'lembrete_cancelar', 
  'tdah_gerenciar_eisenhower', 'tdah_quebrar_tarefa', 'tdah_registrar_despejo_mental', 'tdah_registrar_sessao_foco', 
  'financas_registrar_transacao', 'financas_criar_orcamento', 
  'projeto_gerenciar', 'projeto_gerenciar_topico', 'projeto_gerenciar_entry',
  'projeto_gerenciar_membros', 'lugar_salvar', 'compra_adicionar_item', 
  'compra_marcar_comprado', 'memoria_adicionar_diretriz', 'sistema_gerenciar_guideline', 
  'veiculo_registrar_abastecimento', 'veiculo_registrar_manutencao', 
  'veiculo_atualizar_odometro', 'contato_alternar_permissao',
  'gerenciar_rotina', 'fazer_checkin_rotina'
]);

// ── Tipagem do Handler Modular ───────────────────────────────────────────────
type ToolHandler = (p: any, authUserId: string, numericUserIdStr: string, sessionId: string) => Promise<string>;

// ── Roteador Modular (100% PT-BR) ────────────────────────────────────────────
const TOOL_ROUTER: Record<string, ToolHandler> = {
  // ── Memória e Sistema
  'memoria_buscar_longa':        (p, a, n) => executeBuscarMemoriaLonga(p, a, n),
  'memoria_adicionar_diretriz':  (p, a, n) => executeAdicionarDiretrizDinamica(p, a, n),
  'sistema_gerenciar_guideline': (p, a, n) => executeGerenciarGuideline(p, a, n),

  // ── Agenda
  'agenda_consultar':      (p, a, n) => executeConsultarAgenda(p, a, n),
  'agenda_salvar_evento':  (p, a, n, s) => executeSalvarEvento(p, a, n, s),
  'agenda_deletar_evento': (p, a, n, s) => executeDeletarEvento(p, a, n, s),

  // ── Lembretes
  'lembrete_consultar': (p, a, n) => executeConsultarLembretes(p, a, n),
  'lembrete_criar':     (p, a, n, s) => executeCreateReminder(p, a, n, s),
  'lembrete_cancelar':  (p, a, n, s) => executeCancelarLembrete(p, a, n, s),

  // ── E-mails
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
  'veiculo_registrar_abastecimento': (p, a, n) => executeRegistrarAbastecimento(p, a, n),
  'veiculo_registrar_manutencao':    (p, a, n) => executeRegistrarManutencao(p, a, n),
  'veiculo_atualizar_odometro':      (p, a, n) => executeAtualizarOdometro(p, a, n),

  // ── Lugares e Compras
  'lugar_salvar':            (p, a, n) => executeSalvarLugar(p, a, n),
  'compra_adicionar_item':   (p, a, n) => executeAdicionarItemLista(p, a, n),
  'compra_ver_lista':        (p, a, n) => executeVerLista(p, a, n),
  'compra_marcar_comprado':  (p, a, n) => executeMarcarItemComprado(p, a, n),
  'compra_listar_projeto':   (p, a, n) => executeListarComprasProjeto(p, a, n),

  // ── TDAH e Foco
  'tdah_gerenciar_eisenhower':     (p, a, n) => executeGerenciarEisenhower(p, a, n),
  'tdah_quebrar_tarefa':           (p, a, n) => executeQuebrarTarefa(p, a, n),
  'tdah_registrar_despejo_mental': (p, a, n) => executeRegistrarDespejo(p, a, n),
  'tdah_registrar_sessao_foco':    (p, a, n) => executeRegistrarSessaoFoco(p, a, n),
  'tdah_consultar_resumo':         (p, a, n) => executeConsultarResumoFoco(p, a, n),

  // ── Rotinas
  'listar_rotinas':       (p, a, n) => executeListarRotinas(p, a, n),
  'gerenciar_rotina':     (p, a, n) => executeGerenciarRotina(p, a, n),
  'fazer_checkin_rotina': (p, a, n) => executeFazerCheckinRotina(p, a, n),

  // ── Finanças
  'financas_registrar_transacao': (p, a, n) => executeRegistrarTransacao(p, a, n),
  'financas_consultar':           (p, a, n) => executeConsultarFinancas(p, a, n),
  'financas_criar_orcamento':     (p, a, n) => executeCriarOrcamento(p, a, n),
  'financas_listar_orcamentos':   (_, a, n) => executeListarOrcamentos(a, n),

  // ── Projetos
  'projeto_gerenciar':         (p, a, n) => executeGerenciarProjeto(p, a, n),
  'projeto_listar':            (p, a, n) => executeListarProjetos(p, a, n),
  'projeto_gerenciar_topico':  (p, a, n) => executeGerenciarTopico(p, a, n),
  'projeto_listar_topicos':    (p, a, n) => executeListarTopicos(p, a, n),
  'projeto_gerenciar_entry':   (p, a, n) => executeGerenciarEntry(p, a, n),
  'projeto_listar_entries':    (p, a, n) => executeListarEntries(p, a, n),
  'projeto_gerenciar_membros': (p, a, n) => executeGerenciarMembrosProjeto(p, a, n),

  // ── Integrações Externas e Contatos
  'web_pesquisar':              (p) => searchWeb(p.query),
  'web_previsao_tempo':         (p) => getWeatherForecast(p.lat, p.lng),
  'contato_alternar_permissao': (p, a, n) => executeAlternarPermissao(p, a, n),
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
