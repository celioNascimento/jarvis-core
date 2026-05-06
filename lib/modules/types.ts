// lib/modules/types.ts — V2.0.0 (God RPC Types + Plan Hierarchy)
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
  // Incluído 'ultra' e 'family_plus' para bater com o seu User Summary
  plan: 'free' | 'personal' | 'family' | 'family_plus' | 'pro' | 'ultra'; 
  trigger: ModuleTrigger;
  buildContextBlock: (opts: ModuleConditionOpts) => Promise<string>;
  tools: string[];
  metrics: ModuleMetrics;
}
