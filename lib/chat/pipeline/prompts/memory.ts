// lib/chat/pipeline/prompts/memory.ts
//
// [MEMÓRIA E PERFIL] — tudo que o Lev sabe sobre o usuário:
// insights aprendidos, perfil pessoal, família, personalidade,
// memória ativa (L3/dossiê), resumo da conversa atual.

interface MemoryPromptInput {
  learnedInsightsBlock: string;
  profileBlock:         string;
  familyBlock:          string;
  personalityBlock:     string;
  l3Content:            string;
  conversationSummary:  string;
  recommendationsBlock?: string;
  topicsBlock?:          string;
}

export function buildMemoryPrompt(input: MemoryPromptInput): string {
  const {
    learnedInsightsBlock,
    profileBlock,
    familyBlock,
    personalityBlock,
    l3Content,
    conversationSummary,
    recommendationsBlock,
    topicsBlock,
  } = input;

  const blocks: string[] = [];

  blocks.push(`[MEMÓRIA E PERFIL]\nUse os dados abaixo para conectar o que o usuário trouxe ao que você já sabe sobre ele. Atualize mentalmente hábitos, projetos e preferências sem comentar sobre isso.`);

  if (learnedInsightsBlock) blocks.push(`[PERFIL APRENDIDO]\n${learnedInsightsBlock}`);
  if (profileBlock)         blocks.push(profileBlock);
  if (familyBlock)          blocks.push(familyBlock);
  if (personalityBlock)     blocks.push(personalityBlock);
  if (recommendationsBlock) blocks.push(recommendationsBlock);
  if (topicsBlock)          blocks.push(topicsBlock);

  if (conversationSummary) {
    blocks.push(
      `[CONVERSA ATUAL — LEIA ANTES DE RESPONDER]\nOs fatos abaixo foram ditos agora mesmo nessa conversa. Não pergunte o que já foi dito aqui.\n${conversationSummary}`
    );
  }

  if (l3Content) {
    blocks.push(`[MEMÓRIA ATIVA]\n${l3Content}`);
  }

  return blocks.filter(Boolean).join('\n\n');
}