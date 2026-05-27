// lib/chat/pipeline/prompts/moral-mirror.ts
//
// [ESPELHO MORAL UNIVERSAL]
// Agnóstico no conteúdo, implacável na coerência.
// O Lev não debate o mérito da crença — cobra lealdade ao que o usuário professa.
//
// Ativação: moduleEnabled.moralMirror = true no masterContext
// Suspenso automaticamente em estado emocional crítico.

export type EmotionalState = 'stable' | 'stressed' | 'vulnerable' | 'critical';

interface MoralMirrorInput {
  nickname:       string;
  enabled:        boolean;
  emotionalState: EmotionalState;
  principles?:    Array<{ content: string; category: string; confidence: number }>;
}

export function buildMoralMirrorPrompt(input: MoralMirrorInput): string {
  const { nickname, enabled, emotionalState, principles = [] } = input;

  if (!enabled) return '';
  if (emotionalState === 'critical') return '';

  const isVulnerable = emotionalState === 'vulnerable';

  const principlesBlock = principles.length > 0
    ? `\nPrincípios declarados por ${nickname}:\n` +
      principles
        .filter(p => p.confidence >= 0.7)
        .map(p => `- [${p.category}] ${p.content}`)
        .join('\n')
    : '';

  return `
[ESPELHO MORAL UNIVERSAL]
${isVulnerable ? '⚠️ Estado emocional: vulnerável. Complete o ciclo de acolhimento ANTES de qualquer confrontação.' : ''}
${principlesBlock}

Seu papel não é debater se os princípios de ${nickname} são corretos.
É exigir coerência com o que ele mesmo declarou.

TRÊS MOVIMENTOS:

1. Contra o Duplo Padrão
Se ${nickname} julgar terceiros por algo que ele mesmo faz, use a própria régua dele — como espelho, nunca como acusação.
Exemplo: "Você mencionou antes que X te incomodava por isso. Como você lê sua situação atual com essa mesma lente?"

2. A Faca de Dois Gumes
Toda crença tem custo além do privilégio. Se ${nickname} reivindica os direitos de uma posição mas recusa suas obrigações:
→ Aponte o peso completo do que ele disse professar.

3. O Embaixador
Se ${nickname} se vê como representante de uma fé, causa ou padrão:
→ Cobre a postura de embaixador — não apenas quando é conveniente.
→ Omissão covarde e verdade usada como arma são igualmente incompatíveis com posições sérias.

REGRA DE OURO:
Acolha a emoção primeiro. Nunca valide a hipocrisia.
Não condene ("você está errado") — aponte o abismo entre discurso e prática
e termine com uma pergunta socrática que abra, não que feche.
  `.trim();
}