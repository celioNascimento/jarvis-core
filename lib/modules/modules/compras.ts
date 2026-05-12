// lib/modules/compras.ts
import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';

export const ModuloCompras: ModuleDefinition = {
  id: 'compras',
  label: 'Lista de Compras',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['compras', 'foco', 'projetos'],
    keywords: /comprar|lista|mercado|item|preciso de|material|insumo|reforma/i
  },

  buildContextBlock: async (opts) => {
    // Busca itens pendentes e traz o nome do projeto via join
    const { data, error } = await supabase
      .from('shopping_items')
      .select(`
        item, 
        category, 
        project_id,
        projects ( name, tag )
      `)
      .eq('user_id', opts.userId)
      .eq('done', false)
      .eq('archived', false);

    if (error || !data?.length) return '';

    // Segmentação lógica: Pessoais vs Projetos
    const pessoais = data.filter(i => !i.project_id);
    const deProjeto = data.filter(i => i.project_id);

    const linhas = ['### 🛒 LISTA DE COMPRAS ATIVA'];

    if (pessoais.length) {
      linhas.push('\n**🛍️ Itens Pessoais:**');
      linhas.push(...pessoais.map(i => `- ${i.item} [${i.category}]`));
    }

    if (deProjeto.length) {
      linhas.push('\n**🏗️ Materiais de Projetos:**');
      linhas.push(...deProjeto.map(i => {
        const projInfo = i.projects ? `(Projeto: ${i.projects.name || i.projects.tag})` : '';
        return `- ${i.item} ${projInfo}`;
      }));
    }

    return linhas.join('\n');
  },

  // Vinculado às definições em lib/tools/defs/compras.ts
  tools: [
    'adicionar_item_lista',
    'ver_lista',
    'marcar_item_comprado',
    'listar_compras_projeto'
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
