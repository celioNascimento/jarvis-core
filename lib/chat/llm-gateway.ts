// lib/chat/llm-gateway.ts
// Motor V8.13.2 — Gatekeeper: Priority Queue, Rate Limiter e Dedup

import { Redis } from '@upstash/redis';
// Importe a sua função original renomeada (ou apenas mantenha a lógica de fetch lá dentro)
import { callOpenRouterWithTools as rawCallOpenRouter } from '@/lib/chat/openrouter';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export type PriorityLevel = 1 | 2 | 3 | 4;
export type DropPolicy = 'never' | 'if_full';

export interface LLMTask<T> {
  id: string;               // Chave única para Dedup no Redis
  priority: PriorityLevel;  // 1: Chat, 2: L4/Classifiers, 3: Extractors, 4: Critic/Promoter
  dropPolicy: DropPolicy;   // 'never' (vai pro backoff) | 'if_full' (descarta se engargalar)
  execute: () => Promise<T>;
}

class Gatekeeper {
  private activeCount = 0;
  private readonly maxConcurrent = 3; // Limite de conexões simultâneas com o OpenRouter
  private readonly maxQueueSize = 8;  // Tamanho máximo da fila antes de aplicar Load Shedding
  private queue: Array<{ task: LLMTask<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  async enqueue<T>(task: LLMTask<T>): Promise<T> {
    const dedupKey = `llm_dedup:${task.id}`;

    // 1. DEDUPLICAÇÃO CROSS-CONTAINER (Redis)
    // Se dois processos pedirem o mesmo job ao mesmo tempo, retorna o cache.
    try {
      const cached = await redis.get<T>(dedupKey);
      if (cached) {
        console.log(`[Gatekeeper] Cache hit (Dedup) para a tarefa: ${task.id}`);
        return cached;
      }
    } catch (e) {
      console.warn(`[Gatekeeper] Erro ao ler dedup do Redis para ${task.id}`, e);
    }

    // 2. LOAD SHEDDING (Descarte Seletivo)
    // Protege o servidor descartando tarefas de luxo (ex: Critic) se a fila estiver lotada.
    if (this.queue.length >= this.maxQueueSize && task.dropPolicy === 'if_full') {
      console.warn(`[Gatekeeper] Fila cheia (${this.queue.length}). Descartando tarefa: ${task.id}`);
      throw new Error('GATEKEEPER_DROPPED_TASK');
    }

    // 3. ENFILEIRAMENTO POR PRIORIDADE
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      // Reordena: números menores (1) vão para o início da fila
      this.queue.sort((a, b) => a.task.priority - b.task.priority);
      
      this.processQueue();
    });
  }

  private async processQueue() {
    // Se atingiu o limite de concorrência ou a fila está vazia, aguarda.
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;

    this.activeCount++;
    const item = this.queue.shift();
    
    if (!item) {
      this.activeCount--;
      return;
    }

    try {
      console.log(`[Gatekeeper] Executando tarefa: ${item.task.id} (Prioridade: ${item.task.priority})`);
      const result = await item.task.execute();
      
      // 4. SALVA NO CACHE DE DEDUPLICAÇÃO (TTL 60s)
      // Mantém a resposta salva brevemente para evitar duplicação em retries próximos
      await redis.set(`llm_dedup:${item.task.id}`, result, { ex: 60 });
      
      item.resolve(result);
    } catch (error: any) {
      // 5. BACKOFF EXPONENCIAL / RETRY LOGIC (Simplificado na base do throw para o QStash lidar)
      console.error(`[Gatekeeper] Falha na tarefa ${item.task.id}:`, error.message);
      item.reject(error);
    } finally {
      this.activeCount--;
      // Ciclo contínuo: assim que libera uma vaga, puxa o próximo da fila
      this.processQueue();
    }
  }
}

// Instância Singleton
export const llmGateway = new Gatekeeper();

// ============================================================================
// Wrapper (Drop-in Replacement) para a sua função original
// ============================================================================
export async function callOpenRouterWithPriority(
  priority: PriorityLevel,
  dropPolicy: DropPolicy,
  taskId: string,
  messages: any[],
  tools: any[],
  model: string,
  temperature: number,
  timeoutMs: number = 35000,
  maxTokens?: number,
  toolChoice?: any
) {
  return llmGateway.enqueue({
    id: taskId,
    priority,
    dropPolicy,
    execute: async () => {
      // Chama a sua lógica real de rede que fala com o OpenRouter
      return rawCallOpenRouter(
        messages, 
        tools, 
        model, 
        temperature, 
        timeoutMs, 
        maxTokens, 
        toolChoice
      );
    }
  });
}
