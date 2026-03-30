// lib/chat/openrouter.ts
// 🔧 FIX: Promise.race retorna `unknown` — tipamos explicitamente o fetch
//         para que `response` seja reconhecido como `Response` pelo TypeScript.

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
    timeoutMs = 25000
  ): Promise<ToolResponse> {
    // ✅ Tipo explícito em Promise.race — resolve o erro TS "response is of type unknown"
    const response = await Promise.race<Response>([
      fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
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
          tool_choice: 'auto',
          temperature,
          max_tokens: 2000,
        }),
      }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      ),
    ]);
  
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
