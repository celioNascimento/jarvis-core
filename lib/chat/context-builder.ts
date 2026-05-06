import type { ModuleDefinition, ModuleConditionOpts } from '../modules/types';

// Importe todos os seus módulos aqui
import { ModuloAgenda } from '../modules/modules/agenda';
import { ModuloCompras } from '../modules/modules/compras';
import { ModuloFinancas } from '../modules/modules/financas';
import { ModuloFoco } from '../modules/modules/foco';
import { ModuloLocalizacao } from '../modules/modules/localizacao';
import { ModuloRotinas } from '../modules/modules/rotinas';

// O Registro Oficial de Módulos (Se criar um novo, basta adicionar nesta lista)
const registry: ModuleDefinition[] = [
  ModuloAgenda,
  ModuloCompras,
  ModuloFinancas,
  ModuloFoco,
  ModuloLocalizacao,
  ModuloRotinas
];

export interface BuilderResult {
  contextText: string;
  activeTools: string[]; // Ferramentas permitidas para esta interação específica
}

export async function buildDynamicContext(opts: ModuleConditionOpts): Promise<BuilderResult> {
  const activeModules: ModuleDefinition[] = [];

  // 1. MOTOR DE AVALIAÇÃO DE TRIGGERS
  for (const module of registry) {
    let shouldActivate = false;

    // Regra 1: Always True (ex: Localização, se o GPS foi enviado)
    if (module.trigger.always) {
      // Se tiver condition atrelada ao always, testa ela
      if (module.trigger.condition) {
         shouldActivate = await module.trigger.condition(opts);
      } else {
         shouldActivate = true;
      }
    } 
    // Regra 2: Cruzamento de Contextos da Camada 4 (L4)
    else if (module.trigger.contexts && module.trigger.contexts.some(ctx => opts.contexts.includes(ctx))) {
      shouldActivate = true;
    } 
    // Regra 3: Match de Palavras-chave via Regex
    else if (module.trigger.keywords && module.trigger.keywords.test(opts.message)) {
      shouldActivate = true;
    } 
    // Regra 4: Condição Customizada (ex: pedir "resumo de hoje")
    else if (module.trigger.condition && await module.trigger.condition(opts)) {
      shouldActivate = true;
    }

    if (shouldActivate) {
      activeModules.push(module);
    }
  }

  if (activeModules.length === 0) {
    return { contextText: '', activeTools: [] };
  }

  // 2. EXECUÇÃO PARALELA DE ALTA PERFORMANCE
  // Dispara todas as consultas de banco de dados ao mesmo tempo
  const contextPromises = activeModules.map(mod => mod.buildContextBlock(opts));
  const contextResults = await Promise.all(contextPromises);

  // Filtra retornos vazios (ex: ativou módulo de compras, mas não há compras pendentes)
  const validContexts = contextResults.filter(text => text && text.trim().length > 0);

  // 3. EXTRAÇÃO DAS FERRAMENTAS AUTORIZADAS
  // Cria uma lista única (Set) com todas as ferramentas dos módulos ativados
  const activeToolsSet = new Set<string>();
  activeModules.forEach(mod => {
    mod.tools.forEach(tool => activeToolsSet.add(tool));
  });

  return {
    contextText: validContexts.length > 0 
      ? `--- [CONSCIÊNCIA DINÂMICA INJETADA] ---\n${validContexts.join('\n\n')}\n---------------------------------------` 
      : '',
    activeTools: Array.from(activeToolsSet)
  };
}