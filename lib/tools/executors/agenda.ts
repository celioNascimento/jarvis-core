import { supabase } from '@/lib/jarvis';
import { getGoogleContext, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

export async function executeConsultarAgenda(p: { dias?: number }, authUserId: string, numericUserId: string): Promise<string> {
  const targetId = await getEffectiveUserId(authUserId, numericUserId);
  const [levRes, googleRes, outlookRes] = await Promise.allSettled([
    supabase.rpc('get_calendar_context_for_jarvis', { p_user_id: Number(targetId), p_days: p.dias ?? 7 }),
    getGoogleContext().catch(() => null),
    getMicrosoftCalendarContext().catch(() => null),
  ]);
  const lev = (levRes.status === 'fulfilled' && levRes.value.data) ? levRes.value.data : 'Nenhum evento na Agenda Lev.';
  let result = `[AGENDA LEV]\n${lev}`;
  if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
  if (outlookRes.status === 'fulfilled' && outlookRes.value) result += `\n\n[OUTLOOK]\n${outlookRes.value}`;
  return result;
}

export async function executeSalvarEvento(p: any, authUserId: string, numericUserId: string, sessionId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    // ... Lógica de parse de data ...
    const startDate = new Date(p.event_date); 
    const startISO = startDate.toISOString();
    const endISO = new Date(startDate.getTime() + 3600000).toISOString();

    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.title ?? 'Sem título',
      start_at: startISO,
      end_at: endISO,
      category: p.category ?? 'personal',
      source: 'lev'
    });
    
    if (error) throw error;
    await invalidateMasterContextCache(Number(targetId), sessionId);
    return `Evento salvo para ${startDate.toLocaleString('pt-BR')}.`;
  } catch (err: any) { return `Erro: ${err.message}`; }
}

export async function executeDeletarEvento(p: { query: string }, authUserId: string, numericUserId: string, sessionId: string): Promise<string> {
  const targetId = await getEffectiveUserId(authUserId, numericUserId);
  await supabase.from('events').delete().eq('user_id', Number(targetId)).ilike('title', `%${p.query}%`);
  await invalidateMasterContextCache(Number(targetId), sessionId);
  return `Eventos sobre "${p.query}" removidos.`;
}


// ─── 3. CRIAR EVENTO GOOGLE (EXTERNO) ─────────────────────────────────────────

export async function executeCriarEventoAgenda(
  p: { summary: string; startTime: string; reminderMinutes?: number },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes ?? 30);
  } catch (err: any) { return `Erro no Google: ${err.message}`; }
}

// ─── 4. LISTAR EMAILS ─────────────────────────────────────────────────────────

export async function executeListarEmailsRecentes(
  p: { filtro?: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) { return `Erro no Gmail: ${err.message}`; }
}

// ─── 5. EXCLUIR EMAIL ─────────────────────────────────────────────────────────

export async function executeExcluirEmail(
  p: { messageId: string },
  _authUserId: string,
  _numericUserId: string
): Promise<string> {
  try {
    return await trashGoogleEmail(p.messageId);
  } catch (err: any) { return `Erro ao excluir: ${err.message}`; }
}



