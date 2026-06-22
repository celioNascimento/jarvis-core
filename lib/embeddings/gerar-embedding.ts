// lib/embeddings/gerar-embedding.ts
// Gera embedding de um texto usando a OpenAI. Usado tanto no script de
// ingestão (offline) quanto em runtime (pra buscar exemplos parecidos).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY_1!;

export async function gerarEmbedding(texto: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texto,
      }),
      signal: AbortSignal.timeout(5000), // não deixa o pipeline travar esperando
    });

    if (!res.ok) {
      console.warn(`[Embeddings] Erro HTTP ${res.status} ao gerar embedding.`);
      return null;
    }

    const data = await res.json();
    return data.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.warn('[Embeddings] Falha ao gerar embedding:', err);
    return null; // falha aqui é silenciosa de propósito — ver explicação abaixo
  }
}