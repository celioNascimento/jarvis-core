// lib/modules/registry.ts
// V12.7.1 — Rigorous Context Injection & Registry Full Scan

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import type { ModuleDefinition, ModuleConditionOpts } from './types';
import { recordModuleMetrics } from './metrics';
import { routeModel } from '@/lib/chat/context-classifier';

// [Imports de todos os módulos mantidos exatamente como no original...]
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

const ALL_MODULES = [
  ModuloFinancas, ModuloVeiculos, ModuloFoco, ModuloRotinas, ModuloAgenda,
  ModuloLocalizacao, ModuloProjetos, ModuloRelacionamentos, ModuloReminders,
  ModuloCompras, ModuloClima, ModuloEsportes, ModuloDossie, ModuloPersonalidade,
];

export async function loadActiveModules(
  opts: ModuleConditionOpts & { masterContext?: any },
  userPlan: string,
  baseModel: string,
) {
  const numericUserId = parseInt(String(opts.userId), 10);

  // 1. Hidratação consolidada (God RPC)
  // Mantemos o masterContext para evitar chamadas duplicadas aos módulos
  let masterContext = opts.masterContext;
  if (!masterContext) {
    const { data } = await supabase.rpc('get_consolidated_context', { p_user_id: numericUserId });
    masterContext = data || {};
  }

  // 2. Determinação de módulos ativos
  const cacheKey = `modules_enabled:${numericUserId}`;
  let enabledIds: string[] = masterContext.modules?.map((m: any) => m.module_id) || [];
  
  if (enabledIds.length === 0) {
    const cached = await new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    }).get<string[]>(cacheKey);
    
    if (cached) {
      enabledIds = cached;
    } else {
      const { data } = await supabase
        .from('user_modules')
        .select('module_id')
        .eq('user_id', numericUserId)
        .eq('is_active', true);
      enabledIds = data?.map(r => r.module_id) || [];
    }
  }

  // 3. Execução Controlada de Módulos (Full Scan)
  const results = await Promise.all(ALL_MODULES.map(async mod => {
    // Validação de permissão e ativação
    const planOrder = ['free', 'personal', 'family', 'family_plus', 'ultra'];
    const modPlanIdx = planOrder.indexOf(mod.plan);
    const userPlanIdx = planOrder.indexOf(userPlan);

    if (userPlanIdx < modPlanIdx || !enabledIds.includes(mod.id)) return null;

    const { trigger } = mod;
    let activated = trigger.always || false;

    if (trigger.contexts?.some(c => opts.contexts.includes(c))) activated = true;
    else if (trigger.keywords?.test(opts.message)) activated = true;
    else if (trigger.condition && await trigger.condition({ ...opts, masterContext })) activated = true;

    if (!activated) return null;

    const start = Date.now();
    try {
      // 🛡️ INJEÇÃO CRÍTICA: Passamos o masterContext para o módulo
      const block = await mod.buildContextBlock({ ...opts, masterContext });

      // Registro de métricas não bloqueante
      waitUntil(
        recordModuleMetrics(mod.id, numericUserId, {
          latencyMs: Date.now() - start,
          tokens: Math.ceil((block?.length || 0) / 4),
          activated: (block?.length || 0) > 0,
        }).catch(e => console.error('[Metrics Error]', e))
      );

      return { block, tools: mod.tools || [] };
    } catch (e) {
      console.error(`[ModuleRegistry] Erro fatal em ${mod.id}:`, e);
      return null;
    }
  }));

  const validResults = results.filter(Boolean) as { block: string, tools: string[] }[];

  const { model: routedModel } = routeModel(opts.contexts, opts.emotionalScore);

  return {
    contextBlocks: validResults.map(r => r.block).filter(Boolean),
    activeTools: [...new Set(validResults.flatMap(r => r.tools))],
    resolvedModel: routedModel,
  };
}
