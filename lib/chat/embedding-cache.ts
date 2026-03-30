// lib/chat/embedding-cache.ts
// Cache de embeddings persiste no banco (jarvis.config)
import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/jarvis';

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

export async function getCachedEmbedding(text: string): Promise<number[] | null> {
  const hash = hashCode(text);
  const cacheKey = `embedding_${hash}`;
  
  try {
    const { data } = await supabase
      .from('config')
      .select('value')
      .eq('key', cacheKey)
      .single();
    
    if (data?.value) {
      try {
        const parsed = JSON.parse(data.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[Embedding Cache] HIT:', cacheKey);
          return parsed;
        }
      } catch (parseError) {
        console.warn('[Embedding Cache] Parse falhou, gerando novo:', parseError);
      }
    }
    
    console.log('[Embedding Cache] MISS, gerando novo:', cacheKey);
    const embedding = await generateEmbedding(text);
    
    if (embedding && embedding.length > 0) {
      await supabase.from('config').upsert({
        key: cacheKey,
        value: JSON.stringify(embedding),
        metadata: { created_at: new Date().toISOString(), text_length: text.length },
        updated_at: new Date().toISOString()
      });
      console.log('[Embedding Cache] Salvo:', cacheKey, 'dimensões:', embedding.length);
    }
    
    return embedding;
  } catch (error) {
    console.error('[Embedding Cache] Erro:', error);
    return await generateEmbedding(text);
  }
}