// lib/chat/modules/recommendations.module.ts
export function buildRecommendationsBlock(masterContext: any): string {
  const recs = masterContext?.recommendations || [];
  if (!recs.length) return '';
  
  const valid = recs.filter((r: any) => r.status !== 'disliked').slice(0, 30);
  if (!valid.length) return '';

  const lines = valid.map((r: any) => `- [${r.type}] ${r.name} (${r.source})`);
  return `[RECONHECIMENTOS]\n${lines.join('\n')}`;
}