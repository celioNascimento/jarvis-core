// lib/chat/openrouter.ts
// 🔧 Suporte a maxTokens dinâmico (opcional, padrão 2000) e Tipagem Estrita para Tools

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolResponse {
  content: string;
  toolCalls: ToolCall[] | null;
}

// ── Tipagens Estritas Adicionadas ────────────────────────────────────────
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
// ─────────────────────────────────────────────────────────────────────────

export async function callOpenRouterWithTools(
  messages: any[],
  toolsDef: ToolDefinition[] | undefined,
  model: string,
  temperature: number,
  timeoutMs = 25000,
  maxTokens = 2000,
  toolChoice: ToolChoice | undefined = 'auto'
): Promise<ToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Montagem segura do payload para evitar Erro 400 (rejeição de schema)
  const payload: Record<string, any> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // Só injeta tools e tool_choice se realmente existirem ferramentas
  if (Array.isArray(toolsDef) && toolsDef.length > 0) {
    payload.tools = toolsDef;
    if (toolChoice !== undefined) {
      payload.tool_choice = toolChoice;
    }
  }

  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Lev',
      },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    // Repassa o texto completo do erro para o Gateway conseguir acionar o Survival Mode
    const error = new Error(`OpenRouter error: ${response.status} - ${errorText}`);
    (error as any).status = response.status;
    throw error;
  }
  
  const data = await response.json();
  const choice = data.choices?.[0];

  return {
    content: choice?.message?.content || '',
    toolCalls: choice?.message?.tool_calls || null,
  };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 1000
): Promise<T | null> {
  let lastError: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries) {
        console.warn(`Retry ${i + 1}/${maxRetries}:`, e);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  
  if (lastError instanceof Error && lastError.name === 'AbortError') {
    console.warn('[OpenRouter] Chamada cancelada (background)');
  } else {
    console.error('[OpenRouter] Falha após retries:', lastError);
  }
  return null;
}
