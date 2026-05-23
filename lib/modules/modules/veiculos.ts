// lib/modules/modules/veiculos.ts
// V12.4.0 — Zero DB Calls — lê exclusivamente do masterContext

import type { ModuleDefinition } from '../types';

interface Vehicle {
  id: number;
  name: string;
  plate: string;
  current_km: number;
}

export const ModuloVeiculos: ModuleDefinition = {
  id: 'veiculos',
  label: 'Gestão de Veículos (ExpertFrotas)',
  preferredModel: 'flash',
  plan: 'personal',
  trigger: {
    contexts: ['veiculos'],
    keywords: /carro|veículo|placa|km|óleo|gasolina|etanol|manutenção|multa/i,
  },

  buildContextBlock: async (opts) => {
    try {
      const vehicles: Vehicle[] = (opts as any).masterContext?.vehicles || [];
      const maintenances: any[] = (opts as any).masterContext?.vehicle_maintenances || [];
      const refuels: any[] = (opts as any).masterContext?.vehicle_refuels || [];

      if (!vehicles.length) return '';

      const parts = vehicles.map((v: Vehicle) => {
        const vMain = maintenances.find((m: any) => m.vehicle_id === v.id);
        const vFuel = refuels.find((f: any) => f.vehicle_id === v.id);

        return `🚗 ${v.name} (${v.plate}):
  - KM Atual: ${v.current_km}
  - Última Manutenção: ${vMain ? `${vMain.title} em ${vMain.performed_date}` : 'Sem registros'}
  - Próxima troca (prevista): ${vMain?.next_due_km || 'N/A'} km
  - Último Abastecimento: ${vFuel ? `${vFuel.fuel_type} (${vFuel.liters}L) em ${new Date(vFuel.refueled_at).toLocaleDateString()}` : 'Sem registros'}`;
      });

      return `[MODO EXPERTFROTAS]\n${parts.join('\n\n')}`;
    } catch (e) {
      console.error('[ModuloVeiculos] Erro no build:', e);
      return '';
    }
  },

  tools: ['registrar_manutencao', 'registrar_abastecimento', 'atualizar_odometro'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
