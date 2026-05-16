// lib/chat/pipeline/extractors/profile.extractor.ts
// V1.1.0 — Fonte única da verdade via profile.service

import { callOpenRouter } from '@/lib/jarvis';
import {
  coreAtualizarRotina,
  coreAppendPersonalityNotes,
  coreAtualizarPerfil,
} from '@/lib/services/profile.service';

const CLEAN_JSON = (raw: string) => raw.replace(/```(?:json)?\r?\n?/g, '').trim();

// ─── ROTINA ───────────────────────────────────────────────────────────────────
export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia marcas de horários ou rituais de rotina: "${userMessage}". 
Retorne: {"despertar": null, "dormir": null, "academia_horario": null, "trabalho_entrada": null, "trabalho_saida": null}`;

  try {
    const raw    = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));

    const parts: string[] = [];
    if (parsed.despertar)        parts.push(`Despertar: ${parsed.despertar}`);
    if (parsed.dormir)           parts.push(`Dormir: ${parsed.dormir}`);
    if (parsed.academia_horario) parts.push(`Academia: ${parsed.academia_horario}`);
    if (parsed.trabalho_entrada) parts.push(`Entrada: ${parsed.trabalho_entrada}`);
    if (parsed.trabalho_saida)   parts.push(`Saída: ${parsed.trabalho_saida}`);
    if (parts.length === 0) return;

    await coreAtualizarRotina(Number(userId), `[ROTINA] ${parts.join(' | ')}`);
  } catch (e) {
    console.error('[Extrator/Rotina] Erro:', e);
  }
}

// ─── PREFERÊNCIAS ─────────────────────────────────────────────────────────────
export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia gostos, hobbies e preferências: "${userMessage}". 
Retorne: {"preferencias": [{"tipo": "comida|filme|musica|hobby", "descricao": "..."}]}`;

  try {
    const raw    = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));
    if (!parsed?.preferencias?.length) return;

    for (const p of parsed.preferencias) {
      await coreAppendPersonalityNotes(
        Number(userId),
        `[${p.tipo}] ${p.descricao}`
      );
    }
  } catch (e) {
    console.error('[Extrator/Preferencias] Erro:', e);
  }
}

// ─── DADOS BIOGRÁFICOS ────────────────────────────────────────────────────────
export async function extractDadosBiograficos(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia dados biográficos explícitos mencionados pelo usuário: "${userMessage}".
Retorne APENAS campos com valor identificado, null nos demais:
{
  "full_name": null, "birth_date": null, "birth_city": null, "birth_state": null,
  "gender": null, "father_name": null, "mother_name": null, "siblings_count": null,
  "faith_profile": null, "education_level": null, "current_job": null,
  "company": null, "profession": null, "city": null, "state": null,
  "spouse_name": null, "spouse_birthday": null, "spouse_phone": null,
  "whatsapp": null, "phone": null
}`;

  try {
    const raw    = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));

    // Remove campos nulos antes de persistir
    const payload = Object.fromEntries(
      Object.entries(parsed).filter(([_, v]) => v !== null && v !== undefined)
    );

    if (Object.keys(payload).length === 0) return;

    await coreAtualizarPerfil(Number(userId), payload);
    console.log('[Extrator/Biografico] Atualizado:', Object.keys(payload).join(', '));
  } catch (e) {
    console.error('[Extrator/Biografico] Erro:', e);
  }
}