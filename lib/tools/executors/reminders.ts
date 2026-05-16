// lib/tools/executors/reminders.ts
import { coreConsultarLembretes, coreCriarLembrete, coreCancelarLembrete } from '@/lib/services/reminders.service';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

export async function executeCreateReminder(
  p: { title?: string; message?: string; type?: string; scheduled_time?: string; delay_minutes?: number; frequency?: string },
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const title = p.title ?? p.message ?? 'Lembrete';

    const result = await coreCriarLembrete(Number(targetId), authUserId, {
      title,
      type:           p.type as any,
      scheduled_time: p.scheduled_time,
      delay_minutes:  p.delay_minutes,
      frequency:      p.frequency,
    });

    await invalidateMasterContextCache(Number(targetId), sessionId);

    const hora = new Date(result.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `⏰ Lembrete "${result.title}" agendado para ${hora}.`;
  } catch (err: any) {
    return `Erro ao criar lembrete: ${err.message}`;
  }
}

export async function executeConsultarLembretes(
  _p: any,
  authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    return await coreConsultarLembretes(Number(targetId));
  } catch (err: any) {
    return `Erro ao consultar lembretes: ${err.message}`;
  }
}

export async function executeCancelarLembrete(
  p: { query: string },
  authUserId: string,
  numericUserId: string,
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const title = await coreCancelarLembrete(Number(targetId), p.query);

    await invalidateMasterContextCache(Number(targetId), sessionId);

    return title.startsWith('Nenhum') ? title : `⏰ Lembrete "${title}" cancelado.`;
  } catch (err: any) {
    return `Erro ao cancelar lembrete: ${err.message}`;
  }
}