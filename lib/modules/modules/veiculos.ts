// lib/modules/modules/veiculos.ts
// V12.2.0 — Tipagem rigorosa e eliminação de chamadas de rede

import type { ModuleDefinition } from '../types';

// Definimos uma interface básica para garantir a segurança no build
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
    keywords: /carro|veículo|placa|km|óleo|gasolina|etanol|manutenção|multa/i
  },
  
  buildContextBlock: async (opts) => {
    // 🛡️ Leitura segura do contexto consolidado (Zero DB Calls)
    // Assumimos que o RPC já traz 'vehicles', 'maintenances' e 'refuels' dentro do masterContext
    const vehicles: Vehicle[] = (opts as any).masterContext?.vehicles || [];
    const maintenances = (opts as any).masterContext?.maintenances || [];
    const refuels = (opts as any).masterContext?.refuels || [];

    if (!vehicles.length) return '';

    const parts = vehicles.map((v: Vehicle) => {
      // Filtramos os dados que já vieram na memória (Injetados pelo RPC)
      const vMain = maintenances.find((m: any) => m.vehicle_id === v.id);
      const vFuel = refuels.find((f: any) => f.vehicle_id === v.id);
      
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
