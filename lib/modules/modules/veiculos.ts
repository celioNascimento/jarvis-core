// lib/modules/modules/veiculos.ts
import { supabase } from '@/lib/jarvis';
import type { ModuleDefinition } from '../types';

export const ModuloVeiculos: ModuleDefinition = {
  id: 'veiculos',
  label: 'Gestão de Veículos (ExpertFrotas)',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['veiculos'],
    keywords: /carro|veículo|placa|km|óleo|gasolina|etanol|manutenção|multa/i
  },
  buildContextBlock: async (opts) => {
    // Busca dados consolidados dos veículos do usuário
    const vehicles = opts.masterContext?.vehicles || [];
    if (!vehicles?.length) return '';

    const vehicleIds = vehicles.map(v => v.id);

    // Busca última manutenção e abastecimento em paralelo
    const [maintenances, refuels] = await Promise.all([
      supabase.schema('jarvis').from('vehicle_maintenances').select('*').in('vehicle_id', vehicleIds).order('performed_date', { ascending: false }).limit(3),
      supabase.schema('jarvis').from('vehicle_refueling').select('*').in('vehicle_id', vehicleIds).order('refueled_at', { ascending: false }).limit(1)
    ]);

    const parts = vehicles.map(v => {
      const vMain = maintenances.data?.filter(m => m.vehicle_id === v.id)[0];
      const vFuel = refuels.data?.filter(f => f.vehicle_id === v.id)[0];
      
      return `🚗 ${v.name} (${v.plate}):
      - KM Atual: ${v.current_km}
      - Última Manutenção: ${vMain ? `${vMain.title} em ${vMain.performed_date}` : 'Sem registros'}
      - Próxima troca (prevista): ${vMain?.next_due_km || 'N/A'} km
      - Último Abastecimento: ${vFuel ? `${vFuel.fuel_type} (${vFuel.liters}L) em ${new Date(vFuel.refueled_at).toLocaleDateString()}` : 'Sem registros'}`;
    });

    return `[MODO EXPERTFROTAS]\n${parts.join('\n\n')}`;
  },
  tools: ['registrar_manutencao', 'registrar_abastecimento', 'atualizar_odometro'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
