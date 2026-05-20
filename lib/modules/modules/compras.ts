// lib/modules/modules/compras.ts
// V12.3.0 — Injeção de Contexto Preparada e Fallback de Hidratação

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
      // 1. Tenta a Injeção de Contexto (Se no futuro o God RPC trouxer as 'compras')
      let data = (opts as any).masterContext?.compras;

      // 2. Fallback de Segurança (Se chamado isoladamente ou se o God RPC não trouxer)
      if (!data) {
        data = await coreListarCompras(Number(opts.userId));
      }

      if (!data || !data.length) return '';

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