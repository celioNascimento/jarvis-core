// lib/chat/embedding-cache.ts — V2.1 (Sintaxe Integral)
import { supabase, generateEmbedding } from '@/lib/jarvis';

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
      .maybeSingle();
    
    if (data?.value) {
      try {
        const parsed = JSON.parse(data.value) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'number') {
          console.log('[Embedding Cache] HIT:', cacheKey);
          return parsed as number[];
        }
      } catch (parseError) {
        console.warn('[Embedding Cache] Parse falhou, gerando novo:', parseError);
      }
    }
    
    console.log('[Embedding Cache] MISS, gerando novo:', cacheKey);
    const embedding = await generateEmbedding(text);
    
    if (embedding && embedding.length > 0) {
      // [RIGOR] Fire & Forget: Usamos .then() para executar a query em background
      supabase.from('config').upsert({
        key: cacheKey,
        value: JSON.stringify(embedding),
        metadata: { created_at: new Date().toISOString(), text_length: text.length },
        updated_at: new Date().toISOString()
      }).then(({ error }) => {
        if (error) console.error('[Embedding Cache] Erro ao salvar cache (Background):', error);
      });
      
      console.log('[Embedding Cache] Salvo (Background):', cacheKey, 'dimensões:', embedding.length);
    }
    
    return embedding;

  // 👇 O compilador não estava achando esse fechamento
  } catch (error) {
    console.error('[Embedding Cache] Erro crítico no fluxo:', error);
    return generateEmbedding(text).catch(() => null);
  }
}