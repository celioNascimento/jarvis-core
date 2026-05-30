// lib/utils/string.ts
//
// Utilitários puros de manipulação de strings.
// Zero dependências externas, zero side effects.

/**
 * Mascara um email para exibição segura.
 * Ex: "celio@gmail.com" → "ce***@gmail.com"
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Remove todos os caracteres não numéricos de um telefone.
 * Ex: "(43) 99999-9999" → "43999999999"
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Retorna true se a string parece um número de telefone.
 * Aceita dígitos, espaços, parênteses, hífens e +.
 */
export function isPhone(q: string): boolean {
  return /^[\d\s\(\)\-\+]{7,}$/.test(q);
}