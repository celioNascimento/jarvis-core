// lib/notifications/push.ts — V3.1.0 (RIGOR TOTAL: Anti-I/O + Token Injection)
import { supabase } from '@/lib/jarvis';

export async function sendPushNotification(
  userId: number, 
  title: string, 
  body?: string,
  injectedToken?: string // [CONTRATO: Permite injeção via masterContext para evitar I/O]
): Promise<boolean> {
  
  let token = injectedToken;

  // 1. HIDRATAÇÃO CONDICIONAL (Só bate no banco se for CronJob/QStash sem contexto)
  if (!token) {
    const { data: user, error } = await supabase
      .from('users')
      .select('push_token') 
      .eq('id', userId)
      .single();

    if (error || !user?.push_token) {
      console.warn(`[Push] Usuário ${userId} sem token ou erro no banco:`, error?.message);
      return false;
    }
    token = user.push_token;
  }

  // 2. CONSTRUÇÃO DO PAYLOAD
  const message = {
    to: token,
    priority: 'high',
    notification: {
      title: title || '🔔 Lembrete Jarvis',
      body: body || title || 'Você tem uma nova mensagem.',
      sound: 'default',
      tag: 'jarvis_reminder',
    },
    data: {
      type: 'reminder',
      title: title,
      body: body || title,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: 'reminders',
        sound: 'default',
        default_sound: true,
        default_vibrate_timings: true,
      },
    },
  };

  try {
    // ⚠️ ALERTA CRÍTICO DE INFRAESTRUTURA:
    // Este endpoint legacy (fcm/send) foi desligado pelo Google. 
    // Para funcionar em 2026, você deve usar a API HTTP v1:
    // URL: https://fcm.googleapis.com/v1/projects/SEU_PROJETO/messages:send
    // Auth: Bearer <OAuth2_Token> (Não mais Server Key)
    // Se você usa React Native/Expo, considere migrar para a API do Expo Push.
    
    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();

    // 4. TRATAMENTO DE ERROS DE TOKEN
    if (result.results?.[0]?.error) {
      const errorCode = result.results[0].error;
      console.warn(`[Push] Falha FCM para o usuário ${userId}: ${errorCode}`);
      
      if (errorCode === 'NotRegistered' || errorCode === 'InvalidRegistration') {
        await supabase.from('users').update({ push_token: null }).eq('id', userId);
        console.log(`[Push] Token inválido removido.`);
      }
      return false;
    }

    if (result.failure > 0) {
      console.error('[Push] FCM retornou falha:', result);
      return false;
    }

    console.log(`[Push] ✅ Enviado com sucesso para o usuário ${userId}`);
    return true;

  } catch (err) {
    console.error('[Push] Exceção fatal no envio:', err);
    return false;
  }
}