// lib/notifications/push.ts — V3.0.0 (RIGOR TOTAL: Anti-Ghost + High Priority)
import { supabase } from '@/lib/jarvis';

export async function sendPushNotification(userId: number, title: string, body?: string): Promise<boolean> {
  // 1. HIDRATAÇÃO: Busca o token (garantindo o nome da coluna correto)
  const { data: user, error } = await supabase
    .from('users')
    .select('push_token') 
    .eq('id', userId)
    .single();

  if (error || !user?.push_token) {
    console.error(`[Push] Usuário ${userId} sem token ou erro no banco:`, error?.message);
    return false;
  }

  // 2. CONSTRUÇÃO DO PAYLOAD (Padrão Híbrido para Resiliência)
  // Duplicamos as informações em 'notification' e 'data' para garantir que,
  // se o sistema falhar, o App ainda consiga ler os dados.
  const message = {
    to: user.push_token,
    priority: 'high', // Prioridade no nível raiz para a API Legada
    notification: {
      title: title || '🔔 Lembrete Jarvis',
      body: body || title || 'Você tem uma nova mensagem.',
      sound: 'default',
      tag: 'jarvis_reminder', // Agrupa notificações para não poluir a tela
    },
    data: {
      type: 'reminder',
      title: title,
      body: body || title,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    // Configurações específicas para Android "gritar"
    android: {
      priority: 'high',
      notification: {
        channel_id: 'reminders', // ⚠️ DEVE existir no seu código mobile
        sound: 'default',
        default_sound: true,
        default_vibrate_timings: true,
      },
    },
  };

  try {
    // 3. ENVIO COM TIMEOUT
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
