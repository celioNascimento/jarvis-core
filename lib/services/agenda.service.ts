// lib/services/agenda.service.ts
// V1.0.0 — Fonte Única da Verdade para Eventos

import { supabase } from '@/lib/jarvis';
import { createGoogleEvent } from '@/lib/google';

export interface EventPayload {
  titulo: string;
  data_hora_inicio: string; // ISO String
  data_hora_fim?: string;   // ISO String (Opcional)
  categoria?: string;
  notas?: string;
  minutos_lembrete?: number[];
  sincronizar_google?: boolean;
  forcar_conflito?: boolean;
  source?: 'lev' | 'app';
}

export async function coreCriarEvento(userId: number, payload: EventPayload) {
  // 1. Normalização de Data (Blindagem de Fuso Horário -03:00)
  let safeDateStr = payload.data_hora_inicio.trim().replace(' ', 'T');
  if (safeDateStr.endsWith('Z')) {
    safeDateStr = safeDateStr.replace('Z', '-03:00');
  } else if (!/(Z|[+-]\d{2}:\d{2})$/.test(safeDateStr)) {
    safeDateStr += '-03:00';
  }

  const startDate = new Date(safeDateStr);
  if (isNaN(startDate.getTime())) throw new Error('Data de início inválida.');

  const startISO = startDate.toISOString();
  // Se não vier hora de fim (da IA, por exemplo), define para 1h depois
  const endISO = payload.data_hora_fim || new Date(startDate.getTime() + 3600000).toISOString();

  // 2. Prevenção de Conflitos
  if (!payload.forcar_conflito) {
    const { data: conflitos } = await supabase
      .schema('jarvis')
      .from('events')
      .select('title, start_at')
      .eq('user_id', userId)
      .lt('start_at', endISO)
      .gt('end_at', startISO);

    if (conflitos && conflitos.length > 0) {
      throw new Error(`CONFLITO_AGENDA: Você já tem o evento "${conflitos[0].title}" agendado para este horário.`);
    }
  }

  // 3. Integração com Google (Opcional)
  let avisoGoogle = '';
  if (payload.sincronizar_google) {
    try {
      const reminderMin = payload.minutos_lembrete?.[0] ?? 30;
      await createGoogleEvent(payload.titulo, startISO, reminderMin);
      avisoGoogle = ' (Sincronizado com Google)';
    } catch (err: any) {
      avisoGoogle = ` (Falha Google: ${err.message})`;
    }
  }

  // 4. Persistência no Banco de Dados
  const { data: evento, error } = await supabase
    .schema('jarvis')
    .from('events')
    .insert({
      user_id: userId,
      title: payload.titulo,
      start_at: startISO,
      end_at: endISO,
      category: payload.categoria ?? 'personal',
      description: payload.notas ?? '',
      source: payload.source ?? 'lev',
      reminder_minutes: payload.minutos_lembrete ?? [30],
    })
    .select()
    .single();

  if (error) throw new Error(`Falha no banco: ${error.message}`);

  return { evento, avisoGoogle, startDate };
}
