// lib/chat/pipeline/utils/infer-emotional-state.ts
//
// Reclassifica o estado emocional em tempo real com base nas
// últimas mensagens da conversa, antes de montar o system prompt.
//
// Não substitui a classificação persistida — ela é o piso.
// Esta função só pode elevar o estado, nunca rebaixá-lo.
// (estado crítico persistido nunca vira estável por heurística local)

import type { EmotionalState } from '../prompts/moral-mirror';

type Message = { role: string; content: string };

// ── Padrões de detecção ───────────────────────────────────────────────────────

const PATTERNS = {
  // Travamento explícito: pessoa diz que não conseguiu agir
  blocking: [
    /travei|travou|trava(da|do)/i,
    /não consigo|não tô conseguindo/i,
    /parei|não fiz|ainda não fiz/i,
    /fiquei sem (ação|reação|jeito)/i,
  ],

  // Antecipação com carga: loop aberto, ação pendente
  anticipation: [
    /vou ter que (ligar|falar|pedir|mandar|conversar)/i,
    /assim que (ela|ele|eles) (estiver|aparecer|responder)/i,
    /esperando (ela|ele|a resposta|o momento)/i,
    /quando (ela|ele) (estiver|aparecer|voltar)/i,
    /ainda não (ligou|respondeu|apareceu|voltou)/i,
  ],

  // Carga emocional difusa: nervosismo sem causa nomeada
  diffuseLoad: [
    /nervos(o|a)|ansios(o|a)|agitad(o|a)/i,
    /não tô bem|tô mal|tô pesad(o|a)/i,
    /peso no peito|aperto|sufocando/i,
    /não sei o que (fazer|pensar|sentir)/i,
  ],

  // Crise: risco imediato
  crisis: [
    /não quero mais|não aguento mais/i,
    /desaparecer|sumir|me machucar/i,
    /sem saída|não tem jeito|acabou/i,
    /me matar|me machucar|me ferir/i,
  ],
} satisfies Record<string, RegExp[]>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

function loopIsOpen(messages: Message[]): boolean {
  // Detecta se há uma intenção de ação pendente nas últimas mensagens
  // que ainda não teve desfecho (usuário não confirmou que fez)
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => m.content);

  const hasAnticipation = userMessages.some(
    m => matches(m, PATTERNS.anticipation)
  );

  const hasResolution = userMessages.some(m =>
    /já falei|já liguei|já mandei|já pedi|ela respondeu|ele respondeu|resolveu|funcionou/i.test(m)
  );

  return hasAnticipation && !hasResolution;
}

function stateOrder(s: EmotionalState): number {
  return { stable: 0, stressed: 1, vulnerable: 2, critical: 3 }[s];
}

function elevate(
  current: EmotionalState,
  candidate: EmotionalState,
): EmotionalState {
  // Só eleva — nunca rebaixa
  return stateOrder(candidate) > stateOrder(current) ? candidate : current;
}

// ── Função principal ──────────────────────────────────────────────────────────

export function inferEmotionalStateFromHistory(
  recentHistory: Message[],
  currentMessage: string,
  persistedState: EmotionalState,
): EmotionalState {
  // Pega as últimas 5 mensagens + mensagem atual
  const window = [
    ...recentHistory.slice(-5).map(m => m.content),
    currentMessage,
  ].join(' ');

  let inferred: EmotionalState = persistedState;

  // Crise sempre tem prioridade absoluta
  if (matches(window, PATTERNS.crisis)) {
    return 'critical';
  }

  // Travamento explícito → pelo menos stressed
  if (matches(window, PATTERNS.blocking)) {
    inferred = elevate(inferred, 'stressed');
  }

  // Carga emocional difusa → stressed
  if (matches(window, PATTERNS.diffuseLoad)) {
    inferred = elevate(inferred, 'stressed');
  }

  // Loop aberto (ação pendente sem desfecho) → stressed
  // Se já estava stressed por outro motivo + loop aberto → vulnerable
  if (loopIsOpen(recentHistory)) {
    const candidate: EmotionalState =
      stateOrder(inferred) >= stateOrder('stressed') ? 'vulnerable' : 'stressed';
    inferred = elevate(inferred, candidate);
  }

  return inferred;
}
