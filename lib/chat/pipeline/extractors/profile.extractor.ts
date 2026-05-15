// lib/chat/pipeline/extractors/profile.extractor.ts
// V1.0.1 — Regex corrigida, preferências movidas para personality_notes

import { supabase, callOpenRouter } from '@/lib/jarvis';

const CLEAN_JSON = (raw: string) => raw.replace(/```(?:json)?\r?\n?/g, '').trim();

export async function extractRotina(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia marcas de horários ou rituais de rotina: "${userMessage}". Retorne: {"despertar": null, "dormir": null, "academia_horario": null, "trabalho_entrada": null, "trabalho_saida": null, "lembretes": []}`;

  try {
    const raw = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));

    const parts: string[] = [];
    if (parsed.despertar)        parts.push(`Despertar: ${parsed.despertar}`);
    if (parsed.dormir)           parts.push(`Dormir: ${parsed.dormir}`);
    if (parsed.academia_horario) parts.push(`Academia: ${parsed.academia_horario}`);
    if (parsed.trabalho_entrada) parts.push(`Entrada: ${parsed.trabalho_entrada}`);
    if (parsed.trabalho_saida)   parts.push(`Saída: ${parsed.trabalho_saida}`);
    if (parts.length === 0) return;

    const { data: prof } = await supabase
      .from('user_profiles')
      .select('personality_notes')
      .eq('user_id', userId)
      .maybeSingle();

    const old = prof?.personality_notes || '';
    const newBlock = `[ROTINA] ${parts.join(' | ')}`;
    const updated = /\[ROTINA\]/i.test(old)
      ? old.replace(/\[ROTINA\][^\n]*/i, newBlock)
      : `${old}\n${newBlock}`.trim();

    await supabase.from('user_profiles').upsert(
      { user_id: userId, personality_notes: updated, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch (e) {
    console.error('[Extrator/Rotina] Erro:', e);
  }
}

export async function extractPreferencia(userId: string, userMessage: string): Promise<void> {
  const prompt = `Extraia gostos, hobbies e preferências: "${userMessage}". Retorne: {"preferencias": [{"tipo": "comida|filme|musica|hobby", "descricao": "..."}]}`;

  try {
    const raw = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));
    if (!parsed?.preferencias || parsed.preferencias.length === 0) return;

    const { data: prof } = await supabase
      .from('user_profiles')
      .select('personality_notes')
      .eq('user_id', userId)
      .maybeSingle();

    const old = prof?.personality_notes || '';

    // Evita duplicata checando a primeira preferência extraída
    if (old.includes(parsed.preferencias[0].descricao)) return;

    const newLine = parsed.preferencias
      .map((p: any) => `[${p.tipo}] ${p.descricao}`)
      .join(' | ');

    await supabase.from('user_profiles').upsert(
      {
        user_id:           userId,
        personality_notes: old ? `${old} | ${newLine}` : newLine,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  } catch (e) {
    console.error('[Extrator/Preferencias] Erro:', e);
  }
}