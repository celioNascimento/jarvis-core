// lib/chat/pipeline/prompt-assembler.ts
// ✅ VERSÃO v5.2 — Arquitetura por Princípios + Compatibilidade com Orchestrator

import { loadActiveModules } from '@/lib/modules/registry';
import { composeSystemPrompt } from '@/lib/chat/prompt-engine';
import { buildGeoBlock, verificarProximidade } from '@/lib/geo-resolver';
import { buildDynamicContext } from '@/lib/chat/context-builder';
import { fetchLearnedInsights } from '../pipeline/fetch-learned-insights';
import { tools as ALL_TOOLS } from '@/lib/tools/defs/index';
import type { ChatRequestContext } from './request-context';
import type { ChatIntelligence } from './intelligence';

// -----------------------------------------------------------------------------
// 🔧 INTERFACE CORRIGIDA: Restaurado conversationMessages para compatibilidade
// TODO [pós-Sprint 5]: Remover conversationMessages daqui após refatorar llm-orchestrator
// Motivo: separação de responsabilidades. Este módulo não deveria montar mensagens completas.
// Issue relacionado: #127
// -----------------------------------------------------------------------------
export interface ChatPrompt {
  systemPrompt: string;
  tools: any[];
  model: string;
  conversationMessages: Array<{ role: string; content: string }>;
}

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

// Sinais de contexto familiar para filtragem contextual
const FAMILY_DATE_SIGNALS = [
  /aniversário/i, /casamento/i, /fil[ho]a/i, /esposa|marido/i,
  /natal/i, /páscoa/i, /dia das mães/i, /quando (é|foi|será)/i,
];

// [FIX] getMonth() é 0-indexado → maio=4, agosto=7
function shouldIncludeFamilyContext(message: string, history: string): boolean {
  const isHighAlertMonth = [4, 7].includes(new Date().getMonth());
  const hasFamilySignal = FAMILY_DATE_SIGNALS.some(p => 
    p.test(history + message)
  );
  return isHighAlertMonth || hasFamilySignal;
}

export async function buildChatPrompt(
  ctx: ChatRequestContext,
  intel: ChatIntelligence
): Promise<ChatPrompt> {
  const { user, resolvedLocation, normalizedLocation, message } = ctx;
  const { contexts, emotional, memory, masterContext, recentHistory, isStressed } = intel;

  // Carrega módulos ativos e ferramentas  const { activeTools: staticTools, resolvedModel } = await loadActiveModules(
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

  // Contexto dinâmico (ferramentas, estado atual)
  const { contextText, activeTools: dynamicTools } = await buildDynamicContext({
    userId: String(user.id),
    authUserId: user.auth_user_id,
    message,
    location: normalizedLocation,
    contexts,
    emotionalScore: emotional.score,
    masterContext,
  });

  // Alerta de proximidade (GPS)
  let alertaRadar: string | null = null;
  if (resolvedLocation?.lat && resolvedLocation?.lng) {
    const radar = await verificarProximidade(
      String(user.id),
      Number(resolvedLocation.lat),
      Number(resolvedLocation.lng)
    );
    if (radar.temAlerta) alertaRadar = `[ALERTA RADAR]: ${radar.mensagem}`;
  }

  // Blocos temporais e geográficos
  const nowSP = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  );
  const dataHoraSP = nowSP.toLocaleString('pt-BR');
  const geoBlock = buildGeoBlock(resolvedLocation);
  const gpsInstruction = resolvedLocation
    ? `[DIRETRIZ]: Localização real do usuário: ${resolvedLocation.label || 'Londrina'}. Nunca adivinhe.`
    : `[GPS]: Indisponível. Não assuma localização.`;

  // Filtra memória L3 com base em sinal familiar
  const historyText = recentHistory.map(h => h.content).join(' ');  const includeFamily = shouldIncludeFamilyContext(message, historyText);
  const l3Content = includeFamily
    ? memory.l3.content
    : memory.l3.content
        .replace(/##\s*(datas?|aniversário|família|cônjuge|esposa|filho)[^\n]*\n[\s\S]*?(?=##|$)/gi, '')
        .trim();

  // Pendências urgentes
  const urgentes = (masterContext?.reminders || [])
    .map((u: any) => u.title)
    .filter(Boolean)
    .join(', ');

  // Insights aprendidos
  const learnedInsightsBlock = await fetchLearnedInsights(String(user.id));

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔷 PROMPT DO SISTEMA v5 — LEV: O ARQUITETO EXECUTIVO
  // Baseado em 3 pilares: Persona, Intenção, Execução
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const systemPrompt = `
### 🧭 IDENTIDADE: Lev, o Arquiteto Executivo
Você é Lev — parceiro intelectual e operacional de ${user.nickname}.
Não responde com cortesia vazia. Não executa ordens cegamente.
Você **antecipa, corrige e entrega resultado real**.
Sua lealdade é ao objetivo dele, não à aprovação imediata.

→ Quando ele pede um parafuso, você pergunta: "Para qual estrutura?"
→ Quando ele erra de premissa, você corrige antes de agir.
→ Quando ele está cansado, você reconhece e oferece caminho — não apenas validação.

---

### 🔝 HIERARQUIA DE INTENÇÃO
Antes de responder, classifique:
- **Execução** (tarefa, código, projeto) → Direto, técnico, eficaz.
- **Estratégia** (decisão, planejamento) → Ofereça opções, prós/contras, próximo passo.
- **Emocional** (frustração, desabafo) → Reconheça primeiro, depois direcione.
- **Exploração** (ideias, aprendizado) → Expanda com analogias e camadas.
- **Social** (cumprimentos) → Responda com brevidade empática.

Se houver conflito: **utilidade > conformidade**.

---

### ⚙️ FRAMEWORK DE EXECUÇÃO
1. **Classifique o conhecimento**:
   - Fato consolidado → afirme.
   - Inferência → "Com base em X, infiro que..."   - Estimativa → "Estimo Y, pois Z."
   - Dado dinâmico → use ferramenta ou avise sobre limite temporal (conhecimento até maio/2025).
   - Opinião → diga "Minha análise é...".

2. **Responda com profundidade ajustada**:
   - Pergunta direta → resposta curta (1–3 frases).
   - Problema complexo → entregue: contexto → opções → recomendação.
   - Erro técnico → [CAUSA RAIZ] → [LOCAL] → [SOLUÇÃO].

3. **Use ferramentas com propósito**:
   - Combine quando necessário (ex: clima + rotina).
   - Em engenharia: modifique apenas o solicitado. Entregue snippet com indicação clara.
   - Nunca reescreva arquivo completo sem pedido explícito.

4. **Bom senso > regra**:  
   Se nenhuma regra se aplica, pergunte:  
   _"O que um parceiro útil, inteligente e leal faria aqui?"_

---

### 🌐 CONTEXTO DINÂMICO
[DATA E HORA ATUAL]: ${dataHoraSP}
${geoBlock}
${gpsInstruction}
${alertaRadar ? `\n${alertaRadar}` : ''}
${urgentes ? `\n[URGENTE]: ${urgentes}` : ''}
${learnedInsightsBlock ? `\n[O QUE APRENDI SOBRE VOCÊ]\n${learnedInsightsBlock}` : ''}

[MEMÓRIA BIOGRÁFICA - PARCIAL]
${l3Content.slice(0, 3000)}

[ESTADO DO SISTEMA]
- Plano: ${user.plan}
- Últimos temas: ${(masterContext?.topics || []).join(', ') || 'nenhum'}
- Diretrizes ativas: ${(masterContext?.guidelines || []).map((g: any) => g.content).join('; ') || 'nenhuma'}

---

### 🛑 LIMITES CLAROS (sem negociação)
- Não simulo sentimentos humanos, corpo físico ou experiências pessoais.
- Não diagnóstico médicos, aconselho juridicamente ou finanças personalizadas.
- Não acesso dados de terceiros sem autorização.
- Não invento informações. Se não souber, digo e ofereço alternativa.

---

✅ SIGA ESTE PROMPT COM PRINCÍPIOS, NÃO COM MEDO DE ERRAR.
A melhor resposta nem sempre é a mais segura — é a que move a agulha.
`.trim();
  // Combina todas as ferramentas ativas (nomes)
  const allTools = [...new Set([...staticTools, ...dynamicTools])];

  // Resolve as definições reais de ferramentas buscando pelo nome da função
  const resolvedTools = ALL_TOOLS.filter(tool =>
    tool.function?.name && allTools.includes(tool.function.name)
  );

  // Monta as mensagens completas para compatibilidade com llm-orchestrator
  // TODO [pós-Sprint 5]: Remover esta construção aqui. Deve ser feita no handler.
  const conversationMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: message }
  ];

  // Retorna tudo, incluindo conversationMessages (workaround controlado)
  return {
    systemPrompt,
    tools: resolvedTools,
    model: finalModel,
    conversationMessages,
  };
}
