// lib/modules/modules/esportes.ts
// V12.4.0 — Nova tool esportes_consultar_jogos_por_time + keywords expandidas

import type { ModuleDefinition } from '../types';

export const ModuloEsportes: ModuleDefinition = {
  id: 'esportes',
  label: 'Dados e Estatísticas Esportivas',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['esporte'],
    keywords: /futebol|brasileir|placar|tabela|classifica|jogo|campeonato|champions|premier|serie a|la liga|time|resultado|ontem|gol|partida/i,
  },

  buildContextBlock: async () => {
    return `[MÓDULO DE ESPORTES ATIVO]

FERRAMENTAS DISPONÍVEIS:
• esportes_consultar_jogos_por_time  — use quando o usuário mencionar um TIME específico (São Paulo, Flamengo, Barcelona...). Não precisa saber a liga. Aceita parâmetro "quando": "hoje", "ontem", "anteontem".
• esportes_consultar_placar_ao_vivo  — use quando o usuário especificar o CAMPEONATO (brasileirão, champions, premier league...). Aceita parâmetro "quando".
• esportes_consultar_tabela          — use para classificação de um campeonato.

REGRAS CRÍTICAS:
1. NUNCA responda sobre resultados, placares ou jogos sem invocar uma das ferramentas acima.
2. Para "jogo do [time] ontem/hoje" → esportes_consultar_jogos_por_time com o nome do time e quando="ontem"/"hoje".
3. Para "jogos do brasileirão hoje" → esportes_consultar_placar_ao_vivo com liga_tag e quando="hoje".
4. PROIBIDO inventar resultados, placares ou datas — os dados do treinamento estão desatualizados.

DIRETRIZ DE UX:
Se não houver jogo para o time/liga na data solicitada, informe amigavelmente e ofereça:
- Consultar a tabela: esportes_consultar_tabela
- Pesquisar próxima partida: web_pesquisar`;
  },

  tools: [
    'esportes_consultar_placar_ao_vivo',
    'esportes_consultar_jogos_por_time',
    'esportes_consultar_tabela',
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 },
};
