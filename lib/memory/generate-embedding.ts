// lib/memory/generate-embedding.ts
// Responsabilidade única: transformar texto em vetor numérico via OpenRouter.
//
// NÃO é LLM call de raciocínio — não passa pelo Gateway.
// NÃO faz cache — essa é responsabilidade do embedding-cache.ts.
// NÃO conhece userId, contextos ou pipeline — só texto → vetor.
//
// Regra 4: embeddings são I/O de dados, não geração de linguagem.
// O Gateway gerencia raciocínio. Este módulo gerencia representação vetorial.

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const TIMEOUT_MS = 15000;
const MAX_INPUT_CHARS = 8000;

/**
 * Transforma texto em vetor numérico de 1536 dimensões.
 * Retorna null em caso de falha — nunca lança exceção.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!text?.trim()) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    console.log('[Embedding] Gerando para:', text.slice(0, 60) + (text.length > 60 ? '...' : ''));

    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, MAX_INPUT_CHARS),
        dimensions: 1536,
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error('[Embedding] HTTP erro:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const json = await res.json();
    const embedding = json.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      console.error('[Embedding] Resposta inválida:', JSON.stringify(json).slice(0, 200));
      return null;
    }

    return embedding;
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      console.error(`[Embedding] Timeout após ${TIMEOUT_MS}ms`);
    } else {
      console.error('[Embedding] Falha:', e?.message || e);
    }
    return null;
  }
}