// lib/modules/registry.ts
// V12.8.0 — Remove RPC redundante, corrige extração de modules do masterContext

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

const ALL_MODULES = [
  ModuloFinancas, ModuloVeiculos, ModuloFoco, ModuloRotinas, ModuloAgenda,
  ModuloLocalizacao, ModuloProjetos, ModuloRelacionamentos, ModuloReminders,
  ModuloCompras, ModuloClima, ModuloEsportes, ModuloDossie, ModuloPersonalidade,
];

// ── Extrai enabledIds de forma resiliente ────────────────────────────────────
//
// O RPC retorna modules como: [{ module_id: 'financas', ... }, ...]
// O cache Redis pode retornar o mesmo formato ou uma string serializada.
// Esta função normaliza os dois casos.

function extractEnabledIds(modules: any): string[] {
  if (!modules) return [];

  // Já é array de objetos com module_id (formato do RPC)
  if (Array.isArray(modules) && modules.length > 0 && typeof modules[0] === 'object') {
    const ids = modules.map((m: any) => m.module_id).filter(Boolean);
    console.log('[Registry] modules extraídos do masterContext:', ids);
    return ids;
  }

  // Array de strings (formato legado)
  if (Array.isArray(modules) && modules.length > 0 && typeof modules[0] === 'string') {
    console.log('[Registry] modules já em formato string[]:', modules);
    return modules;
  }

  console.warn('[Registry] modules em formato inesperado:', typeof modules, modules);
  return [];
}

export async function loadActiveModules(
  opts: ModuleConditionOpts & { masterContext?: any },
  userPlan: string,
  baseModel: string,
) {
  const numericUserId = parseInt(String(opts.userId), 10);

  // 1. masterContext SEMPRE vem da intelligence pipeline — não fazer novo RPC aqui.
  //    O registry não tem visibilidade do cache granular, então chamar get_consolidated_context
  //    aqui geraria uma segunda chamada desnecessária a cada turno.
  const masterContext = opts.masterContext || {};

  // 2. Extrai enabledIds do masterContext de forma resiliente
  let enabledIds = extractEnabledIds(masterContext.modules);

  console.log('[Registry] enabledIds do masterContext:', enabledIds.length);

  // 3. Fallback apenas se masterContext.modules realmente não existir
  //    (primeira requisição antes do cache aquecer, ou campo ausente no RPC)
  if (enabledIds.length === 0) {
    console.warn('[Registry] masterContext.modules vazio — caindo no fallback Redis');

    const cacheKey = `modules_enabled:${numericUserId}`;
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });

    try {
      const cached = await redis.get<string[]>(cacheKey);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        enabledIds = cached;
        console.log('[Registry] enabledIds do Redis fallback:', enabledIds.length);
      }
    } catch (e) {
      console.warn('[Registry] Redis fallback falhou:', e);
    }

    // 4. Último recurso: banco direto (só acontece se Redis também falhar)
    if (enabledIds.length === 0) {
      console.warn('[Registry] Redis vazio — buscando user_modules diretamente no banco');
      try {
        const { data } = await supabase
          .from('user_modules')
          .select('module_id')
          .eq('user_id', numericUserId)
          .eq('enabled', true);
        enabledIds = data?.map(r => r.module_id) || [];

        // Aquece o cache Redis para próximas requisições
        if (enabledIds.length > 0) {
          redis.set(cacheKey, enabledIds, { ex: 3600 }).catch(() => {});
        }
      } catch (e) {
        console.error('[Registry] Falha fatal ao buscar user_modules:', e);
      }
    }
  }

  // 5. Execução Controlada de Módulos (Full Scan)
  const results = await Promise.all(ALL_MODULES.map(async mod => {
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
      const block = await mod.buildContextBlock({ ...opts, masterContext });

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