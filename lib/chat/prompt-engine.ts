// lib/chat/prompt-engine.ts
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
  contextBlocks: string[]; // Blocos dos módulos
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
    brevityInstruction: opts.isLikelyNoise ? 'Curto e humano. 1-2 frases.' : (opts.detectedContexts.includes('casual') ? 'Conversa casual, máximo 3 frases.' : 'Seja direto. Sem rodeios.'),
    emotionalAttentionNote: opts.emotionalScore > 0.5 ? `⚠️ ATENÇÃO EMOCIONAL: (score ${opts.emotionalScore.toFixed(2)}). Acolha antes de resolver.` : '',
    canonicalDateTimeBlock: opts.canonicalDateTimeBlock,
    canonicalDateISO: opts.canonicalDateISO,
  });

  return `
${personality}${opts.systemWarning}

🚨 INTEGRIDADE FACTUAL — OBRIGATÓRIA 🚨
1. DATAS: Coerência com a data canônica. Nunca confirme sem verificar.
2. ANTI-SYCOPHANCY: Se o usuário disser "você errou", refaça a busca antes de concordar.
3. PESQUISA: Para fatos externos, chame searchWeb ANTES de responder.

[MÓDULOS ATIVOS]
${opts.contextBlocks.join('\n\n')}

[BÚSSOLA E DIRETRIZES]
${opts.dynamicGuidelines}

[MEMÓRIA E CONTEXTO]
${opts.memoryBlocks.truncatedL3 ? `[QUEM É ${opts.authorName.toUpperCase()}]\n${opts.memoryBlocks.truncatedL3}` : ''}
${opts.memoryBlocks.relationship}
${opts.memoryBlocks.topics}
${opts.memoryBlocks.truncatedHd ? `[LONGO PRAZO]\n${opts.memoryBlocks.truncatedHd}` : ''}
[EVENTOS]\n${opts.memoryBlocks.truncatedEvents}

${opts.intent === 'focus' ? `[MODO SUPORTE EXECUTIVO] Seja diretivo. Frases curtas. Dê apenas o PRÓXIMO PASSO.` : ''}

REGRAS OPERACIONAIS:
- FOCO: Responda o que foi perguntado.
- MODO: Factual = Direto. Desabafo = Acolha (1 frase).
- PROIBIDO: Preâmbulos ("Claro!", "Boa pergunta!"), resumir o usuário, ou dizer "Anotado/Registrado".
- SE SALVOU VIA TOOL: Use "Feito." ou "Tá na agenda."
- FAMÍLIA: Não assuma que ex-parceiros são os atuais.
- CLASSIFICAÇÃO: Inclua [CLASSE: info] ou [CLASSE: noise] ao final.
`.trim();
}
