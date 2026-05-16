// lib/services/telegram.service.ts

export async function sendTelegram(chatId: string | number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.error("[Telegram] Erro ao enviar:", e);
  }
}
