// lib/modules/types.ts
// V2.1.0 — Adiciona tipagem para arquitetura Cache/RAM (V1/V2)

import type { ContextType } from '@/lib/chat/context-classifier';

export interface ModuleTrigger {
  contexts?: ContextType[];           // Contextos que ativam
  keywords?: RegExp;                  // Regex sobre a mensagem
  always?: boolean;                   // Carrega sempre (ex: localização)
  condition?: (opts: ModuleConditionOpts) => boolean | Promise<boolean>;
}

export interface ModuleConditionOpts {
  userId: string;
  authUserId: string;
  message: string;
  location?: { latitude: number; longitude: number } | null;
  contexts: ContextType[];
  emotionalScore: number;
  // ── A INJEÇÃO DE RIGOR ──
  masterContext?: any; // ← Dados da God RPC (Histórico, Agenda, Locais, etc.)
}

export interface ModuleMetrics {
  avgTokens: number;
  avgLatencyMs: number;
  activationCount: number;
  lastUsed?: string;
}

// Expandido para incluir o modelo Ultra/Pro mais recente
export type PreferredModel = 'flash' | 'pro' | 'sonnet' | 'ultra';

export interface ModuleDefinition {
  id: string;
  label: string;
  preferredModel: PreferredModel;
  plan: 'free' | 'personal' | 'family' | 'family_plus' | 'pro' | 'ultra'; 
  version?: 'v1' | 'v2'; // ← NOVA FLAG ADICIONADA AQUI
  trigger: ModuleTrigger;
  buildContextBlock: (opts: ModuleConditionOpts) => Promise<string>;
  tools: string[];
  metrics: ModuleMetrics;
}
