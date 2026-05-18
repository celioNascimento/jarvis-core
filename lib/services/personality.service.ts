// lib/services/personality.service.ts
// V1.0.0 — Parâmetros de personalidade do Lev por usuário

import { supabase } from '@/lib/jarvis';

export interface PersonalitySettings {
  humor: number;
  franqueza: number;
  formalidade: number;
  modo_escuta: number;
}

const DEFAULTS: PersonalitySettings = {
  humor:       50,
  franqueza:   80,
  formalidade: 20,
  modo_escuta: 70,
};

export async function getPersonalitySettings(userId: number): Promise<PersonalitySettings> {
  const { data, error } = await supabase
    .schema('jarvis')
    .from('user_settings')
    .select('key, value')
    .eq('user_id', userId);

  if (error || !data?.length) return DEFAULTS;

  const settings = { ...DEFAULTS };
  for (const row of data) {
    if (row.key in settings) {
      (settings as any)[row.key] = row.value;
    }
  }
  return settings;
}

export function buildPersonalityBlock(s: PersonalitySettings): string {
  const lines: string[] = [];

  // Humor
  if (s.humor <= 20) {
    lines.push('Tom sério. Humor apenas se o usuário iniciar.');
  } else if (s.humor <= 50) {
    lines.push('Humor leve e pontual — na hora certa, sem forçar.');
  } else if (s.humor <= 80) {
    lines.push('Humor presente e natural. Use quando o clima permitir.');
  } else {
    lines.push('Humor alto. Seja descontraído, use ironia com cuidado.');
  }

  // Franqueza
  if (s.franqueza <= 20) {
    lines.push('Seja diplomático. Suavize feedback difícil.');
  } else if (s.franqueza <= 50) {
    lines.push('Equilibre honestidade e tato.');
  } else if (s.franqueza <= 80) {
    lines.push('Seja direto. Diga o que pensa, mesmo quando desconfortável.');
  } else {
    lines.push('Franqueza máxima. Verdade sem rodeios, sempre.');
  }

  // Formalidade
  if (s.formalidade <= 20) {
    lines.push('Tom casual e próximo — como um amigo que entende do assunto.');
  } else if (s.formalidade <= 50) {
    lines.push('Tom neutro — profissional sem ser distante.');
  } else if (s.formalidade <= 80) {
    lines.push('Tom mais formal. Evite gírias e informalidades.');
  } else {
    lines.push('Tom completamente formal. Linguagem estruturada e precisa.');
  }

  // Modo escuta
  if (s.modo_escuta <= 20) {
    lines.push('Foco em execução. Responda com soluções e ações.');
  } else if (s.modo_escuta <= 50) {
    lines.push('Equilibre escuta e execução conforme o contexto.');
  } else if (s.modo_escuta <= 80) {
    lines.push('Priorize presença em momentos emocionais. Solução vem depois.');
  } else {
    lines.push('Modo escuta ativo. Esteja presente antes de qualquer ação.');
  }

  return `[PERSONALIDADE CALIBRADA]\n${lines.map(l => `- ${l}`).join('\n')}`;
}