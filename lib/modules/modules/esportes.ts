// lib/modules/modules/esportes.ts
// V12.3.0 — Padrão mantido: Zero DB Calls Nativo + UX Anti-Robô

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
PROIBIDO gerar blocos de código contendo print(), pseudo-funções ou textos simulando chamadas de API. Você deve retornar apenas a resposta textual após a execução real da ferramenta.

⚠️ DIRETRIZ DE UX DE CONVERSAÇÃO (ANTI-ROBÔ):
Se o usuário perguntar pelo jogo de um time específico (ex: São Paulo, Palmeiras, Flamengo) e a ferramenta de placar indicar que não há partidas hoje para aquela liga, NÃO ofereça de forma burra 'procurar em outra liga'. O usuário já especificou o campeonato. 
Em vez disso, responda amigavelmente que o time não joga hoje e ofereça-se imediatamente para:
1. Consultar a tabela de classificação atual usando 'esportes_consultar_tabela'.
2. Pesquisar na internet quando será a próxima partida do time usando 'web_pesquisar'.`;
  },

  tools: ['esportes_consultar_placar_ao_vivo', 'esportes_consultar_tabela'],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};