// lib/modules/registry.ts
// V12.5.0 (Type-Safe DB Query + Módulo de Clima + Esportes + Complexity Routing)

import { supabase } from '@/lib/jarvis';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import type { ModuleDefinition, ModuleConditionOpts } from './types';
import { recordModuleMetrics } from './metrics';

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

// ── Nova Função de Avaliação de Complexidade ──
function evaluateTaskComplexity(message: string, activeResults: any[]): boolean {
  // 1. Carga Cognitiva: Palavras-chave que exigem raciocínio profundo, análise ou código
  const complexIntentRegex = /analis[ea]|compar[ea]|resum[ea]|refator[ea]|explic[ea]|arquitetura|dossiê|código|debug/i;
  if (complexIntentRegex.test(message)) return true;

  // 2. Volume de Dados: Mensagens longas geralmente contêm logs, textos grandes ou instruções detalhadas
  if (message.length > 400) return true;

  // 3. Sobrecarga de Contexto: Se muitos módulos foram engatilhados juntos, o LLM precisa de mais atenção (attention span)
  if (activeResults.length >= 3) return true;

  // 4. Peso do Módulo: Algum módulo ativo é estritamente analítico?
  const heavyModules = ['projetos', 'dossie', 'financas'];
  const hasHeavyModule = activeResults.some(r => heavyModules.includes(r.id));
  if (hasHeavyModule) return true;

  // Se passou por tudo isso, é uma tarefa transacional simples (clima, lembrete, agenda)
  return false;
}

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
      // ── CORREÇÃO ERRO 400 ──
      // Converte explicitamente para Base 10 Inteiro. Evita vazamento de UUIDs na query.
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
            activated: block.length > 0
          }).catch(e => console.error('[Metrics Error]', e));
        })()
      );

      return { id: mod.id, block, tools: mod.tools || [], model: mod.preferredModel };
    } catch (e) {
      console.error(`[ModuleRegistry] Erro em ${mod.id}:`, e);
      return { id: mod.id, block: '', tools: [], model: 'flash' };
    }
  }));

  // ── AVALIAÇÃO DINÂMICA DE MODELO ──
  const isComplex = evaluateTaskComplexity(opts.message, results);
  const finalModel = isComplex ? 'google/gemini-2.5-pro' : baseModel;

  console.log('[PROMPT] tamanho systemPrompt:', systemPrompt.length);
console.log('[PROMPT] model:', finalModel);
console.log('[PROMPT] tools count:', resolvedTools.length);

  return {
    contextBlocks: results.map(r => r.block).filter(Boolean),
    activeTools: [...new Set(results.flatMap(r => r.tools))],
    resolvedModel: finalModel,
  };
}
