// lib/tools/executors/personality.ts
// V1.0.0 — Ajuste de personalidade do Lev

import { supabase } from '@/lib/jarvis';

const VALID_KEYS = ['humor', 'franqueza', 'formalidade', 'modo_escuta'];

export async function executeAjustarPersonalidade(
  p: { key: string; value: number },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  if (!VALID_KEYS.includes(p.key)) {
    return `Parâmetro "${p.key}" inválido. Opções: ${VALID_KEYS.join(', ')}.`;
  }

  if (p.value < 0 || p.value > 100) {
    return `Valor deve estar entre 0 e 100.`;
  }

  const { error } = await supabase
    .schema('jarvis')
    .from('user_settings')
    .update({ value: p.value, updated_at: new Date().toISOString() })
    .eq('user_id', Number(numericUserId))
    .eq('key', p.key);

  if (error) return `Erro ao ajustar personalidade: ${error.message}`;

  return `ok`;
}

export async function executeConsultarPersonalidade(
  _p: any,
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('user_settings')
    .select('key, value')
    .eq('user_id', Number(numericUserId));

  if (error) return `Erro ao consultar personalidade: ${error.message}`;
  if (!data?.length) return `Nenhuma configuração encontrada.`;

  const labels: Record<string, string> = {
    humor:       'Humor',
    franqueza:   'Franqueza',
    formalidade: 'Formalidade',
    modo_escuta: 'Modo escuta',
  };

  return data
    .map(row => `${labels[row.key] ?? row.key}: ${row.value}/100`)
    .join('\n');
}
