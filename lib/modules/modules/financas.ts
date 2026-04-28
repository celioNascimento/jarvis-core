import type { ModuleDefinition } from '../types';
import { buildFinanceBlock } from '@/lib/finances/db';

export const ModuloFinancas: ModuleDefinition = {
  id: 'financas',
  label: 'Finanças Pessoais',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['financas'],
    keywords: /gastei|paguei|quanto custa|saldo|dinheiro|pix/i
  },
  buildContextBlock: async (opts) => {
    try {
      const block = await buildFinanceBlock(Number(opts.userId), opts.authUserId);
      return block ? `[MÓDULO FINANÇAS]\n${block}` : '';
    } catch (e) {
      return '';
    }
  },
  tools: ['registrar_transacao', 'consultar_gastos'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
