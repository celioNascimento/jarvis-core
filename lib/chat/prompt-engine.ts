import { buildPersonalityBlock } from './personality';

interface PromptComposeOpts {
  assistantName: string;
  authorName: string;
  canonicalDateTimeBlock: string;
  canonicalDateISO: string;
  isLikelyNoise: boolean;
  isSystemStressed: boolean;
  emotionalScore: number;
  detectedContexts: string[];
  contextBlocks: string[];
  memoryBlocks: {
    truncatedL3: string;
    truncatedHd: string;
    truncatedEvents: string;
    relationship: string;
    topics: string;
  };
  systemWarning: string;
  intent: string;
  dynamicGuidelines: string;
}

export function composeSystemPrompt(opts: PromptComposeOpts): string {
  const personality = buildPersonalityBlock({
    assistantName: opts.assistantName,
    authorName: opts.authorName,
    informalAddress: opts.memoryBlocks.truncatedL3.toLowerCase().includes('feminino') ? 'miga' : 'cara',
    brevityInstruction: opts.isLikelyNoise ? 'Curto e humano. 1-2 frases.' : 'Direto e conciso.',
    emotionalAttentionNote: opts.emotionalScore > 0.6 ? 'Priorize empatia.' : '',
    canonicalDateTimeBlock: opts.canonicalDateTimeBlock,
    canonicalDateISO: opts.canonicalDateISO,
  });

  return `
${personality}${opts.systemWarning}

[STATUS DO SISTEMA]
Stress: ${opts.isSystemStressed ? 'ATIVO' : 'Normal'}
Intenção: ${opts.intent}

[CONTEXTOS ATIVOS POR MÓDULOS]
${opts.contextBlocks.join('\n\n')}

[BÚSSOLA E DIRETRIZES]
${opts.dynamicGuidelines}

[MEMÓRIA E CONTEXTO PESSOAL]
${opts.memoryBlocks.truncatedL3 ? `[QUEM É ${opts.authorName.toUpperCase()}]\n${opts.memoryBlocks.truncatedL3}` : ''}
${opts.memoryBlocks.relationship}
${opts.memoryBlocks.topics}
${opts.memoryBlocks.truncatedHd ? `[MEMÓRIAS DE LONGO PRAZO]\n${opts.memoryBlocks.truncatedHd}` : ''}
[EVENTOS E AGENDA]\n${opts.memoryBlocks.truncatedEvents}

REGRAS OPERACIONAIS:
- FOCO: Responda o que foi perguntado.
- PROIBIDO: Preâmbulos, resumir o usuário ou dizer "Anotado".
- SE SALVOU VIA TOOL: Responda apenas "Feito." ou confirme a ação de forma curta.
- ÍCONES: Lembretes usam 🔔. Eventos de agenda usam 📅. Nunca inverta.
`.trim();
}
