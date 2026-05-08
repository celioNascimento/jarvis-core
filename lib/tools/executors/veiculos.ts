// lib/tools/executors/veiculos.ts
// Domínio: ExpertFrotas — Gestão Veicular
// Tools: registrar_abastecimento, registrar_manutencao, atualizar_odometro

import { supabase } from '@/lib/jarvis';

// ─── Helper: resolve vehicle id por nome ──────────────────────────────────────

async function resolveVehicle(
  vehicleName: string,
  numericUserId: string
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .schema('jarvis')
    .from('vehicles')
    .select('id')
    .ilike('name', vehicleName)
    .eq('user_id', numericUserId)
    .maybeSingle();
  return data ?? null;
}

// ─── registrar_abastecimento ──────────────────────────────────────────────────

export async function executeRegistrarAbastecimento(
  p: {
    vehicle_name: string;
    fuel_type: string;
    total_cost: number;
    odometer: number;
    liters?: number;
  },
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const v = await resolveVehicle(p.vehicle_name, numericUserId);
    if (!v) return `Veículo "${p.vehicle_name}" não encontrado na sua garagem.`;

    const { error } = await supabase
      .schema('jarvis')
      .from('vehicle_refueling')
      .insert({
        vehicle_id:   v.id,
        user_id:      numericUserId,
        auth_user_id: authUserId,
        fuel_type:    p.fuel_type,
        total_cost:   p.total_cost,
        odometer:     p.odometer,
        liters:       p.liters ?? null,
      });

    return error
      ? `Erro no abastecimento: ${error.message}`
      : `Abastecimento de ${p.fuel_type} (R$ ${p.total_cost}) registrado para o ${p.vehicle_name}.`;
  } catch (err: any) {
    return `Erro técnico: ${err.message}`;
  }
}

// ─── registrar_manutencao ─────────────────────────────────────────────────────

export async function executeRegistrarManutencao(
  p: {
    vehicle_name: string;
    servico?: string;
    title?: string;
    data?: string;
    odometer?: number;
    custo?: number;
  },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const v = await resolveVehicle(p.vehicle_name, numericUserId);
    if (!v) return 'Veículo não encontrado.';

    const { error } = await supabase
      .schema('jarvis')
      .from('vehicle_maintenances')
      .insert({
        vehicle_id:     v.id,
        user_id:        numericUserId,
        title:          p.servico || p.title,
        performed_date: p.data || new Date().toISOString(),
        odometer:       p.odometer,
        cost:           p.custo ?? 0,
      });

    return error
      ? `Erro na manutenção: ${error.message}`
      : `Manutenção de "${p.servico || p.title}" registrada para o ${p.vehicle_name}.`;
  } catch (err: any) {
    return `Erro técnico: ${err.message}`;
  }
}

// ─── atualizar_odometro ───────────────────────────────────────────────────────

export async function executeAtualizarOdometro(
  p: { vehicle_name: string; odometer: number },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const v = await resolveVehicle(p.vehicle_name, numericUserId);
    if (!v) return 'Veículo não encontrado.';

    await Promise.all([
      supabase.schema('jarvis').from('vehicle_odometer_logs').insert({
        vehicle_id: v.id,
        user_id:    numericUserId,
        odometer:   p.odometer,
        source:     'manual',
      }),
      supabase.schema('jarvis').from('vehicles')
        .update({ current_km: p.odometer })
        .eq('id', v.id),
    ]);

    return `Odômetro do ${p.vehicle_name} atualizado para ${p.odometer}km.`;
  } catch (err: any) {
    return `Erro no odômetro: ${err.message}`;
  }
}