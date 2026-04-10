import { supabase } from '@/lib/jarvis';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function dispatchPendingReminders(): Promise<void> {
  const { data: reminders, error } = await supabase
    .schema('jarvis')
    .from('reminders')
    .select('id, title, type, frequency, scheduled_time, user_id')
    .eq('status', 'pending')
    .in('type', ['temporary', 'agenda'])
    .lte('scheduled_time', new Date().toISOString())
    .limit(100);

  if (error) {
    console.error('[Dispatch] Erro ao buscar reminders:', error.message);
    return;
  }

  if (!reminders?.length) return;

  const messages: ExpoPushMessage[] = [];
  const toComplete: string[] = [];

  for (const r of reminders) {
    // Busca token diretamente — evita problema de join cross-schema
    const { data: user } = await supabase
      .schema('jarvis')
      .from('users')
      .select('push_token')
      .eq('id', r.user_id)
      .single();

    const token = user?.push_token;
    console.log('[Dispatch] reminder:', r.id, 'token:', token);

    if (!token || !Expo.isExpoPushToken(token)) {
      console.warn('[Dispatch] Token inválido ou ausente para reminder:', r.id);
      continue;
    }

    messages.push({
      to: token,
      title: '🔔 Lembrete',
      body: r.title,
      sound: 'default',
      data: { reminderId: r.id, type: r.type },
    });

    toComplete.push(r.id);
  }

  if (!messages.length) {
    console.log('[Dispatch] Nenhuma mensagem válida para enviar.');
    return;
  }

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === 'error') {
          console.error('[Dispatch] Erro no receipt:', receipt.message, receipt.details);
        }
      }
    } catch (err) {
      console.error('[Dispatch] Erro ao enviar chunk:', err);
    }
  }

  if (toComplete.length) {
    const { error: updateError } = await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .in('id', toComplete);

    if (updateError) {
      console.error('[Dispatch] Erro ao atualizar status:', updateError.message);
    }
  }

  console.log(`[Dispatch] Enviados: ${messages.length}`);
}