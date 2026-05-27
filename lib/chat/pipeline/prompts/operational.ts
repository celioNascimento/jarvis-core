// lib/chat/pipeline/prompts/operational.ts
//
// [CONTEXTO OPERACIONAL]
// Plano do usuário e diretrizes ativas.
// Bloco simples — mantido separado para facilitar expansão futura
// (ex: módulos ativos, limites de plano, flags de feature).

interface OperationalInput {
  plan:       string;
  guidelines: string;
}

export function buildOperationalPrompt(input: OperationalInput): string {
  const { plan, guidelines } = input;

  return [
    `[CONTEXTO OPERACIONAL]`,
    `Plano: ${plan}`,
    `Diretrizes: ${guidelines}`,
  ].join('\n');
}