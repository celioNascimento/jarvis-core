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
  const numericUserId = parseInt(String(opts.userId), 10);

  // 1. Hidratação Consolidada (O "Pulo do Gato")
  // Em vez de buscar módulo a módulo, buscamos TUDO de uma vez ou usamos o masterContext
  let enabledIds: string[];
  
  if (opts.masterContext?.modules) {
    enabledIds = opts.masterContext.modules.map((m: any) => m.module_id);
  } else {
    const cacheKey = `modules_enabled:${numericUserId}`;
    enabledIds = await redis.get<string[]>(cacheKey) || [];
    
    if (enabledIds.length === 0) {
      const { data } = await supabase
        .from('user_modules')
        .select('module_id')
        .eq('user_id', numericUserId)
        .eq('is_active', true);
      enabledIds = data?.map(r => r.module_id) || [];
      await redis.set(cacheKey, enabledIds, { ex: 300 });
    }
  }

  // 2. Pré-filtro inicial (evita instanciar módulos inativos)
  const relevantModules = ALL_MODULES.filter(mod => 
    enabledIds.includes(mod.id) && 
    ['free', 'personal', 'family', 'family_plus', 'ultra'].indexOf(userPlan) >= 
    ['free', 'personal', 'family', 'family_plus', 'ultra'].indexOf(mod.plan)
  );

  // 3. Execução Controlada (Batch)
  const results = await Promise.all(relevantModules.map(async mod => {
    const { trigger } = mod;
    let activated = trigger.always || false;

    if (trigger.contexts?.some(c => opts.contexts.includes(c))) activated = true;
    else if (trigger.keywords?.test(opts.message)) activated = true;
    else if (trigger.condition && await trigger.condition(opts)) activated = true;

    if (!activated) return null;

    const start = Date.now();
    try {
      const block = await mod.buildContextBlock(opts);
      
      // O registro de métricas continua em background sem bloquear o retorno
      waitUntil(
        recordModuleMetrics(mod.id, numericUserId, {
          latencyMs: Date.now() - start,
          tokens: Math.ceil(block.length / 4),
          activated: block.length > 0,
        }).catch(e => console.error('[Metrics Error]', e))
      );

      return { block, tools: mod.tools || [] };
    } catch (e) {
      console.error(`[ModuleRegistry] Erro em ${mod.id}:`, e);
      return null;
    }
  }));

  const validResults = results.filter(Boolean) as { block: string, tools: any[] }[];

  const { model: routedModel } = routeModel(opts.contexts, opts.emotionalScore);

  return {
    contextBlocks: validResults.map(r => r.block),
    activeTools: [...new Set(validResults.flatMap(r => r.tools))],
    resolvedModel: routedModel,
  };
}
