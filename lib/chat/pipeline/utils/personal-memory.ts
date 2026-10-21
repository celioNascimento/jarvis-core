// lib/chat/pipeline/utils/personal-memory.ts
// Perguntas sobre pessoas próximas: o dado já está no system prompt (masterContext),
// então o orquestrador não expõe ferramentas ao modelo e o montador de prompt não
// precisa reservar espaço para elas.

export function shouldPrefetchPersonalMemory(message: string): boolean {
  return /\b(esposa|mulher|cônjuge|filh(?:o|a|os|as)|família|mãe|pai|irm(?:ão|ã)|nome da minha)\b/i.test(message);
}
