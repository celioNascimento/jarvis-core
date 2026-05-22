import type { ModuleDefinition } from '../types';

export const ModuloCompras: ModuleDefinition = {
  id: 'compras',
  label: 'Lista de Compras',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['compras', 'foco', 'projeto'],
    keywords: /comprar|lista|mercado|item|preciso de|material|insumo|reforma/i
  },

  buildContextBlock: async (opts) => {
    try {
      // Lê exclusivamente do masterContext — zero queries
      const shopping = (opts as any).masterContext?.shopping;

      if (!shopping?.length) return '';

      // Filtra shares autorizados
      const shares: any[] = (opts as any).masterContext?.shopping_shares || [];
      const authorizedOwners = shares.map((s: any) => s.owner_id);

      const pendentes = shopping.filter((i: any) =>
        !i.done && !i.archived &&
        (String(i.user_id) === String(opts.userId) || authorizedOwners.includes(i.user_id))
      );

      if (!pendentes.length) return '';

      const pessoais  = pendentes.filter((i: any) => !i.project_id);
      const deProjeto = pendentes.filter((i: any) =>  i.project_id);

      const linhas = ['### 🛒 LISTA DE COMPRAS ATIVA'];

      if (pessoais.length) {
        linhas.push('\n**🛍️ Itens Pessoais:**');
        linhas.push(...pessoais.map((i: any) => `- ${i.item} [${i.category}]`));
      }

      if (deProjeto.length) {
        linhas.push('\n**🏗️ Materiais de Projetos:**');
        linhas.push(...deProjeto.map((i: any) => `- ${i.item}`));
      }

      return linhas.join('\n');
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
