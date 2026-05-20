// lib/modules/registry.ts
// V12.6.0 — Complexity Routing via routeModel

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import type { ModuleDefinition, ModuleConditionOpts } from './types';
import { recordModuleMetrics } from './metrics';
import { routeModel } from '@/lib/chat/context-classifier';

import { ModuloFinancas } from './modules/financas';
import { ModuloVeiculos } from './modules/veiculos';
import { ModuloFoco } from './modules/foco';
import { ModuloRotinas } from './modules/rotinas';
import { ModuloAgenda } from './modules/agenda';
import { ModuloLocalizacao } from './modules/localizacao';
import { ModuloProjetos } from './modules/projetos';
import { ModuloRelacionamentos } from '../modules/modules/relacionamentos';
import { ModuloReminders } from './modules/reminders';
import { ModuloCompras } from './modules/compras';
import { ModuloClima } from './modules/clima';
import { ModuloEsportes } from './modules/esportes';
import { ModuloPersonalidade } from './modules/personalidade';
import { ModuloDossie } from './modules/dossie';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ALL_MODULES: ModuleDefinition[] = [
  ModuloFinancas,
  ModuloVeiculos,
  ModuloFoco,
  ModuloRotinas,
  ModuloAgenda,
  ModuloLocalizacao,
  ModuloProjetos,
  ModuloRelacionamentos,
  ModuloReminders,
  ModuloCompras,
  ModuloClima,
  ModuloEsportes,
  ModuloDossie,
  ModuloPersonalidade,
];

export async function loadActiveModules(
  opts: ModuleConditionOpts & { masterContext?: any },
  userPlan: string,
  baseModel: string,
) {
  let enabledIds: string[] | null = null;

  if (opts.masterContext?.modules) {
    enabledIds = opts.masterContext.modules.map((m: any) => m.module_id);
    console.debug(`[ModuleRegistry] Hidratação via God RPC: ${enabledIds?.length} módulos.`);
  } else {
    const cacheKey = `modules_enabled:${opts.userId}`;
    enabledIds = await redis.get<string[]>(cacheKey);

    if (!enabledIds) {
      const safeNumericId = parseInt(String(opts.userId), 10);

      const { data } = await supabase
        .from('user_modules')
        .select('module_id')
        .eq('user_id', safeNumericId)
        .eq('is_active', true);

      enabledIds = data?.map(r => r.module_id) || [];
      await redis.set(cacheKey, enabledIds, { ex: 300 });
    }
  }

  const activeModules = await Promise.all(ALL_MODULES.map(async mod => {
    if (!enabledIds?.includes(mod.id)) return null;

    const planOrder = ['free', 'personal', 'family', 'family_plus', 'ultra'];
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
          await recordModuleMetrics(mod.id, parseInt(String(opts.userId), 10), {
            latencyMs: Date.now() - start,
            tokens: Math.ceil(block.length / 4),
            activated: block.length > 0,
          }).catch(e => console.error('[Metrics Error]', e));
        })()
      );

      return { id: mod.id, block, tools: mod.tools || [], model: mod.preferredModel };
    } catch (e) {
      console.error(`[ModuleRegistry] Erro em ${mod.id}:`, e);
      return { id: mod.id, block: '', tools: [], model: 'flash' };
    }
  }));

  // ── Roteamento dinâmico por contexto e score emocional ──
  const { model: routedModel } = routeModel(
    opts.contexts,
    opts.emotionalScore,
  );

  return {
    contextBlocks: results.map(r => r.block).filter(Boolean),
    activeTools: [...new Set(results.flatMap(r => r.tools))],
    resolvedModel: routedModel,
  };
}
