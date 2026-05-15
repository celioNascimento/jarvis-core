import { supabase } from '@/lib/jarvis';
import { createGoogleEvent, getGoogleContext } from '@/lib/google';
import { getMicrosoftCalendarContext } from '@/lib/microsoft';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';
// import { cancelReminderOnQStash } from '@/lib/qstash'; // Descomente se usar

export interface EventPayload {
  titulo: string;
  data_hora_inicio: string;
  data_hora_fim?: string;
  categoria?: string;
  notas?: string;
  minutos_lembrete?: number[];
  sincronizar_google?: boolean;
  forcar_conflito?: boolean;
  source?: 'lev' | 'app';
  sessionId?: string;
}

// ─── 1. CONSULTAR ─────────────────────────────────────────────────────────────
export async function coreConsultarAgenda(userId: number, dias: number = 7) {
  const [levRes, googleRes, outlookRes] = await Promise.allSettled([
    supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: userId, p_days: dias }),
    getGoogleContext().catch(() => null),
    getMicrosoftCalendarContext().catch(() => null),
  ]);
  
  const lev = (levRes.status === 'fulfilled' && levRes.value?.data) ? levRes.value.data : 'Nenhum evento na Agenda Lev.';
  let result = `[AGENDA LEV]\n${lev}`;
  if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
  if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;
  
  return result;
}

// ─── 2. CRIAR ─────────────────────────────────────────────────────────────────
export async function coreCriarEvento(userId: number, payload: EventPayload) {
  // 1. Normalização de Data e Fuso Horário
  let safeDateStr = payload.data_hora_inicio.trim().replace(' ', 'T');
  if (safeDateStr.endsWith('Z')) safeDateStr = safeDateStr.replace('Z', '-03:00');
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(safeDateStr)) safeDateStr += '-03:00';

  const startDate = new Date(safeDateStr);
  if (isNaN(startDate.getTime())) throw new Error('Data de início inválida.');

  const startISO = startDate.toISOString();
  const endISO = payload.data_hora_fim || new Date(startDate.getTime() + 3600000).toISOString();

  // 2. Prevenção de Conflitos
  if (!payload.forcar_conflito) {
    const { data: conflitos } = await supabase
      .from('events')
      .select('title, start_at')
      .eq('user_id', userId)
      .lt('start_at', endISO)
      .gt('end_at', startISO);

    if (conflitos && conflitos.length > 0) {
      throw new Error(`CONFLITO_AGENDA: Você já tem "${conflitos[0].title}" neste horário.`);
    }
  }

  // 3. Integração com Google
  let avisoGoogle = '';
  if (payload.sincronizar_google) {
    try {
      const reminderMin = payload.minutos_lembrete?.[0] ?? 30;
      await createGoogleEvent(payload.titulo, startISO, reminderMin);
      avisoGoogle = ' (Sincronizado c/ Google)';
    } catch (err: any) {
      avisoGoogle = ` (Falha Google: ${err.message})`;
    }
  }

  // 4. Persistência
  const { data: evento, error } = await supabase
    .from('events')
    .insert({
      user_id: userId,
      title: payload.titulo,
      start_at: startISO,
      end_at: endISO,
      category: payload.categoria ?? 'personal',
      notes: payload.notas ?? '',
      source: payload.source ?? 'lev',
      reminder_minutes: payload.minutos_lembrete ?? [30],
    })
    .select()
    .single();

  if (error) throw new Error(`Falha no banco: ${error.message}`);

  // 5. Invalidação de Cache
  if (payload.sessionId) {
    await invalidateMasterContextCache(userId, payload.sessionId).catch(() => {});
  }

  return { evento, avisoGoogle, startDate };
}

// ─── 3. DELETAR (Busca por texto) ─────────────────────────────────────────────
export async function coreDeletarEventoPorBusca(userId: number, busca: string, sessionId?: string) {
  const { data, error } = await supabase
    .from('events')
    .delete()
    .eq('user_id', userId)
    .ilike('title', `%${busca}%`)
    .select('title');

  if (error) throw new Error(`Falha ao deletar: ${error.message}`);
  
  if (sessionId) await invalidateMasterContextCache(userId, sessionId).catch(() => {});
  
  return data || [];
}
