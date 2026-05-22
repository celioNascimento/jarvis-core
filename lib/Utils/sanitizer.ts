// lib/utils/sanitizer.ts

/**
 * Padrões sensíveis compilados em cache na inicialização do módulo.
 * Evita recompilação no event loop do Node.js a cada execução da função.
 */
const SENSITIVE_PATTERNS = [
  // 1. Chaves da OpenAI (Padrões antigo 'sk-' e novo 'sk-proj-')
  /sk-[a-zA-Z0-9]{30,}/g,
  /sk-proj-[a-zA-Z0-9_-]+/g,

  // 2. Chaves do OpenRouter (Obrigatório para o llm-gateway)
  /sk-or-v1-[a-zA-Z0-9]{60,}/g,

  // 3. Chaves do Google / Gemini (Sempre começam com 'AIza')
  /AIza[0-9A-Za-z\-_]{35}/g,

  // 4. Tokens JWT (Padrão usado pelo Supabase e Vercel)
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,

  // 5. Senhas vazadas em links de banco de dados (ex: postgres://user:SENHA@banco...)
  /\/\/[^:]+:[^@]+@/g,

  // 6. Tokens de Autorização padrão (Bearer)
  /Bearer\s+[a-zA-Z0-9\-_.]+/gi
];

/**
 * Varre o texto e substitui qualquer vazamento de credenciais por um aviso seguro.
 * Deve ser usado antes de salvar históricos no banco ou em logs do servidor.
 */
export function sanitizeSensitiveData(text: string): string {
  if (!text) return text;

  let sanitizedText = text;

  // Usa o array em memória (O(1) para inicialização da Regex)
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitizedText = sanitizedText.replace(pattern, '[DADO_PROTEGIDO]');
  }

  return sanitizedText;
}
