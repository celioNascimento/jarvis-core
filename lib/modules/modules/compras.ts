// lib/modules/compras.ts
import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';
import { getEffectiveUserId } from '../../modules/relationships';

export const ModuloCompras: ModuleDefinition = {
  id: 'compras',
  label: 'Lista de Compras',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    // Corrigido para 'projeto' (singular) conforme seu ContextType
    contexts: ['compras', 'foco', 'projeto'],
    keywords: /comprar|lista|mercado|item|preciso de|material|insumo|reforma/i
  },

 buildContextBlock: async (opts) => {
    // 1. Resolve o ID real para que o Jarvis enxergue o que o App mostra
    const effectiveId = await getEffectiveUserId(opts.userId, opts.userId);

    const { data, error } = await supabase
      .from('shopping_items')
      .select(`
        item, 
        category, 
        project_id,
        projects ( name, tag )
      `)
      .eq('user_id', effectiveId) 
      .eq('done', false)
      .eq('archived', false);

    if (error || !data?.length) return '';

    // Segmentação: Pessoais vs Materiais de Projeto
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
        // Tratamento seguro para o join do Supabase que retorna array
        const p: any = Array.isArray(i.projects) ? i.projects[0] : i.projects;
        const projInfo = p ? `(Projeto: ${p.name || p.tag})` : '';
        
        return `- ${i.item} ${projInfo}`;
      }));
    }

    return linhas.join('\n');
  },

  // Ferramentas registradas em lib/tools/defs/compras.ts
  tools: [
    'adicionar_item_lista',
    'ver_lista',
    'marcar_item_comprado',
    'listar_compras_projeto'
  ],

  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
