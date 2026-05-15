// lib/tools/executors/agenda.ts
// V10.2.0 — Executores da Agenda (PT-BR, Sem E-mails, Consolidado com Google)

import { supabase } from '@/lib/jarvis';
import { getGoogleContext, createGoogleEvent } from '@/lib/google'; // E-mails removidos daqui
import { getMicrosoftCalendarContext } from '@/lib/microsoft'; // getRecentEmails removido daqui
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

// ─── 1. CONSULTAR ─────────────────────────────────────────────────────────────

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

// ─── 2. SALVAR (Lev + Google Consolidado) ─────────────────────────────────────

export async function executeSalvarEvento(
  p: { 
    titulo: string; 
    data_hora: string; 
    categoria?: string; 
    notas?: string; 
    minutos_lembrete?: number; 
    sincronizar_google?: boolean;
    forcar?: boolean; 
  }, 
  authUserId: string, 
  numericUserId: string, 
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    // 1. Normalização da Data (Blindagem de Fuso Horário Vercel)
    const rawInput = p.data_hora ?? new Date().toISOString();
    let safeDateStr = rawInput.trim().replace(' ', 'T');

    if (safeDateStr.endsWith('Z')) {
      safeDateStr = safeDateStr.replace('Z', '-03:00');
    } else if (!/(Z|[+-]\d{2}:\d{2})$/.test(safeDateStr)) {
      safeDateStr += '-03:00';
    }

    const startDate = new Date(safeDateStr); 
    if (isNaN(startDate.getTime())) return 'Erro: data inválida gerada pela IA.';

    const startISO = startDate.toISOString();
    const endISO = new Date(startDate.getTime() + 3600000).toISOString(); // +1 hora

    // 2. Verificação de Conflitos
    if (!p.forcar) {
      const { data: conflitos } = await supabase
        .from('events')
        .select('title, start_at')
        .eq('user_id', Number(targetId))
        .lt('start_at', endISO)
        .gt('end_at', startISO);

      if (conflitos && conflitos.length > 0) {
        return `[CONFLITO] Você já tem o evento "${conflitos[0].title}" agendado para este horário. Use 'forcar: true' se quiser sobrepor.`;
      }
    }

    // 3. Integração Google (Opcional)
    let avisoGoogle = '';
    if (p.sincronizar_google) {
      try {
        await createGoogleEvent(p.titulo, startISO, p.minutos_lembrete ?? 30);
        avisoGoogle = ' (Sincronizado com Google Calendar)';
      } catch (err: any) {
        avisoGoogle = ` (Aviso: Falha ao sincronizar com Google: ${err.message})`;
      }
    }

    // 4. Persistência no Supabase (Fonte da Verdade)
    const { error } = await supabase.from('events').insert({
      user_id: Number(targetId),
      title: p.titulo,
      start_at: startISO,
      end_at: endISO,
      category: p.categoria ?? 'personal',
      notes: p.notas ?? '',
      source: 'lev',
      reminder_minutes: [p.minutos_lembrete ?? 30],
    });
    
    if (error) throw error;

    // 🔥 Invalidação de Cache
    await invalidateMasterContextCache(Number(targetId), sessionId);

    const formattedDate = startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `📅 Sucesso: Evento "${p.titulo}" salvo para ${formattedDate}.${avisoGoogle}`;

  } catch (err: any) { 
    console.error('[Tool: SalvarEvento] Erro:', err.message);
    return `Erro ao salvar evento: ${err.message}`; 
  }
}

// ─── 3. DELETAR ───────────────────────────────────────────────────────────────

export async function executeDeletarEvento(
  p: { busca: string }, 
  authUserId: string, 
  numericUserId: string, 
  sessionId: string
): Promise<string> {
  const targetId = await getEffectiveUserId(authUserId, numericUserId);
  
  const { data, error } = await supabase
    .from('events')
    .delete()
    .eq('user_id', Number(targetId))
    .ilike('title', `%${p.busca}%`)
    .select('title');

  if (error) return `Erro ao deletar: ${error.message}`;
  
  await invalidateMasterContextCache(Number(targetId), sessionId);
  
  if (data && data.length > 0) {
    return `🗑️ ${data.length} evento(s) sobre "${p.busca}" removido(s).`;
  }
  return `Nenhum evento encontrado com o termo "${p.busca}".`;
}
