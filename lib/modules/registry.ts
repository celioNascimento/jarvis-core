import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions'; // <--- A MÁGICA DA VERCEL AQUI
import type { ModuleDefinition, ModuleConditionOpts } from './types';
import { recordModuleMetrics } from './metrics';

// Importa os módulos declarados
import { ModuloFinancas } from './modules/financas';
import { ModuloVeiculos } from './modules/veiculos';
import { ModuloCompras } from './modules/compras';
import { ModuloLocalizacao } from './modules/localizacao';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ALL_MODULES: ModuleDefinition[] = [
  ModuloFinancas,
  ModuloVeiculos,
  ModuloCompras,
  ModuloLocalizacao,
];

async function getEnabledModules(userId: string): Promise<string[]> {
  const cacheKey = `modules_enabled:${userId}`;
  const cached = await redis.get<string[]>(cacheKey);
  if (cached) return cached;

  const { data } = await supabase
    .schema('jarvis')
    .from('user_modules')
    .select('module_id')
    .eq('user_id', userId)
    .eq('enabled', true);

  const enabled = data?.map(r => r.module_id) ?? [];
  await redis.set(cacheKey, enabled, { ex: 300 });
  return enabled;
}

export function resolveModelForModules(
  activeModules: ModuleDefinition[],
  baseModel: string
): string {
  const modelPriority: Record<string, number> = {
    'flash': 1,
    'pro': 2,
    'sonnet': 3,
  };
  const modelMap: Record<string, string> = {
    'flash': 'google/gemini-2.0-flash-001',
    'pro': 'google/gemini-2.5-pro',
    'sonnet': 'anthropic/claude-sonnet-4-5',
  };

  let highest = 'flash';
  for (const mod of activeModules) {
    if ((modelPriority[mod.preferredModel] ?? 0) > (modelPriority[highest] ?? 0)) {
      highest = mod.preferredModel;
    }
  }

  if (highest === 'pro' && !baseModel.includes('pro')) {
    return modelMap['flash'];
  }

  return modelMap[highest] ?? baseModel;
}

export interface ActiveModuleResult {
  contextBlocks: string[];
  activeTools: string[];
  activeModules: ModuleDefinition[];
  resolvedModel: string;
}

export async function loadActiveModules(
  opts: ModuleConditionOpts,
  userPlan: string,
  baseModel: string,
): Promise<ActiveModuleResult> {
  const enabledIds = await getEnabledModules(opts.userId);

  const eligible = ALL_MODULES.filter(mod => {
    if (!enabledIds.includes(mod.id)) return false;

    const planOrder = ['free', 'personal', 'family', 'family_plus'];
    if (planOrder.indexOf(userPlan) < planOrder.indexOf(mod.plan)) return false;

    const { trigger } = mod;
    if (trigger.always) return true;
    if (trigger.contexts?.some(c => opts.contexts.includes(c))) return true;
    if (trigger.keywords?.test(opts.message)) return true;
    if (trigger.condition) return false;

    return false;
  });

  const withConditions = await Promise.all(
    ALL_MODULES
      .filter(mod => enabledIds.includes(mod.id) && mod.trigger.condition)
      .map(async mod => {
        const ok = await mod.trigger.condition!(opts);
        return ok ? mod : null;
      })
  );

  const finalModules = [
    ...eligible,
    ...withConditions.filter(Boolean) as ModuleDefinition[],
  ].filter((mod, i, arr) => arr.findIndex(m => m.id === mod.id) === i);

  const blockResults = await Promise.all(
    finalModules.map(async mod => {
      const start = Date.now();
      try {
        const block = await mod.buildContextBlock(opts);
        const latency = Date.now() - start;
        
        // CORREÇÃO APLICADA: waitUntil garante que a Vercel não mate essa requisição
        waitUntil(
          recordModuleMetrics(mod.id, opts.userId, {
            latencyMs: latency,
            tokens: Math.ceil(block.length / 4),
            activated: block.length > 0,
          }).catch(e => console.error(`[Metrics] Falha ao salvar métrica do módulo ${mod.id}`, e))
        );

        return block;
      } catch (e) {
        console.error(`[ModuleRegistry] Erro no módulo ${mod.id}:`, e);
        return '';
      }
    })
  );

  const contextBlocks = blockResults.filter(Boolean);
  const activeTools = [...new Set(finalModules.flatMap(m => m.tools))];
  const resolvedModel = resolveModelForModules(finalModules, baseModel);

  return { contextBlocks, activeTools, activeModules: finalModules, resolvedModel };
}
