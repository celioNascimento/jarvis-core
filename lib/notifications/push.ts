import { supabase } from '@/lib/jarvis';

export async function sendPushNotification(userId: number, title: string, body?: string): Promise<boolean> {
  // Buscar token FCM do usuário (campo fcm_token na tabela users)
  const { data: user, error } = await supabase
    .from('users')
    .select('fcm_token')
    .eq('id', userId)
    .single();

  if (error || !user?.fcm_token) {
    console.log(`[Push] Usuário ${userId} sem token FCM.`);
    return false;
  }

  const message = {
    to: user.fcm_token,
    notification: {
      title: '🔔 Lembrete',
      body: body || title,
      sound: 'default',
    },
    data: {
      type: 'reminder',
      title: title,
      click_action: 'FLUTTER_NOTIFICATION_CLICK', // para Android
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: 'reminders',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          alert: {
            title: '🔔 Lembrete',
            body: body || title,
          },
        },
      },
    },
  };

  try {
    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();

    // Tratar token inválido
    if (result.results && result.results[0]) {
      const errorCode = result.results[0].error;
      if (errorCode === 'NotRegistered' || errorCode === 'InvalidRegistration') {
        await supabase.from('users').update({ fcm_token: null }).eq('id', userId);
        console.log(`[Push] Token removido para usuário ${userId} (${errorCode})`);
        return false;
      }
    }

    if (result.failure > 0) {
      console.error('[Push] Erro FCM:', result);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Push] Exceção:', err);
    return false;
  }
}