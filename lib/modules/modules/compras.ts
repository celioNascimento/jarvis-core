import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';

export const ModuloCompras: ModuleDefinition = {
  id: 'compras',
  label: 'Lista de Compras',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['compras', 'foco'],
    keywords: /comprar|lista|mercado|item|preciso de/i
  },
  buildContextBlock: async (opts) => {
    const { data } = await supabase.from('shopping_items').select('*').eq('user_id', opts.userId).eq('status', 'pending');
    if (!data?.length) return '';
    return `[MÓDULO COMPRAS]\nItens pendentes:\n${data.map(i => `- ${i.name} (Qtd: ${i.quantity || 1})`).join('\n')}`;
  },
  tools: ['adicionar_item_compra', 'marcar_item_comprado'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
