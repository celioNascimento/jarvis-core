import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';

export const ModuloVeiculos: ModuleDefinition = {
  id: 'veiculos',
  label: 'Gestão de Veículos',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['veiculos', 'logistica'],
    keywords: /carro|veículo|placa|km|manutenção|troca de óleo/i
  },
  buildContextBlock: async (opts) => {
    const { data } = await supabase.from('vehicles').select('*').eq('user_id', opts.userId);
    if (!data?.length) return '';
    return `[MÓDULO VEÍCULOS]\nVeículos registrados:\n${data.map(v => `- ${v.name} (${v.plate}): KM atual ${v.current_km}`).join('\n')}`;
  },
  tools: ['registrar_manutencao_veiculo', 'atualizar_km'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
