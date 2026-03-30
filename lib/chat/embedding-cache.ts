// lib/chat/embedding-cache.ts
// ✅ CORREÇÃO: Cache agora persiste no banco (jarvis.config)
// Em Next.js serverless, cada request roda em container diferente
// Map em memória é perdido entre requests → embeddings inconsistentes

import { supabase } from '@/lib/jarvis';
import { generateEmbedding } from '@/lib/jarvis';

// Hash simples para criar chaves de cache únicas
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
    // 1. Tenta cache no banco de dados
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
    
    // 2. Gera novo embedding
    console.log('[Embedding Cache] MISS, gerando novo:', cacheKey);
    const embedding = await generateEmbedding(text);
    
    // 3. Salva no cache (TTL implícito via cleanup periódico se necessário)
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
    // Fallback: gera embedding sem cache
    return await generateEmbedding(text);
  }
}