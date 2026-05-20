// lib/modules/modules/veiculos.ts
// V12.2.0 — Tipagem rigorosa, Zero DB Calls e Fallback de Hidratação

import { supabase } from '@/lib/jarvis';
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
    keywords: /carro|veículo|placa|km|óleo|gasolina|etanol|manutenção|multa/i
  },
  
  buildContextBlock: async (opts) => {
    try {
      // 1. Tenta a Injeção de Contexto (Caminho Feliz - Zero DB Calls)
      let vehicles: Vehicle[] = (opts as any).masterContext?.vehicles;
      let maintenances = (opts as any).masterContext?.maintenances;
      let refuels = (opts as any).masterContext?.refuels;

      // 2. Fallback de Segurança (Se chamado isoladamente)
      if (!vehicles) {
        const { data } = await supabase.schema('jarvis').from('vehicles').select('*').eq('user_id', opts.userId);
        vehicles = data || [];
      }
      
      if (!vehicles.length) return '';

      if (!maintenances || !refuels) {
        const vehicleIds = vehicles.map(v => v.id);
        const [mRes, fRes] = await Promise.all([
          supabase.schema('jarvis').from('vehicle_maintenances').select('*').in('vehicle_id', vehicleIds).order('performed_date', { ascending: false }).limit(3),
          supabase.schema('jarvis').from('vehicle_refueling').select('*').in('vehicle_id', vehicleIds).order('refueled_at', { ascending: false }).limit(1)
        ]);
        maintenances = mRes.data || [];
        refuels = fRes.data || [];
      }

      // 3. Montagem do Bloco
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
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};