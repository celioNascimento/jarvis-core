// lib/chat/pipeline/llm-orchestrator.ts
// V12.0.0 — Orquestrador Multi-Steps com Roteador MoE por Intenção

import { callOpenRouterWithPriority } from '@/lib/chat/llm-gateway';
import { executeTool } from '@/lib/chat/tools-executor';
import { supabase } from '@/lib/jarvis';
import type { ChatRequestContext } from './request-context';
import type { ChatPrompt } from './types';

// ── Tipos Explícitos ─────────────────────────────────────────────────────────

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-stringified
  };
};

export type ChatMessage =
  | { role: 'system'; content: string | null }
  | { role: 'user'; content: string | null }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LLMResponse = {
  content: string | null;
  toolCalls?: ToolCall[];
  modelUsed: string;
};

interface ToolCallResult {
  tc: ToolCall;
  result: string;
}

// ── Roteador MoE ─────────────────────────────────────────────────────────────

type RouterIntent = 'emocional' | 'factual' | 'acao' | 'recuperacao' | 'hibrido';

interface RouterResult {
  intent: RouterIntent;
  fragments: number;
  needs_rag: boolean;
  escalate: boolean;
  resolution_confidence: number;
  ambiguous: boolean;
  entities: { x: string | null; y: string | null; z: string | null };
  reason?: string | null;
}

// Fallback caso o banco esteja indisponível
const FALLBACK_MODEL_MAP: Record<RouterIntent, string> = {
  emocional:   'google/gemini-2.5-flash',
  factual:     'google/gemini-2.5-flash',
  acao:        'google/gemini-2.5-flash',
  recuperacao: 'google/gemini-2.5-flash',
  hibrido:     'anthropic/claude-sonnet-4.6',
};

// Traduz alias do banco para model ID do OpenRouter
const ALIAS_TO_MODEL: Record<string, string> = {
  'flash-25':      'google/gemini-2.5-flash',
  'claude-sonnet': 'anthropic/claude-sonnet-4.6',
  'flash-lite':    'google/gemini-3.1-flash-lite-preview',
  'qwen-8b':       'qwen/qwen3-8b',
  'llama-8b':      'meta-llama/llama-3.1-8b-instruct',
};

function buildRouterPrompt(input: string, lastTurn: string | null): string {
  const ctx = lastTurn
    ? `\nContexto da mensagem anterior:\n[1] ${lastTurn}\n`
    : '';

  return `Você é um roteador de intenções de um assistente pessoal. Retorne APENAS JSON válido, sem markdown.
${ctx}
Mensagem atual: "${input}"

Categorias:
- "emocional": desabafo, sentimento — sem ação ou busca
- "factual": conhecimento geral público — nunca busca memória pessoal
- "acao": comando explícito — salvar, lembrar, registrar, marcar
- "recuperacao": busca em memória PESSOAL do usuário — o que EU disse/decidi/gastei
- "hibrido": mais de uma categoria na mesma mensagem

Regras:
- needs_rag: true somente para recuperacao ou hibrido com busca pessoal
- escalate: true somente se pronome sem antecedente claro
- factual nunca tem needs_rag=true nem escalate=true

{"intent":"","fragments":1,"needs_rag":false,"escalate":false,"resolution_confidence":0.9,"ambiguous":false,"entities":{"x":null,"y":"","z":""},"reason":null}`;
}

async function getBestModelForCategory(intent: RouterIntent): Promise<string> {
  try {
    const { data } = await supabase
      .from('router_best_model_per_category')
      .select('model_alias')
      .eq('category', intent)
      .single();

    return ALIAS_TO_MODEL[data?.model_alias ?? ''] ?? FALLBACK_MODEL_MAP[intent];
  } catch {
    return FALLBACK_MODEL_MAP[intent];
  }
}

async function resolveModelByIntent(
  message: string,
  lastTurn: string | null,
  requestedModel: string
): Promise<{ model: string; routerResult: RouterResult | null }> {
  try {
    const prompt = buildRouterPrompt(message, lastTurn);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        max_tokens: 200,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON não encontrado na resposta do roteador');

    const routerResult: RouterResult = JSON.parse(
      jsonMatch[0].replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
    );

    // Confiança baixa → mantém modelo original sem alterar
    if (routerResult.resolution_confidence < 0.6) {
      console.log(`[Router] ⚠️ Confiança baixa (${routerResult.resolution_confidence}) — usando modelo padrão`);
      return { model: requestedModel, routerResult };
    }

    const model = await getBestModelForCategory(routerResult.intent);
    console.log(`[Router] ✓ intent=${routerResult.intent} conf=${routerResult.resolution_confidence} → ${model}`);

    return { model, routerResult };
  } catch (err) {
    console.error('[Router] Falha no roteamento — usando modelo padrão:', err);
    return { model: requestedModel, routerResult: null };
  }
}

// ── Padrões Estritos de Intenção Ativa ────────────────────────────────────────

const IMPERATIVE_INTENT_PATTERNS = [
  /(?:me\s+)?lembr[ae]|crie\s+(?:um\s+)?lembrete|me\s+avisa|notifica|daqui\s+a\s+\d+/i,
  /cancela.*(lembrete|aviso|evento|compromisso)/i,
  /agend[ae]|marqu?e|insira.*agenda|consulta\s+amanhã|reunião\s+às/i,
  /(?:quais|listar)\s+(?:são\s+os\s+)?(?:lembretes|compromissos|tarefas)\s+(?:ativos|pendentes|de\s+hoje)/i,
  /apaga.*evento|deleta.*evento|remove.*evento/i,
];

function resolveToolChoice(message: string): 'auto' | 'required' {
  const isImperative = IMPERATIVE_INTENT_PATTERNS.some((pattern) => pattern.test(message));
  if (isImperative) {
    console.log(`[Orchestrator] 🎯 Intenção estrita detectada. Forçando tool_choice: "required"`);
    return 'required';
  }
  return 'auto';
}

// ── Helpers de Execução ───────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: ToolCall[],
  authUserId: string,
  numericUserId: string,
  sessionId: string,
  contextSnapshot: ChatMessage[]
): Promise<ToolCallResult[]> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      try {
        const rawResult = await Promise.race([
          executeTool(tc, authUserId, numericUserId, contextSnapshot, sessionId),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('Desculpe, esta ação demorou muito.'), 3000)
          ),
        ]);
        const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        return { tc, result };
      } catch (err) {
        return {
          tc,
          result: 'Não foi possível executar esta ação no momento.',
        };
      }
    })
  );
}

function buildToolCallMessages(
  firstContent: string | null,
  toolCalls: ToolCall[],
  toolResults: ToolCallResult[]
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: firstContent,
      tool_calls: toolCalls,
    },
  ];

  toolResults.forEach((tr) => {
    messages.push({
      role: 'tool',
      tool_call_id: tr.tc.id,
      content: tr.result,
    });
  });

  return messages;
}

function appendResilienceNotice(text: string, requestedModel: string, usedModel: string): string {
  if (requestedModel.includes('pro') && usedModel.includes('flash')) {
    return text + `\n\n---\n*💡 Nota: O motor principal (${requestedModel}) está instável. Resposta gerada via reserva (${usedModel}).*`;
  }
  return text;
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export async function runLLMOrchestrator(
  ctx: ChatRequestContext,
  prompt: ChatPrompt
): Promise<string> {
  const { user, requestSignature, message } = ctx;
  const { conversationMessages, tools, model: requestedModel } = prompt;

  // ── Roteamento MoE: resolve modelo ideal para esta intenção ──────────────
  const lastTurn = conversationMessages.at(-2)?.content ?? null;
  const { model: routedModel } = await resolveModelByIntent(
    message,
    typeof lastTurn === 'string' ? lastTurn : null,
    requestedModel
  );

  const toolChoice = resolveToolChoice(message);

  // Conversas casuais: 1 step. Tools obrigatórias: até 2 steps.
  const isToolRequired = toolChoice === 'required';
  const MAX_STEPS = isToolRequired ? 2 : 1;

  let currentMessages = [
    { role: 'system' as const, content: prompt.systemPrompt },
    ...conversationMessages,
  ] as ChatMessage[];

  let passoAtual = 0;
  let loopResponse: LLMResponse | null = null;
  let ferramentasExecutadas = false;

  // ── FASE 1: Loop de Acúmulo ───────────────────────────────────────────────
  while (passoAtual < MAX_STEPS) {
    passoAtual++;

    const currentToolChoice = passoAtual === 1 ? toolChoice : 'auto';
    const stepSignature =
      passoAtual === 1 ? requestSignature : `${requestSignature}_step_${passoAtual}`;

    let stepFailed = false;

    try {
      loopResponse = (await callOpenRouterWithPriority(
        1, 'never', stepSignature,
        currentMessages, tools, routedModel,
        0.1, 25000, 8000, currentToolChoice
      )) as LLMResponse;
    } catch (error) {
      console.error(`[Orchestrator] Erro no passo ${passoAtual}:`, error);
      stepFailed = true;
    }

    if (stepFailed) break;

    if (Array.isArray(loopResponse?.toolCalls) && loopResponse!.toolCalls!.length > 0) {
      ferramentasExecutadas = true;
      console.log(`[Orchestrator] 🚀 Passo ${passoAtual}: ${loopResponse!.toolCalls!.length} ferramenta(s).`);

      const toolResults = await executeToolCalls(
        loopResponse!.toolCalls!,
        user.auth_user_id,
        String(user.id),
        ctx.sessionId,
        currentMessages.slice(-3)
      );

      const toolMessages = buildToolCallMessages(
        loopResponse!.content,
        loopResponse!.toolCalls!,
        toolResults
      );
      currentMessages.push(...toolMessages);
      continue;
    } else {
      break;
    }
  }

  // ── FASE 2: Retorno ou Síntese ────────────────────────────────────────────

  if (!loopResponse) {
    console.error('[Orchestrator] Nenhuma resposta LLM. Retornando fallback.');
    return 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
  }

  // Sem tools ou loop já gerou resposta suficiente → retorna direto
  if (!ferramentasExecutadas || (loopResponse.content && loopResponse.content.trim().length > 20)) {
    return appendResilienceNotice(
      loopResponse.content || 'Entendido.',
      routedModel,
      loopResponse.modelUsed || requestedModel
    );
  }

  // Síntese apenas quando tools foram executadas e não geraram conteúdo
  try {
    const fastModel = routedModel.replace(/pro(-\w+)?/, 'fast$1');
    const synthesisResponse = (await callOpenRouterWithPriority(
      1, 'never', `${requestSignature}_synth`,
      currentMessages, [], fastModel,
      0.7, 15000, 6000
    )) as LLMResponse;

    return appendResilienceNotice(
      synthesisResponse.content || 'Ação concluída.',
      requestedModel,
      synthesisResponse.modelUsed || requestedModel
    );
  } catch (error) {
    console.error('[Orchestrator] Falha na síntese:', error);
    return loopResponse.content || 'Ação realizada, mas houve um problema ao formatar a resposta.';
  }
}
