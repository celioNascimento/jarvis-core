// lib/modules/modules/esportes.ts
import type { ModuleDefinition } from '../types';

export const ModuloEsportes: ModuleDefinition = {
  id: 'esportes',
  label: 'Dados e Estatísticas Esportivas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['esportes'],
    keywords: /futebol|brasileirão|placar|tabela|classificação|jogo de hoje|campeonato|champions|premier league/i
  },
  buildContextBlock: async () => {
    // Retorna uma diretriz fixa orientando a IA a usar as ferramentas caso precise dar placares reais
    return `[MÓDULO DE ESPORTES ATIVO]
Diretriz: Para responder sobre placares, resultados recentes ou classificação de tabelas, use obrigatoriamente as ferramentas esportivas disponíveis. Não tente adivinhar resultados futuros ou passados fora do seu conhecimento.`;
  },
  tools: ['esportes_consultar_placar_ao_vivo', 'esportes_consultar_tabela'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
