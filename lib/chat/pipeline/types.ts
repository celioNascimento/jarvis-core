// lib/chat/pipeline/types.ts
// Tipos compartilhados por todo o pipeline de prompt

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: Array<{ role: string; content: string }>;
}

export interface SystemPromptParts {
  nickname:            string;
  dataHoraSP:          string;
  geoBlock:            string;
  gpsInstruction:      string;
  alertaRadar:         string | null;
  urgentes:            string;
  relatedTopics:       string;
  profileBlock:        string;
  learnedInsightsBlock:string;
  familyBlock:         string;
  personalityBlock:    string;
  l3Content:           string;
  plan:                string;
  guidelines:          string;
  conversationSummary: string;
  // blocos novos (espelho moral, atrito, etc.) chegam aqui quando ativados
  moralMirrorBlock?:   string;
  intellectualFrictionBlock?: string;
  emotionalProtocolBlock?:    string;
  recommendationsBlock?:      string;
  topicsBlock?:               string;
}