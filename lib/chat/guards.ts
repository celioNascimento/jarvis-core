// lib/chat/guards.ts
// Validação de userId bigint — nunca deixa UUID vazar para tabelas jarvis

export function assertNumericUserId(userId: string, caller: string): void {
    if (!/^\d+$/.test(userId)) {
      throw new Error(
        `[${caller}] FATAL: userId não é bigint numérico — recebeu: "${userId}". ` +
        `Certifique-se de passar numericUserIdStr (String(userRecord.id)) e não o UUID do Auth.`
      );
    }
  }