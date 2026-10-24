// lib/chat/pipeline/prompt-budget.ts
//
// Orçamento de tokens do prompt enviado à Modal (vLLM com --max-model-len = MODAL_MAX_MODEL_LEN).
//
//   contexto total (4096)
//     − resposta (512) − margem (128)          → reserva fixa
//     − espaço p/ resultado de ferramenta      → só quando há ferramentas
//     − ferramentas selecionadas pela mensagem
//     − pergunta atual
//     = o que sobra é dividido entre histórico recente e blocos de contexto.
//
// O histórico recente ("RAM") entra sempre. Perfil/família/memórias/agenda etc. só entram quando a
// mensagem ou as tags pedem, e sempre em ordem de prioridade até acabar o orçamento.

export const CHARS_PER_TOKEN = 3; // conservador para português + JSON (igual ao lev-gateway.ts)
export const MODAL_MAX_MODEL_LEN = Number(process.env.MODAL_MAX_MODEL_LEN) || 4096;
export const MAX_OUTPUT_TOKENS = 512;
export const CONTEXT_SAFETY_MARGIN = 128;
export const TOOL_RESULT_RESERVE_TOKENS = 250;
export const MAX_USER_MESSAGE_CHARS = 1500;
export const MAX_HISTORY_MESSAGES = 8;
export const MAX_HISTORY_MESSAGE_CHARS = 500;
export const MESSAGE_OVERHEAD_TOKENS = 10; // {"role":...,"content":...} do JSON enviado
const MAX_HISTORY_SHARE = 0.6; // fatia máxima do que sobra que o histórico pode ocupar

export type ChatLike = { role: string; content: string };

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / CHARS_PER_TOKEN);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  // Corta em fim de linha/frase quando possível para não deixar frase pela metade.
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trimEnd();
}

// ── Orçamento total ──────────────────────────────────────────────────────────

/** Tokens disponíveis para tudo que é prompt (system + ferramentas + histórico + pergunta). */
export function promptBudgetTokens(hasTools: boolean): number {
  return (
    MODAL_MAX_MODEL_LEN -
    MAX_OUTPUT_TOKENS -
    CONTEXT_SAFETY_MARGIN -
    (hasTools ? TOOL_RESULT_RESERVE_TOKENS : 0)
  );
}

// ── Seleção de ferramentas ───────────────────────────────────────────────────

type ToolGroup =
  | 'agenda' | 'lembretes' | 'rotinas' | 'foco' | 'projetos' | 'compras'
  | 'vinculos' | 'memoria' | 'web';

const TOOL_GROUP_BY_NAME: Record<string, ToolGroup> = {
  agenda_salvar_evento: 'agenda', agenda_deletar_evento: 'agenda', agenda_consultar: 'agenda',
  lembrete_criar: 'lembretes', lembrete_cancelar: 'lembretes', lembrete_consultar: 'lembretes',
  gerenciar_rotina: 'rotinas', fazer_checkin_rotina: 'rotinas', listar_rotinas: 'rotinas',
  tdah_registrar_sessao_foco: 'foco', tdah_gerenciar_eisenhower: 'foco', tdah_quebrar_tarefa: 'foco',
  tdah_registrar_despejo_mental: 'foco', tdah_consultar_resumo: 'foco',
  gerenciar_projeto: 'projetos', gerenciar_membros_projeto: 'projetos', gerenciar_topico: 'projetos',
  gerenciar_entry: 'projetos', listar_projetos: 'projetos', listar_topicos: 'projetos', listar_entries: 'projetos',
  adicionar_item_lista: 'compras', listar_compras_projeto: 'compras', marcar_item_comprado: 'compras', ver_lista: 'compras',
  contato_alternar_permissao: 'vinculos',
  adicionar_diretriz_dinamica: 'memoria', buscar_memoria_longa: 'memoria',
  web_pesquisar: 'web',
};

const GROUP_PATTERNS: Record<ToolGroup, RegExp> = {
  agenda: /agenda|evento|compromisso|reuni|marc(a|ar|o|e)\b|desmarc|remarc|cancel(a|ar)|consulta|dentista|m[eé]dico|anivers|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana que vem|\b\d{1,2}h\b|\b\d{1,2}[:h]\d{2}\b|\bàs \d/i,
  lembretes: /lembr(a|ar|e|ete)|avis(a|e|ar)|me chama|n[ãa]o me deixa esquecer/i,
  rotinas: /rotina|h[áa]bito|check-?in|todo dia|diariamente|toda (manh[ãa]|noite|semana)|streak|sequ[êe]ncia/i,
  foco: /foco|pomodoro|concentr|eisenhower|priorid|quebr(a|ar) (a |essa )?tarefa|despejo|desabaf|cabe[çc]a (cheia|a mil)|tdah|procrastin|sess[ãa]o de/i,
  projetos: /projeto|t[óo]pico|entrada|anota[çc][ãa]o|membro|convid|equipe|time|sprint|backlog|tarefa/i,
  compras: /compra|lista|mercado|supermercado|comprei|comprar|item|carrinho|feira|padaria|farm[áa]cia/i,
  vinculos: /v[íi]nculo|permiss[ãa]o|compartilh|contato|acesso (da|do|de)|esposa|marido|c[ôo]njuge|pai|m[ãa]e|filh[oa]/i,
  memoria: /lembra (do|da|de|quando)|voc[êe] lembra|o que (eu )?(te )?(falei|disse|contei)|sempre que|a partir de agora|daqui pra frente|regra|diretriz/i,
  web: /not[íi]cia|resultado|placar|jogo|cota[çc][ãa]o|d[óo]lar|bitcoin|previs[ãa]o|clima|tempo (hoje|amanh)|pesquis|google|quanto custa|pre[çc]o|[úu]ltim[ao]s?|lan[çc]ament|ao vivo|quem ganhou|quando ([ée]|foi|vai)/i,
};

const CONTEXT_TAG_TO_GROUPS: Record<string, ToolGroup[]> = {
  agenda: ['agenda', 'lembretes'], evento: ['agenda', 'lembretes'],
  rotina: ['rotinas'], foco: ['foco'], tdah: ['foco'],
  projeto: ['projetos'], trabalho: ['projetos'],
  compras: ['compras'], financas: ['compras'],
  familia: ['vinculos'], filhos: ['vinculos'],
};

export interface ToolSelection {
  tools: any[];
  groups: ToolGroup[];
  tokens: number;
  dropped: string[];
}

/**
 * Escolhe as ferramentas que a mensagem realmente pode usar.
 * - Pontua cada grupo pela mensagem atual (peso 3), tags de contexto (2) e últimas falas (1,
 *   para continuações como "sim, pode marcar").
 * - Entram grupos em ordem de pontuação até esgotar `maxTokens`; sem nenhum sinal → nenhuma ferramenta.
 * - `web_pesquisar` só entra com sinal de dado ao vivo na mensagem atual.
 */
export function selectTools(
  candidateTools: any[],
  message: string,
  contexts: string[],
  recentHistory: ChatLike[],
  maxTokens: number,
): ToolSelection {
  const empty: ToolSelection = { tools: [], groups: [], tokens: 0, dropped: [] };
  if (!candidateTools?.length || maxTokens <= 0) return empty;

  const score = new Map<ToolGroup, number>();
  const bump = (g: ToolGroup, n: number) => score.set(g, Math.max(score.get(g) ?? 0, n));

  const lastTurns = recentHistory.slice(-2).map(m => m.content).join(' ');
  for (const g of Object.keys(GROUP_PATTERNS) as ToolGroup[]) {
    if (GROUP_PATTERNS[g].test(message)) bump(g, 3);
    else if (g !== 'web' && GROUP_PATTERNS[g].test(lastTurns)) bump(g, 1);
  }
  for (const tag of contexts) {
    for (const g of CONTEXT_TAG_TO_GROUPS[tag.toLowerCase()] ?? []) bump(g, 2);
  }

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const chosenGroups: ToolGroup[] = [];
  const chosen: any[] = [];
  const dropped: string[] = [];
  let used = 0;

  for (const group of ranked) {
    const groupTools = candidateTools.filter(t => TOOL_GROUP_BY_NAME[t?.function?.name] === group);
    if (!groupTools.length) continue;
    const groupTokens = estimateJsonTokens(groupTools);
    if (used + groupTokens <= maxTokens) {
      chosen.push(...groupTools);
      chosenGroups.push(group);
      used += groupTokens;
      continue;
    }
    // Grupo inteiro não cabe: tenta as ferramentas mais baratas dele (uma a uma).
    for (const tool of [...groupTools].sort((a, b) => estimateJsonTokens(a) - estimateJsonTokens(b))) {
      const t = estimateJsonTokens(tool);
      if (used + t <= maxTokens) { chosen.push(tool); used += t; if (!chosenGroups.includes(group)) chosenGroups.push(group); }
      else dropped.push(tool.function.name);
    }
  }

  // Preserva a ordem original das ferramentas (estável para o modelo).
  const tools = candidateTools.filter(t => chosen.includes(t));
  return { tools, groups: chosenGroups, tokens: used, dropped };
}

// ── Histórico recente ────────────────────────────────────────────────────────

/**
 * Pega as mensagens mais recentes que cabem em `maxTokens` (a partir da última para trás),
 * encurta mensagens longas e garante que o recorte comece numa fala do usuário.
 */
export function selectHistory(history: ChatLike[], maxTokens: number): ChatLike[] {
  const clean = (history ?? []).filter(
    m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  );
  const picked: ChatLike[] = [];
  let used = 0;
  for (let i = clean.length - 1; i >= 0 && picked.length < MAX_HISTORY_MESSAGES; i--) {
    const content = clean[i].content.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS);
    const cost = estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
    if (used + cost > maxTokens) break;
    picked.unshift({ role: clean[i].role, content });
    used += cost;
  }
  while (picked.length && picked[0].role !== 'user') picked.shift();
  return picked;
}

export function historyShare(remainingTokens: number): number {
  return Math.max(0, Math.floor(remainingTokens * MAX_HISTORY_SHARE));
}

// ── Blocos de contexto por prioridade ────────────────────────────────────────

export interface ContextBlock {
  key: string;
  text: string;
  /** Menor número = mais importante. */
  priority: number;
  /** Se o bloco puder ser encurtado em vez de descartado, define o mínimo útil (tokens). */
  minTokens?: number;
}

/** Inclui blocos por prioridade; o que não cabe é encurtado (se permitido) ou descartado. */
export function fitBlocks(blocks: ContextBlock[], maxTokens: number): { text: string; included: string[]; dropped: string[] } {
  const included: string[] = [];
  const dropped: string[] = [];
  const parts = new Map<string, string>();
  let used = 0;

  for (const block of [...blocks].filter(b => b.text.trim()).sort((a, b) => a.priority - b.priority)) {
    const cost = estimateTokens(block.text) + 2;
    const room = maxTokens - used;
    if (cost <= room) {
      parts.set(block.key, block.text);
      used += cost;
      included.push(block.key);
    } else if (block.minTokens && room >= block.minTokens) {
      const shortened = truncateToTokens(block.text, room - 2);
      parts.set(block.key, shortened);
      used += estimateTokens(shortened) + 2;
      included.push(`${block.key}(parcial)`);
    } else {
      dropped.push(block.key);
    }
  }

  // Mantém a ordem de leitura natural (por prioridade).
  const ordered = [...blocks].sort((a, b) => a.priority - b.priority).map(b => parts.get(b.key)).filter(Boolean);
  return { text: ordered.join('\n\n'), included, dropped };
}
