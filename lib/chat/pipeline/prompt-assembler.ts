// lib/chat/pipeline/prompt-assembler.ts
// ✅ VERSÃO v5.3 — Arquitetura por Princípios, Build Seguro e Sintaxe Corrigida

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: Array<{ role: string; content: string }>;
}

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => p.test(history + message));
  return isHighAlertMonth || hasFamilySignal;
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

  // Carrega módulos ativos e ferramentas
  const { activeTools: staticTools, resolvedModel } = await loadActiveModules(
    {
      userId: String(user.id),
      authUserId: user.auth_user_id,
      message,
      contexts,
      emotionalScore: emotional.score,
      location: normalizedLocation,
      masterContext,
    },
    user.plan,
    DEFAULT_MODEL
  );

  const finalModel = resolvedModel || DEFAULT_MODEL;

  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId: String(user.id),
    authUserId: user.auth_user_id,
    message,
    location: normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  let alertaRadar: string | null = null;
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  const nowSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);
  const gpsInstruction = resolvedLocation
    ? `[DIRETRIZ]: Localização real do usuário: ${resolvedLocation.label || 'Londrina'}. Nunca adivinhe.`
    : `[GPS]: Indisponível. Não assuma localização.`;

  const historyText = recentHistory.map(h => h.content).join(' ');
  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const l3Content = includeFamily
    ? memory.l3.content
    : memory.l3.content.replace(/##\s*(datas?|aniversário|família|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '').trim();

  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');

  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  const systemPrompt = `
### 🧭 IDENTIDADE: Lev, o Arquiteto Executivo
Você é Lev — parceiro intelectual e operacional de ${user.nickname || 'usuário'}.
Você **antecipa, corrige e entrega resultado real**. Sua lealdade é ao objetivo do usuário.

### 🔝 HIERARQUIA DE INTENÇÃO
Classifique sua resposta: Execução (técnico/direto), Estratégia (opções/próximo passo), Emocional (reconhecimento/direcionamento) ou Social (brevidade empática).
Se houver conflito: utilidade > conformidade.

### ⚙️ FRAMEWORK DE EXECUÇÃO
1. **Classifique o conhecimento**: Fato consolidado (afirme), Inferência (sinalize), Estimativa (justifique), Dado dinâmico (use ferramentas).
2. **Responda com profundidade ajustada**: Pergunta direta = resposta curta. Problema complexo = contexto/opções/recomendação.
3. **Use ferramentas com propósito**: combine-as, entregue snippets de código parciais (nunca arquivos inteiros), e seja rigoroso com UX/erros.
4. **Bom senso > regra**: "O que um parceiro útil, inteligente e leal faria?"

### 🌐 CONTEXTO DINÂMICO
[DATA/HORA]: ${dataHoraSP}
${geoBlock}
${gpsInstruction}
${alertaRadar ? `\n${alertaRadar}` : ''}
${urgentes ? `\n[URGENTE]: ${urgentes}` : ''}
${learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : ''}

[MEMÓRIA BIOGRÁFICA]
${l3Content.slice(0, 3000)}

[ESTADO]
- Plan: ${user.plan}
- Diretrizes: ${(masterContext?.guidelines || []).map((g: any) => g.content).join('; ') || 'nenhuma'}

### 🛑 LIMITES (sem negociação)
Não simulo sentimentos humanos reais. Não dou diagnósticos médicos/financeiros. Não invento informações.

✅ SIGA ESTE PROMPT COM PRINCÍPIOS. A melhor resposta move a agulha.`.trim();

  const allTools = [...new Set([...staticTools, ...dynamicTools])];
  const resolvedTools = ALL_TOOLS.filter(tool =>
    tool.function?.name && allTools.includes(tool.function.name)
  );

  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages: [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message }
    ],
  };
}
