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

  export async function executeSalvarEvento(
  p: { 
    title?: string; 
    summary?: string; 
    event_date?: string; 
    startTime?: string; 
    category?: string; 
    notes?: string; 
    reminderMinutes?: number; 
    force?: boolean; 
  }, 
  authUserId: string, 
  numericUserId: string, 
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    // 1. Normalização da Data (Blindagem de Fuso Horário)
    const rawInput = p.event_date ?? p.startTime ?? new Date().toISOString();
    let safeDateStr = rawInput.trim().replace(' ', 'T');

    // Se a IA gerou com 'Z' (UTC), forçamos para o fuso de Brasília (-03:00)
    // Isso evita que o servidor da Vercel subtraia 3 horas do que você solicitou.
    if (safeDateStr.endsWith('Z')) {
      safeDateStr = safeDateStr.replace('Z', '-03:00');
    } else if (!/(Z|[+-]\d{2}:\d{2})$/.test(safeDateStr)) {
      safeDateStr += '-03:00';
    }

    const startDate = new Date(safeDateStr); 
    if (isNaN(startDate.getTime())) return 'Erro: data inválida gerada pela IA.';

    const startISO = startDate.toISOString();
    // Define o fim do evento por padrão para 1 hora depois do início
    const endISO = new Date(startDate.getTime() + 3600000).toISOString();

    // 2. Verificação de Conflitos (Se não for forçado)
    if (!p.force) {
      const { data: conflitos } = await supabase
        .from('events')
        .select('title, start_at')
        .eq('user_id', Number(targetId))
        .lt('start_at', endISO)
        .gt('end_at', startISO);

      if (conflitos && conflitos.length > 0) {
        return `[CONFLITO] Você já tem o evento "${conflitos[0].title}" agendado para este horário.`;
      }
    }

    // 3. Persistência no Supabase
    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.title ?? p.summary ?? 'Sem título',
      start_at: startISO,
      end_at: endISO,
      category: p.category ?? 'personal',
      notes: p.notes ?? '',
      source: 'lev',
      reminder_minutes: [p.reminderMinutes ?? 30],
    });
    
    if (error) throw error;

    // 🔥 INVALIDAÇÃO DE CACHE: Limpa o Redis para que o evento apareça no próximo MasterContext
    await invalidateMasterContextCache(Number(targetId), sessionId);

    const formattedDate = startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `Sucesso: Evento "${p.title}" salvo para ${formattedDate}.`;

  } catch (err: any) { 
    console.error('[Tool: SalvarEvento] Erro:', err.message);
    return `Erro ao salvar evento: ${err.message}`; 
  }
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



