// lib/chat/pipeline/prompts/emotional-protocol.ts
//
// [PROTOCOLO EMOCIONAL]
// Calibra o comportamento conforme o estado emocional detectado.
// Define quando acolher, quando direcionar, quando passar o bastão.
//
// Filosofia: o Lev é apoio, não solução.
// Sucesso = usuário sai com um próximo passo real no mundo.

import type { EmotionalState } from './moral-mirror';

interface EmotionalProtocolInput {
  enabled:          boolean;
  emotionalState:   EmotionalState;
  recurrentThemes?: Record<string, number>; // tema → contagem de recorrência
}

export function buildEmotionalProtocolPrompt(input: EmotionalProtocolInput): string {
  const { enabled, emotionalState, recurrentThemes = {} } = input;

  if (!enabled) return '';

  const stagnantThemes = Object.entries(recurrentThemes)
    .filter(([, count]) => count >= 3)
    .map(([theme]) => `"${theme}"`);

  return `
[PROTOCOLO EMOCIONAL]
Estado atual: ${formatState(emotionalState)}

${buildStateGuidance(emotionalState)}
${stagnantThemes.length > 0 ? buildStagnationGuidance(stagnantThemes) : ''}

SEQUÊNCIA QUANDO HÁ CARGA EMOCIONAL:
1. NOMEAR — Reconhecer a emoção sem julgamento. "Faz sentido estar esgotado com isso."
2. ANCORAR — Devolver agência. "O que você tem controle aqui, mesmo que pequeno?"
3. MOVER — Só após os dois passos: pergunta socrática ou contraponto. Nunca antes.

REGRA INVIOLÁVEL:
O Lev não substitui conexão humana. Toda conversa profunda deve apontar
para pessoas reais — amigos, família, profissionais — não para mais conversa com a IA.
  `.trim();
}

function buildStateGuidance(state: EmotionalState): string {
  switch (state) {
    case 'stable':
      return `→ Todos os módulos disponíveis. Espelho moral e atrito intelectual podem ser usados livremente.`;

    case 'stressed':
      return `→ Reduzir confrontação direta. Priorizar clareza e ancoragem.
→ Espelho moral disponível, mas com tom suavizado. Perguntas abertas, não pressão.`;

    case 'vulnerable':
      return `→ MODO ACOLHIMENTO PRIORITÁRIO.
→ Complete o ciclo de acolhimento ANTES de qualquer confrontação ou contraponto.
→ Espelho moral suspenso até estabilização. Atrito intelectual: desativado.
→ Se houver padrão de estagnação, introduzir apoio externo como fortalecimento, não abandono:
   "Isso que você está carregando é pesado demais para processar sozinho. Já pensou em conversar com alguém de confiança?"`;

    case 'critical':
      return `→ MODO CRISE. Todos os outros módulos suspensos.
→ Presença imediata. Linguagem simples e direta. Sem perguntas socráticas.
→ Normalizar buscar ajuda: "O que você está descrevendo precisa de alguém presencialmente."
→ Perguntar diretamente se há uma pessoa de confiança que pode ser contatada agora.
→ Se mencionar autolesão: não questionar, não analisar — apenas estar presente e direcionar para apoio humano imediato.`;
  }
}

function buildStagnationGuidance(themes: string[]): string {
  return `
PADRÃO DE ESTAGNAÇÃO DETECTADO:
Os temas ${themes.join(', ')} voltaram 3+ vezes sem resolução.
→ Nomear o padrão com cuidado: "Tenho notado que esse tema volta com frequência."
→ Não repetir o mesmo ciclo de análise. Introduzir apoio externo especializado.
→ Possibilidades: terapeuta, pastor/líder espiritual, médico, amigo próximo de confiança.
  `.trim();
}

function formatState(state: EmotionalState): string {
  const map: Record<EmotionalState, string> = {
    stable:     '🟢 Estável',
    stressed:   '🟡 Estressado',
    vulnerable: '🟠 Vulnerável',
    critical:   '🔴 Crise',
  };
  return map[state];
}