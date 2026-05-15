// lib/chat/pipeline/extractors/events.extractor.ts
// V1.0.2 — Correção de regex, campo notas e .schema('jarvis')

import { supabase, callOpenRouter } from '@/lib/jarvis';
import { getCategoryFromType, normalizeDate } from './helpers';

const EVENT_WEIGHTS: Record<string, { priority: string; decay_type: string; emotional_weight: number }> = {
  aniversario_proprio:   { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_casamento: { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 1.00 },
  aniversario_esposa:    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_marido:    { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.95 },
  aniversario_filho:     { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.90 },
  aniversario_familiar:  { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  aniversario_amigo:     { priority: 'media', decay_type: 'recurring_annual', emotional_weight: 0.50 },
  natal:                 { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.85 },
  pascoa:                { priority: 'alta',  decay_type: 'recurring_annual', emotional_weight: 0.80 },
  default:               { priority: 'media', decay_type: 'one_time',        emotional_weight: 0.50 },
};

export async function extractEvento(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();

  const prompt = [
    {
      role: 'system',
      content: 'Você é um parser de eventos. Responda exclusivamente com JSON estruturado, sem blocos markdown.',
    },
    {
      role: 'user',
      content: `Extraia eventos ou datas comemorativas (SEM hora específica) de: "${userMessage}".
Retorne: {"eventos": [{"titulo": "Aniversário Celio", "data": "YYYY-MM-DD", "tipo": "aniversario_proprio|aniversario_esposa|natal|default", "recorrente": true, "notas": null}]}
Ano base: ${anoAtual}`,
    },
  ];

  try {
    const raw = await callOpenRouter(prompt as any, 'google/gemini-2.0-flash-001', 0.1, 4);

    // Remove blocos markdown caso o modelo os inclua mesmo sendo instruído a não
    const cleanJson = raw.replace(/```(?:json)?\r?\n?/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (!parsed?.eventos || !Array.isArray(parsed.eventos)) return;

    for (const ev of parsed.eventos) {
      if (!ev.titulo || !ev.data) continue;

      const rawDateStr = String(ev.data);
      const safeDate = normalizeDate(rawDateStr);
      if (!safeDate || safeDate.length < 10) continue;

      const w = EVENT_WEIGHTS[ev.tipo] ?? EVENT_WEIGHTS.default;
      const mmdd = safeDate.slice(5);
      const titleClean = String(ev.titulo).trim();

      // Verifica duplicidade dentro da schema correta
      const { data: existing } = await supabase
        .schema('jarvis')
        .from('events')
        .select('id')
        .eq('user_id', userId)
        .like('start_at', `%-${mmdd}`)
        .ilike('title', titleClean)
        .maybeSingle();

      if (!existing) {
        await supabase
          .schema('jarvis')
          .from('events')
          .insert({
            user_id:          userId,
            title:            titleClean,
            start_at:         safeDate,
            category:         getCategoryFromType(ev.tipo),
            priority:         w.priority,
            decay_type:       w.decay_type,
            emotional_weight: w.emotional_weight,
            is_recurring:     ev.recorrente ?? w.decay_type === 'recurring_annual',
            notes:            ev.notas ? String(ev.notas) : null, // campo correto: notas
            relevance_score:  1.0,
          });

        console.log('[Extrator/Eventos] Inserido:', titleClean);
      } else {
        console.log('[Extrator/Eventos] Duplicata ignorada:', titleClean);
      }
    }
  } catch (e) {
    console.error('[Extrator/Eventos] Erro ao processar:', e);
  }
}