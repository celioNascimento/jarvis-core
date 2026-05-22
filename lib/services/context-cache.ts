// lib/services/context-cache.ts
// V1.0.0 — Cache granular do contexto por campo com TTLs diferenciados
//
// Substitui o cache monolítico do masterContext (TTL 60s para tudo).
// Cada campo tem TTL condizente com sua frequência de mudança.
// Invalidação seletiva: cada service invalida só o campo que alterou.
//
// USO:
//   import { ContextCache } from '@/lib/services/context-cache';
//   const cache = new ContextCache(userId);
//   const settings = await cache.get('settings');
//   await cache.invalidate('reminders');

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ── TTLs por campo (segundos) ─────────────────────────────────────────────────

const FIELD_TTL: Record<ContextField, number> = {
  settings:   86400, // 24 horas
  modules:    86400,
  guidelines: 86400,
  persons:    86400,
  locations:  86400,
  favorite_places: 86400,
  reminders:  86400,
  history:    86400, // É invalidado explicitamente a cada chat
  shopping:   86400, // É invalidado explicitamente na compra
  events:     86400, // É invalidado explicitamente ao agendar
  diary:      86400, // É invalidado explicitamente ao escrever
  goals:      86400,
};


// ── Tipos ─────────────────────────────────────────────────────────────────────

export type ContextField =
  | 'settings'
  | 'modules'
  | 'guidelines'
  | 'persons'
  | 'locations'
  | 'reminders'
  | 'history'
  | 'favorite_places'
  | 'shopping'
  | 'events'
  | 'diary'
  | 'goals';

// ── Helpers de chave ──────────────────────────────────────────────────────────

function fieldKey(userId: number, field: ContextField): string {
  return `ctx:${userId}:${field}`;
}

function historyKey(userId: number, sessionId: string): string {
  return `ctx:${userId}:history:${sessionId}`;
}

// ── Classe principal ──────────────────────────────────────────────────────────

export class ContextCache {
  constructor(private userId: number) {}

  // ── Leitura de campo único ──────────────────────────────────────────────────

  async get<T = any>(field: ContextField): Promise<T | null> {
    try {
      return await redis.get<T>(fieldKey(this.userId, field));
    } catch {
      return null;
    }
  }

  // ── Leitura em paralelo de múltiplos campos ─────────────────────────────────
  // Uma única roundtrip ao Redis via mget

  async getMany(fields: ContextField[]): Promise<Partial<Record<ContextField, any>>> {
    if (!fields.length) return {};
    try {
      const keys = fields.map(f => fieldKey(this.userId, f));
      const values = await redis.mget<any[]>(...keys);
      const result: Partial<Record<ContextField, any>> = {};
      fields.forEach((f, i) => {
        if (values[i] !== null && values[i] !== undefined) {
          result[f] = values[i];
        }
      });
      return result;
    } catch {
      return {};
    }
  }

  // ── Escrita de campo único ──────────────────────────────────────────────────

  async set(field: ContextField, value: any): Promise<void> {
    try {
      await redis.set(fieldKey(this.userId, field), value, {
        ex: FIELD_TTL[field],
      });
    } catch (e) {
      console.warn(`[ContextCache] Falha ao salvar ${field}:`, e);
    }
  }

  // ── Invalidação seletiva ────────────────────────────────────────────────────

  async invalidate(...fields: ContextField[]): Promise<void> {
    if (!fields.length) return;
    try {
      await Promise.all(
        fields.map(f => redis.del(fieldKey(this.userId, f)))
      );
      console.log(`[ContextCache] Invalidado: ${fields.join(', ')} para user ${this.userId}`);
    } catch (e) {
      console.warn('[ContextCache] Falha ao invalidar:', e);
    }
  }

  // ── Histórico por sessão ────────────────────────────────────────────────────

  async getHistory(sessionId: string): Promise<any[] | null> {
    try {
      return await redis.get<any[]>(historyKey(this.userId, sessionId));
    } catch {
      return null;
    }
  }

  async setHistory(sessionId: string, history: any[]): Promise<void> {
    try {
      await redis.set(historyKey(this.userId, sessionId), history, {
        ex: FIELD_TTL.history,
      });
    } catch (e) {
      console.warn('[ContextCache] Falha ao salvar history:', e);
    }
  }

  async invalidateHistory(sessionId: string): Promise<void> {
    try {
      await redis.del(historyKey(this.userId, sessionId));
    } catch (e) {
      console.warn('[ContextCache] Falha ao invalidar history:', e);
    }
  }

  // ── Invalidação total (logout, reset) ──────────────────────────────────────

  async invalidateAll(): Promise<void> {
    await this.invalidate(...(Object.keys(FIELD_TTL) as ContextField[]));
  }
}

// ── Helpers estáticos para uso nos services ───────────────────────────────────
// Permitem invalidação sem instanciar a classe completa

export async function invalidateContextField(
  userId: number,
  ...fields: ContextField[]
): Promise<void> {
  const cache = new ContextCache(userId);
  await cache.invalidate(...fields);
}

export async function invalidateSessionHistory(
  userId: number,
  sessionId: string
): Promise<void> {
  const cache = new ContextCache(userId);
  await cache.invalidateHistory(sessionId);
}
