// lib/chat/tools-executor.ts
// Dispatcher V11.1.0 — Modularizado, Tipado e Livre de I/O de Leitura Bloqueante

import { supabase } from '@/lib/jarvis';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

// ── Imports de Executores ───────────────────────────────────────────────────
import * as Memory from '@/lib/tools/executors/memory';
import * as Agenda from '@/lib/tools/executors/agenda';
import * as Reminders from '@/lib/tools/executors/reminders';
import * as Google from '@/lib/tools/executors/google-context';
import * as Microsoft from '@/lib/tools/executors/microsoft-context';
import * as Veiculos from '@/lib/tools/executors/veiculos';
import * as Lugares from '@/lib/tools/executors/lugares';
import * as Compras from '@/lib/tools/executors/compras';
import * as TDAH from '@/lib/tools/executors/tdah';
import * as Financas from '@/lib/finances/executor';
import * as Projects from '@/lib/tools/executors/projects';
import * as Rotinas from '@/lib/tools/executors/routines';
import * as Clima from '@/lib/tools/executors/clima';
import * as Esportes from '@/lib/tools/executors/esportes';
import * as Guidelines from '@/lib/tools/executors/guidelines';
import * as Relationships from '@/lib/tools/executors/relationships';
import * as Dossie from '@/lib/tools/executors/dossie';
import * as Personality from '@/lib/tools/executors/personality';
import { searchWeb } from '@/lib/google';
import { logToolExecution } from '@/lib/tools/executors/learning';

// ── Tipagens ────────────────────────────────────────────────────────────────
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolCallResult = { tc: ToolCall; result: string };

// Tipagem estrita evitando o 'any' solto
type ToolHandler = (p: Record<string, unknown>, authUserId: string, numericUserIdStr: string, sessionId: string) => Promise<string>;

const WRITE_TOOLS = new Set([
  'agenda_salvar_evento', 'agenda_deletar_evento', 'email_excluir', 'lembrete_criar', 'lembrete_cancelar', 
  'tdah_gerenciar_eisenhower', 'tdah_quebrar_tarefa', 'tdah_registrar_despejo_mental', 'tdah_registrar_sessao_foco', 
  'financas_registrar_transacao', 'financas_criar_orcamento', 'projeto_gerenciar', 'projeto_gerenciar_topico', 
  'projeto_gerenciar_entry', 'projeto_gerenciar_membros', 'lugar_salvar', 'compra_adicionar_item', 
  'compra_marcar_comprado', 'memoria_adicionar_diretriz', 'gerenciar_guideline', 'veiculo_registrar_abastecimento', 
  'veiculo_registrar_manutencao', 'veiculo_atualizar_odometro', 'contato_alternar_permissao', 'gerenciar_rotina', 
  'fazer_checkin_rotina', 'dossie_atualizar', 'personalidade_ajustar',
]);

// ── Roteador Modular ────────────────────────────────────────────────────────
// ── Roteador Modular ────────────────────────────────────────────────────────
const TOOL_ROUTER: Record<string, ToolHandler> = {
  ...{
    'memoria_buscar_longa': (p, a, n) => Memory.executeBuscarMemoriaLonga(p as any, a, n),
    'memoria_adicionar_diretriz': (p, a, n) => Memory.executeAdicionarDiretrizDinamica(p as any, a, n),
    'gerenciar_guideline': (p, a, n) => Guidelines.executeGerenciarGuideline(p as any, a, n),
  },
  ...{
    'agenda_consultar': (p, a, n) => Agenda.executeConsultarAgenda(p as any, a, n),
    'agenda_salvar_evento': (p, a, n, s) => Agenda.executeSalvarEvento(p as any, a, n, s),
    'agenda_deletar_evento': (p, a, n, s) => Agenda.executeDeletarEvento(p as any, a, n, s),
  },
  ...{
    'lembrete_consultar': (p, a, n) => Reminders.executeConsultarLembretes(p as any, a, n),
    'lembrete_criar': (p, a, n, s) => Reminders.executeCreateReminder(p as any, a, n, s),
    'lembrete_cancelar': (p, a, n, s) => Reminders.executeCancelarLembrete(p as any, a, n, s),
  },
  ...{
    'email_listar_recentes': async (p) => {
      if (p.provedor === 'google') return await Google.executeGoogleListarEmails(p as any);
      if (p.provedor === 'outlook') return await Microsoft.executeMicrosoftListarEmails(p as any);
      const [g, m] = await Promise.all([Google.executeGoogleListarEmails(p as any), Microsoft.executeMicrosoftListarEmails(p as any)]);
      return `${g}\n\n${m}`;
    },
    'email_excluir': async (p) => (p.provedor === 'google' ? await Google.executeGoogleExcluirEmail(p as any) : "N/A"),
  },
  ...{
    'veiculo_registrar_abastecimento': (p, a, n) => Veiculos.executeRegistrarAbastecimento(p as any, a, n),
    'veiculo_registrar_manutencao': (p, a, n) => Veiculos.executeRegistrarManutencao(p as any, a, n),
    'veiculo_atualizar_odometro': (p, a, n) => Veiculos.executeAtualizarOdometro(p as any, a, n),
  },
  ...{
    'lugar_salvar': (p, a, n) => Lugares.executeSalvarLugar(p as any, a, n),
    'compra_adicionar_item': (p, a, n) => Compras.executeAdicionarItemLista(p as any, a, n),
    'compra_ver_lista': (p, a, n) => Compras.executeVerLista(p as any, a, n),
    'compra_marcar_comprado': (p, a, n) => Compras.executeMarcarItemComprado(p as any, a, n),
    'compra_listar_projeto': (p, a, n) => Compras.executeListarComprasProjeto(p as any, a, n),
  },
  ...{
    'tdah_gerenciar_eisenhower': (p, a, n) => TDAH.executeGerenciarEisenhower(p as any, a, n),
    'tdah_quebrar_tarefa': (p, a, n) => TDAH.executeQuebrarTarefa(p as any, a, n),
    'tdah_registrar_despejo_mental': (p, a, n) => TDAH.executeRegistrarDespejo(p as any, a, n),
    'tdah_registrar_sessao_foco': (p, a, n) => TDAH.executeRegistrarSessaoFoco(p as any, a, n),
    'tdah_consultar_resumo': (p, a, n) => TDAH.executeConsultarResumoFoco(p as any, a, n),
  },
  ...{
    'listar_rotinas': (p, a, n) => Rotinas.executeListarRotinas(p as any, a, n),
    'gerenciar_rotina': (p, a, n) => Rotinas.executeGerenciarRotina(p as any, a, n),
    'fazer_checkin_rotina': (p, a, n) => Rotinas.executeFazerCheckinRotina(p as any, a, n),
  },
  ...{
    'financas_registrar_transacao': (p, a, n) => Financas.executeRegistrarTransacao(p as any, a, n),
    'financas_consultar': (p, a, n) => Financas.executeConsultarFinancas(p as any, a, n),
    'financas_criar_orcamento': (p, a, n) => Financas.executeCriarOrcamento(p as any, a, n),
    'financas_listar_orcamentos': (_, a, n) => Financas.executeListarOrcamentos(a, n),
  },
  ...{
    'projeto_gerenciar': (p, a, n) => Projects.executeGerenciarProjeto(p as any, a, n),
    'projeto_listar': (p, a, n) => Projects.executeListarProjetos(p as any, a, n),
    'projeto_gerenciar_topico': (p, a, n) => Projects.executeGerenciarTopico(p as any, a, n),
    'projeto_listar_topicos': (p, a, n) => Projects.executeListarTopicos(p as any, a, n),
    'projeto_gerenciar_entry': (p, a, n) => Projects.executeGerenciarEntry(p as any, a, n),
    'projeto_listar_entries': (p, a, n) => Projects.executeListarEntries(p as any, a, n),
    'projeto_gerenciar_membros': (p, a, n) => Projects.executeGerenciarMembrosProjeto(p as any, a, n),
  },
  ...{
    'esportes_consultar_placar_ao_vivo': (p) => Esportes.executeConsultarPlacarAoVivo(p as any),
    'esportes_consultar_tabela': (p) => Esportes.executeConsultarTabela(p as any),
    'web_pesquisar': (p) => searchWeb(p.query as string),
    'clima_consultar_atual': (p, a, n) => Clima.executeConsultarClimaAtual(p as any, a, n),
    'contato_alternar_permissao': (p, a, n) => Relationships.executeAlternarPermissao(p as any, a, n),
  },
  ...{
    'dossie_atualizar': (p, a, n) => Dossie.executeAtualizarDossie(p as any, a, n),
    'dossie_consultar': (p, a, n) => Dossie.executeConsultarDossie(p as any, a, n),
    'personalidade_ajustar': (p, a, n) => Personality.executeAjustarPersonalidade(p as any, a, n),
    'personalidade_consultar': (p, a, n) => Personality.executeConsultarPersonalidade(p as any, a, n),
  }
};

// ── Logica de Sanidade e Execução ───────────────────────────────────────────
function preFlightFilter(toolCalls: ToolCall[]): ToolCall[] {
  const unique = Array.from(new Set(toolCalls.map(tc => JSON.stringify(tc))))
    .map(s => JSON.parse(s) as ToolCall);
  const hasUpdate = unique.some(tc => tc.function.name.includes('_atualizar') || tc.function.name.includes('_salvar'));
  return hasUpdate ? unique.filter(tc => !tc.function.name.includes('_consultar')) : unique;
}

async function checkIdempotency(numericUserId: string, name: string, sig: string): Promise<boolean> {
  const key = `${numericUserId}_${name}_${sig}`;
  try {
    const { error } = await supabase.from('idempotency_keys').insert({ key });
    return !error;
  } catch { return true; } // Silencia erros no DB para não travar a execução
}

export async function executeTool(
  toolCall: ToolCall,
  authUserId: string,
  numericUserIdStr: string,
  contextSnapshot: any[] = [],
  sessionId?: string,
): Promise<string> {
  const { name, arguments: rawArgs } = toolCall.function;
  
  let p: Record<string, unknown>;
  try { 
    p = JSON.parse(rawArgs); 
  } catch { 
    return `Erro: argumentos inválidos.`; 
  }

  const isWriteAction = WRITE_TOOLS.has(name);

  // [CORREÇÃO: RIGOR DE I/O] Só checamos idempotência se for uma ferramenta de ESCRITA
  if (isWriteAction) {
    if (!(await checkIdempotency(numericUserIdStr, name, (toolCall.id || rawArgs).substring(0, 50)))) {
      return '[SISTEMA] Comando já processado.';
    }
  }

  const handler = TOOL_ROUTER[name];
  if (!handler) return `Ferramenta "${name}" não reconhecida.`;

  const result = await handler(p, authUserId, numericUserIdStr, sessionId || 'default');

  // Invalidação de cache baseada na escrita
  if (isWriteAction && sessionId) {
    invalidateMasterContextCache(Number(numericUserIdStr), sessionId).catch(() => {});
  }

  // Log assíncrono (Fire & Forget)
  logToolExecution({ 
    userId: Number(numericUserIdStr), 
    toolName: name, 
    ['arguments']: p, 
    output: result, 
    contextSnapshot 
  }).catch(() => {});

  return result;
}

export async function executeBatchTools(
  toolCalls: ToolCall[],
  authUserId: string,
  numericUserIdStr: string,
  sessionId: string,
  contextSnapshot: any[]
): Promise<ToolCallResult[]> {
  const filtered = preFlightFilter(toolCalls);
  const results: ToolCallResult[] = [];
  
  for (const tc of filtered) {
    const output = await executeTool(tc, authUserId, numericUserIdStr, contextSnapshot, sessionId);
    results.push({ tc, result: output });
  }
  return results;
}