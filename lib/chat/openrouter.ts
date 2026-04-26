// lib/chat/openrouter.ts
// 🔧 Suporte a maxTokens dinâmico (opcional, padrão 2000)

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolResponse {
  content: string;
  toolCalls: ToolCall[] | null;
}

export async function callOpenRouterWithTools(
  messages: any[],
  toolsDef: any[],
  model: string,
  temperature: number,
  timeoutMs = 25000,
  maxTokens = 2000, // ✅ novo parâmetro com valor padrão
  toolChoice: any = 'auto' // ← novo parâmetro
): Promise<ToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      body: JSON.stringify({
        model,
        messages,
        tools: toolsDef,
        tool_choice: toolChoice,
        temperature,
        max_tokens: maxTokens,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
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
  console.error('Falha após retries:', lastError);
  return null;
}
