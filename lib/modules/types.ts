import type { ContextType } from '@/lib/chat/context-classifier';

export interface ModuleTrigger {
  contexts?: ContextType[];           // contextos que ativam
  keywords?: RegExp;                  // regex sobre a mensagem
  always?: boolean;                   // carrega sempre (ex: localização se disponível)
  condition?: (opts: ModuleConditionOpts) => boolean | Promise<boolean>;
}

export interface ModuleConditionOpts {
  userId: string;
  authUserId: string;
  message: string;
  location?: { latitude: number; longitude: number } | null;
  contexts: ContextType[];
  emotionalScore: number;
}

export interface ModuleMetrics {
  avgTokens: number;
  avgLatencyMs: number;
  activationCount: number;
  lastUsed?: string;
}

export type PreferredModel = 'flash' | 'pro' | 'sonnet';

export interface ModuleDefinition {
  id: string;
  label: string;                      // nome legível: "Finanças"
  preferredModel: PreferredModel;     // modelo que esse módulo funciona melhor
  plan: 'free' | 'personal' | 'family' | 'family_plus'; // plano mínimo
  trigger: ModuleTrigger;
  // Bloco de contexto para o prompt — retorna '' se não há dados
  buildContextBlock: (opts: ModuleConditionOpts) => Promise<string>;
  // Tools que o LLM pode chamar quando esse módulo está ativo
  tools: string[];                    // nomes das tools em tools-def.ts
  // Métricas iniciais (atualizado em runtime pelo metrics.ts)
  metrics: ModuleMetrics;
}
