// lib/chat/pipeline/prompts/intellectual-friction.ts
//
// [ATRITO INTELECTUAL]
// Contrapontos de pensadores reais para testar a solidez das crenças do usuário.
// Compreender ≠ concordar.
//
// Só ativa em estado estável/estressado, com throttle de 6h entre usos.

import type { EmotionalState } from './moral-mirror';

export type BeliefTradition =
  | 'christian' | 'buddhist' | 'stoic'
  | 'secular_moralist' | 'progressive' | 'conservative' | 'undefined';

interface IntellectualFrictionInput {
  enabled:         boolean;
  frictionEnabled: boolean;   // opt-in explícito do usuário
  emotionalState:  EmotionalState;
  tradition:       BeliefTradition;
  lastFrictionAt?: string;    // ISO — throttle de 6h
}

export function buildIntellectualFrictionPrompt(input: IntellectualFrictionInput): string {
  const { enabled, frictionEnabled, emotionalState, tradition, lastFrictionAt } = input;

  if (!enabled || !frictionEnabled) return '';
  if (emotionalState === 'vulnerable' || emotionalState === 'critical') return '';

  // Throttle — mínimo 6h entre contrapontos
  if (lastFrictionAt) {
    const hoursAgo = (Date.now() - new Date(lastFrictionAt).getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 6) return '';
  }

  return `
[ATRITO INTELECTUAL]
O usuário optou por receber contrapontos que desafiam sua visão de mundo.
Tradição/filosofia declarada: ${formatTradition(tradition)}

PRINCÍPIO:
Compreender não é concordar. Uma crença que nunca enfrentou resistência real é frágil.
Apresente pensadores reais que chegaram a conclusões diferentes — ou que apontam inconsistências internas.

COMO USAR UM CONTRAPONTO:
1. Nunca como sua opinião. Sempre atribuído: "X argumentou em [obra] que..."
2. Apresente o argumento com força — não uma versão enfraquecida fácil de rebater.
3. Termine com uma pergunta socrática aberta.
4. Dê espaço. Não force a conclusão.

REFERÊNCIAS PRIORITÁRIAS POR TRADIÇÃO:
${buildTraditionReferences(tradition)}

REGRA INVIOLÁVEL:
Só introduza atrito quando há chão firme — momento de reflexão, não de crise.
O atrito é o segundo movimento, nunca o primeiro.
Não invente referências. Se não tiver certeza de autor/obra, diga isso.
  `.trim();
}

function buildTraditionReferences(tradition: BeliefTradition): string {
  const refs: Record<BeliefTradition, string> = {
    christian: `
- Bertrand Russell (Por Que Não Sou Cristão) — questiona fundamentos históricos
- Nietzsche (Genealogia da Moral) — origem dos valores cristãos
- C.S. Lewis (O Problema da Dor) — fé testada pelo sofrimento real
- Pascal (Pensamentos) — a maioria crê por costume, não por exame
- Soljenítsin (Não Viver pela Mentira) — verdade como exigência moral, não conveniência
    `.trim(),

    buddhist: `
- Nietzsche (Além do Bem e do Mal) — desapego como niilismo disfarçado de virtude
- Marco Aurélio (Meditações) — ação máxima, não passividade resignada
- Viktor Frankl (Em Busca de Sentido) — sentido como resposta ao sofrimento, não fuga
    `.trim(),

    stoic: `
- Marco Aurélio (Meditações) — distinção entre desapego genuíno e evitação
- Frankl (Em Busca de Sentido) — liberdade exige responsabilidade equivalente
    `.trim(),

    secular_moralist: `
- Dostoiévski (Os Irmãos Karamazov) — se Deus não existe, onde se ancora a obrigatoriedade moral?
- Nietzsche (Genealogia da Moral) — valores seculares são herança cristã sem fundamento
- Frankl — liberdade sem responsabilidade é metade da condição humana
    `.trim(),

    progressive: `
- Roger Scruton (Conservadorismo) — identidade sem herança é identidade sem substância
- Chesterton (The Thing / O que há de errado com o mundo) — destruir sem compreender é arrogância
- Edmund Burke (Reflexões sobre a Revolução na França) — mudança sem continuidade é destruição
    `.trim(),

    conservative: `
- Burke — o conservador que não revisa também quebra o contrato com os não nascidos
- Chesterton — tradições precisam ser entendidas, não apenas preservadas
- Hannah Arendt (A Condição Humana) — perdão não é impunidade; ressentimento perpetua o passado
    `.trim(),

    undefined: `
- Viktor Frankl (Em Busca de Sentido) — sentido como escolha, não como dado
- Soljenítsin (Não Viver pela Mentira) — cumplicidade com a mentira é escolha moral
- Pascal (Pensamentos) — examine o que você acredita e por quê, sem pressão social
    `.trim(),
  };

  return refs[tradition] || refs.undefined;
}

function formatTradition(t: BeliefTradition): string {
  const map: Record<BeliefTradition, string> = {
    christian:        'Cristã',
    buddhist:         'Budista',
    stoic:            'Estoica',
    secular_moralist: 'Moralismo secular',
    progressive:      'Progressista',
    conservative:     'Conservadora',
    undefined:        'Não declarada',
  };
  return map[t];
}