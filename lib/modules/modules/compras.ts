// lib/modules/compras.ts
// Definição do Módulo de Compras integrado à SSOT Core

import type { ModuleDefinition } from '../types';
import { coreListarCompras } from '@/lib/services/shopping.service';

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
      // Carrega os itens do usuário e os compartilhados com ele via SSOT
      const data = await coreListarCompras(Number(opts.userId));
      
      const pendentes = data.filter((i: any) => i.done === false);
      if (!pendentes.length) return '';

      const pessoais = pendentes.filter((i: any) => !i.project_id);
      const deProjeto = pendentes.filter((i: any) => i.project_id);

      const linhas = ['### 🛒 LISTA DE COMPRAS ATIVA (Inclui Itens Compartilhados)'];

      if (pessoais.length) {
        linhas.push('\n**🛍️ Itens Pessoais:**');
        linhas.push(...pessoais.map((i: any) => `- ${i.item} [${i.category}]`));
      }

      if (deProjeto.length) {
        linhas.push('\n**🏗️ Materiais de Projetos:**');
        linhas.push(...deProjeto.map((i: any) => {
          const p = Array.isArray(i.projects) ? i.projects[0] : i.projects;
          const projInfo = p ? `(Projeto: ${p.name || p.tag})` : '';
          return `- ${i.item} ${projInfo}`;
        }));
      }

      return linhas.join('\n');
    } catch (err) {
      console.error('[ModuloCompras] Erro ao montar bloco de contexto:', err);
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
