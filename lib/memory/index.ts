// lib/memory/index.ts
// Barrel export do módulo de memória semântica.
// Importar daqui — não dos arquivos internos diretamente.
//
// Estrutura do módulo:
//   generate-embedding.ts  → texto → vetor (fetch direto, sem cache)
//   embedding-cache.ts     → vetor cacheado via Redis
//   embedding-gate.ts      → decisão pura: vale buscar memória?
//   memory-retrieval.ts    → busca semântica no HD (match_memories)

export { generateEmbedding } from './generate-embedding';
export { getCachedEmbedding } from './embedding-cache';
export { shouldRetrieveMemory } from './embedding-gate';
export { retrieveRelevantMemories } from './memory-retrieval';
export type { MemoryItem } from './memory-retrieval';