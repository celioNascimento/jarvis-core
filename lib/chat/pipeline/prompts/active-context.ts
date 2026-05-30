// lib/chat/pipeline/prompts/active-context.ts
//
// [CONTEXTO ATIVO — FONTE PRIMÁRIA DE VERDADE]
// Data/hora, localização, alertas, urgentes, tópicos relacionados.
// Dados operacionais que mudam a cada request.

interface ActiveContextInput {
  dataHoraSP:     string;
  geoBlock:       string;
  gpsInstruction: string;
  alertaRadar:    string | null;
  urgentes:       string;
  relatedTopics:  string;
}

export function buildActiveContextPrompt(input: ActiveContextInput): string {
  const { dataHoraSP, geoBlock, gpsInstruction, alertaRadar, urgentes, relatedTopics } = input;

  const lines: string[] = [
    `[CONTEXTO ATIVO — FONTE PRIMÁRIA DE VERDADE]`,

    // ── Temporal ────────────────────────────────────────────────────────────
    `📅 Hoje é ${dataHoraSP}.`,

    // ── Grounding crítico — previne alucinações sobre eventos ao vivo ───────
    `⚠️ LIMITE DE CONHECIMENTO: Seu treinamento tem uma data de corte. Você NÃO sabe o que`,
    `aconteceu depois dela. Para qualquer pergunta sobre eventos de hoje ou recentes —`,
    `jogos, resultados, placares, notícias, lançamentos, mortes, eleições, clima —`,
    `use OBRIGATORIAMENTE a tool web_pesquisar antes de responder.`,
    `NUNCA invente times de finais, campeões, placares ou resultados. Se não pesquisar, diga que não sabe.`,

    // ── Geográfico ──────────────────────────────────────────────────────────
    geoBlock,
    `IMPORTANTE: A localização acima é real e atual. Use-a diretamente ao responder`,
    `perguntas sobre onde o usuário está. Não contradiga com base em memórias antigas.`,
  ];

  if (gpsInstruction) lines.push(gpsInstruction);
  if (alertaRadar)    lines.push(`🚨 Alerta: ${alertaRadar}`);
  if (urgentes)       lines.push(`🔴 Urgente: ${urgentes}`);
  if (relatedTopics)  lines.push(`[TÓPICOS RELACIONADOS]\n${relatedTopics}`);

  return lines.filter(Boolean).join('\n');
}