// lib/modules/modules/compras.ts
// V13.0.0 — STRICT REGRA 3: Zero DB Calls + Arquitetura V2 (Sinal de fumaça)

import type { ModuleDefinition } from '../types';

export const ModuloCompras: ModuleDefinition = {
  id: 'compras',
  label: 'Lista de Compras',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['compras', 'foco', 'projeto'],
    keywords: /comprar|lista|mercado|item|preciso de|material|insumo|reforma/i
  },

  buildContextBlock: async (opts) => {
    try {
      // Lê exclusivamente do masterContext (RAM) — zero queries
      const shopping = (opts as any).masterContext?.shopping;

      if (!shopping?.length) return '';

      // Filtra shares autorizados para manter a contagem precisa
      const shares: any[] = (opts as any).masterContext?.shopping_shares || [];
      const authorizedOwners = shares.map((s: any) => s.owner_id);

      const pendentes = shopping.filter((i: any) =>
        !i.done && !i.archived &&
        (String(i.user_id) === String(opts.userId) || authorizedOwners.includes(i.user_id))
      );

      if (!pendentes.length) return '';

      // V2: Remove a injeção da lista detalhada em Markdown no prompt. 
      // Emite apenas o sinal de fumaça com a contagem e as ferramentas correspondentes.
      return `[Módulo: Compras] Há ${pendentes.length} item(ns) pendente(s) na lista de compras. Use a tool 'ver_lista' para consultar os itens pessoais, 'listar_compras_projeto' para materiais de projetos, ou 'adicionar_item_lista' / 'marcar_item_comprado' para modificações.`;
    } catch (err) {
      console.error('[ModuloCompras] Erro:', err);
      return '';
    }
  },

  tools: [
    'adicionar_item_lista',
    'ver_lista',
    'marcar_item_comprado',
    'listar_compras_projeto'
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
