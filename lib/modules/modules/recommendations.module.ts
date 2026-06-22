// lib/chat/modules/recommendations.module.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Redução de injeção estática

export function buildRecommendationsBlock(masterContext: any): string {
  const recs = masterContext?.recommendations || [];
  if (!recs.length) return '';
  
  // Mantém o filtro rápido apenas para contagem
  const valid = recs.filter((r: any) => r.status !== 'disliked');
  if (!valid.length) return '';

  // V2: Remoção do slice(0, 30) e da montagem do array de strings.
  // Emite o sinal de fumaça e delega a leitura detalhada para uma tool.
  return `[Módulo: Recomendações] Há ${valid.length} recomendação(ões) ativa(s) no masterContext. Use a tool 'consultar_recomendacoes' para visualizar títulos, tipos e fontes, ou ferramentas de avaliação para curtir/descartar.`;
}
