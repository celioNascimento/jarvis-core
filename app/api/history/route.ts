// lib/modules/registry.ts
import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions'; 
import type { ModuleDefinition, ModuleConditionOpts } from '../../../lib/modules/types';
import { recordModuleMetrics } from '../../../lib/modules/metrics';

import { ModuloFinancas } from '../../../lib/modules/modules/financas';
import { ModuloVeiculos } from '../../../lib/modules//modules/veiculos';
import { ModuloFoco } from '../../../lib/modules//modules/foco';
import { ModuloRotinas } from '../../../lib/modules/modules/rotinas';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ALL_MODULES: ModuleDefinition[] = [
  ModuloFinancas,
  ModuloVeiculos,
  ModuloFoco,
  ModuloRotinas,
];

export async function loadActiveModules(
  opts: ModuleConditionOpts,
  userPlan: string,
  baseModel: string,
) {
  const cacheKey = `modules_enabled:${opts.userId}`;
  let enabledIds = await redis.get<string[]>(cacheKey);
  
  if (!enabledIds) {
    const { data } = await supabase.schema('jarvis').from('user_modules').select('module_id').eq('user_id', opts.userId).eq('enabled', true);
    enabledIds = data?.map(r => r.module_id) || [];
    await redis.set(cacheKey, enabledIds, { ex: 300 });
  }

  const activeModules = await Promise.all(ALL_MODULES.map(async mod => {
    if (!enabledIds?.includes(mod.id)) return null;
    
    const planOrder = ['free', 'personal', 'family', 'family_plus'];
    if (planOrder.indexOf(userPlan) < planOrder.indexOf(mod.plan)) return null;

    const { trigger } = mod;
    let activated = trigger.always || false;
    
    if (trigger.contexts?.some(c => opts.contexts.includes(c))) activated = true;
    if (trigger.keywords?.test(opts.message)) activated = true;
    if (trigger.condition && await trigger.condition(opts)) activated = true;

    return activated ? mod : null;
  }));

  const finalModules = activeModules.filter(Boolean) as ModuleDefinition[];

  const results = await Promise.all(finalModules.map(async mod => {
    const start = Date.now();
    try {
      const block = await mod.buildContextBlock(opts);
      
      waitUntil(
        (async () => {
          await recordModuleMetrics(mod.id, Number(opts.userId), {
            latencyMs: Date.now() - start,
            tokens: Math.ceil(block.length / 4),
            activated: block.length > 0
          });
        })()
      );

      return { block, tools: mod.tools, model: mod.preferredModel };
    } catch (e) {
      console.error(`[ModuleRegistry] Erro em ${mod.id}:`, e);
      return { block: '', tools: [], model: 'flash' };
    }
  }));

  return {
    contextBlocks: results.map(r => r.block).filter(Boolean),
    activeTools: [...new Set(results.flatMap(r => r.tools))],
    resolvedModel: baseModel
  };
}