// lib/modules/modules/esportes.ts
// V1.0.3 — Correção de Sintaxe (Vírgula de Fechamento do Bloco)

import type { ModuleDefinition } from '../types';

export const ModuloEsportes: ModuleDefinition = {
  id: 'esportes',
  label: 'Dados e Estatísticas Esportivas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['esporte'],
    keywords: /futebol|brasileirão|placar|tabela|classificação|jogo de hoje|campeonato|champions|premier league/i
  },
  
  buildContextBlock: async () => {
    return `[MÓDULO DE ESPORTES ATIVO]
CRÍTICO: Para responder sobre placares, resultados recentes ou tabelas, invoque a ferramenta nativa correspondente (esportes_consultar_placar_ao_vivo ou esportes_consultar_tabela). 
PROIBIDO gerar blocos de código contendo print(), pseudo-funções ou textos simulando chamadas de API. Você deve retornar apenas a resposta textual após a execução real da ferramenta.`;
  }, // ← A VÍRGULA CORRIGIDA AQUI!

  tools: ['esportes_consultar_placar_ao_vivo', 'esportes_consultar_tabela'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};

