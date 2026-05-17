// lib/modules/modules/foco.ts
// V1.0.1 — Alinhamento de Capabilities de Foco (Evita Alucinações de Bloqueio de Apps)

import type { ModuleDefinition } from '../types';

export const ModuloFoco: ModuleDefinition = {
  id: 'foco',
  label: 'Gerenciamento de Foco e Produtividade (TDAH)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['tdah', 'foco'],
    keywords: /foco|procrastinando|travado|paralisado|sobrecarregado|por onde começo|não sei começar|despejo mental|matriz de eisenhower|pomodoro|ferramentas para foco|ajuda para focar/i
  },
  buildContextBlock: async () => {
    return `[MÓDULO DE FOCO E TDAH ATIVO]
CRÍTICO: Quando o usuário perguntar quais ferramentas você possui para foco, produtividade ou TDAH, você deve listar EXCLUSIVAMENTE as suas capacidades programáticas reais mapeadas no sistema.
PROIBIDO alucinar que possui extensões para bloquear sites/aplicativos externos ou que gerencia timers visuais nativos de Pomodoro.

Suas Ferramentas Reais Disponíveis no Sistema:
1. Quebra de Tarefas Complexas (via 'tdah_quebrar_tarefa'): Fatia demandas pesadas e assustadoras em micro-passos ridiculamente simples para vencer a paralisia por análise.
2. Despejo Mental (via 'tdah_registrar_despejo_mental'): Registra e limpa fluxos brutos de pensamentos, preocupações ou insights para esvaziar a cabeça do usuário sem julgamentos.
3. Matriz de Eisenhower (via 'tdah_gerenciar_eisenhower'): Organiza e prioriza tarefas de forma estrita através de quadrantes de Urgência e Importância.
4. Sessões de Hiperfoco (via 'tdah_registrar_sessao_foco'): Inicializa e computa blocos de tempo dedicados à implementação limpa de projetos.

Diretriz: Responda em tom amigável e direto, cite exatamente esse menu de opções reais de engenharia acima e pergunte por qual dessas estratégias de alívio cognitivo o usuário deseja começar agora.`;
  },
  tools: [
    'tdah_gerenciar_eisenhower',
    'tdah_quebrar_tarefa',
    'tdah_registrar_despejo_mental',
    'tdah_registrar_sessao_foco',
    'tdah_consultar_resumo'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
