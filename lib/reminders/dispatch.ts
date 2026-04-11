import { supabase } from '@/lib/jarvis';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function dispatchPendingReminders(): Promise<void> {
  const { data: reminders, error } = await supabase
    .schema('jarvis')
    .from('reminders')
    .select('id, title, type, scheduled_time, user_id')
    .eq('status', 'pending')
    .in('type', ['temporary', 'agenda'])
    .lte('scheduled_time', new Date().toISOString())
    .limit(100);

  if (error) {
    console.error('[Dispatch] Erro ao buscar reminders:', error.message);
    return;
  }

  if (!reminders?.length) {
    console.log('[Dispatch] Nenhum reminder pendente.');
    return;
  }

  console.log(`[Dispatch] ${reminders.length} reminder(s) para processar.`);

  // Busca tokens em paralelo
  const withTokens = await Promise.all(
    reminders.map(async (r) => {
      const { data: user } = await supabase
        .schema('jarvis')
        .from('users')
        .select('push_token')
        .eq('id', r.user_id)
        .single();
      return { ...r, push_token: user?.push_token ?? null };
    })
  );

  const messages: ExpoPushMessage[] = [];
  const toComplete: string[] = [];
  const noToken: string[] = [];

  for (const r of withTokens) {
    console.log(`[Dispatch] reminder=${r.id} user=${r.user_id} token=${r.push_token}`);

    if (!r.push_token || !Expo.isExpoPushToken(r.push_token)) {
      console.warn(`[Dispatch] Token inválido ou ausente — reminder=${r.id}`);
      noToken.push(r.id);
      continue;
    }

    messages.push({
      to: r.push_token,
      title: '🔔 Lembrete',
      body: r.title,
      sound: 'default',
      channelId: 'reminders',
      data: { reminderId: r.id, type: r.type },
    });

    toComplete.push(r.id);
  }

  // Marca sem token como failed para não reprocessar infinitamente
  if (noToken.length) {
    await supabase
      .schema('jarvis')
      .from('reminders')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .in('id', noToken);
  }

  if (!messages.length) {
    console.log('[Dispatch] Nenhuma mensagem válida para enviar.');
    return;
  }

  // Envia em chunks e coleta erros por token
  const invalidTokens: string[] = [];
  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      receipts.forEach((receipt, i) => {
        if (receipt.status === 'error') {
          console.error(`[Dispatch] Erro no receipt [${i}]:`, receipt.message, receipt.details);
          // Token inválido — limpa para não tentar de novo
          if (
            receipt.details?.error === 'DeviceNotRegistered' ||
            receipt.details?.error === 'InvalidCredentials'
          ) {
            const badToken = chunk[i].to as string;
            invalidTokens.push(badToken);
          }
        }
      });
    } catch (err) {
      console.error('[Dispatch] Erro ao enviar chunk:', err);
    }
  }

  // Limpa tokens inválidos do banco
  if (invalidTokens.length) {
    for (const token of invalidTokens) {
      await supabase
        .schema('jarvis')
        .from('users')
        .update({ push_token: null })
        .eq('push_token', token);
    }
    console.warn(`[Dispatch] ${invalidTokens.length} token(s) inválido(s) removido(s).`);
  }

  // Marca como completed
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

  console.log(`[Dispatch] Enviados=${messages.length} Sem token=${noToken.length} Inválidos=${invalidTokens.length}`);
}