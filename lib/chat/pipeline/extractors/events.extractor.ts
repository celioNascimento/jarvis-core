// lib/chat/pipeline/extractors/events.extractor.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';
import { coreCriarEvento } from '@/lib/services/agenda.service';
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
    const cleanJson = raw.replace(/```(?:json)?\r?\n?/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (!parsed?.eventos || !Array.isArray(parsed.eventos)) return;

    for (const ev of parsed.eventos) {
      if (!ev.titulo || !ev.data) continue;

      const rawDateStr = String(ev.data);
      const safeDate = normalizeDate(rawDateStr);
      if (!safeDate || safeDate.length < 10) continue;

      const w = EVENT_WEIGHTS[ev.tipo] ?? EVENT_WEIGHTS.default;
      const titleClean = String(ev.titulo).trim();

      try {
        await coreCriarEvento(Number(userId), {
          titulo:           titleClean,
          data_hora_inicio: safeDate,
          categoria:        getCategoryFromType(ev.tipo),
          notas:            ev.notas ? String(ev.notas) : undefined,
          // Eventos sem hora são all_day — sem lembrete
          minutos_lembrete: [],
          source:           'lev',
          // Campos extras via metadata não suportados pelo service —
          // passamos forcar_conflito false para dedup via conflito de horário
          forcar_conflito:  false,
        });
        console.log('[Extrator/Eventos] Inserido:', titleClean);
      } catch (e: any) {
        if (e.message?.includes('CONFLITO_AGENDA')) {
          console.log('[Extrator/Eventos] Duplicata ignorada:', titleClean);
          continue;
        }
        console.error('[Extrator/Eventos] Erro ao inserir:', e.message);
      }
    }
  } catch (e) {
    console.error('[Extrator/Eventos] Erro geral:', e);
  }
}