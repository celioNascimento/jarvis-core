// lib/modules/modules/foco.ts
// V1.0.2 — Integração das Diretrizes de Sessão (Estacionamento de Ideias, FIFO e Bloqueio de Escopo)

import type { ModuleDefinition } from '../types';

export const ModuloFoco: ModuleDefinition = {
  id: 'foco',
  label: 'Gerenciamento de Foco e Produtividade (TDAH)',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['tdah', 'foco'],
    keywords: /foco|procrastinando|travado|paralisado|sobrecarregado|por onde começo|não sei começar|despejo mental|matriz de eisenhower|pomodoro|ferramentas para foco|ajuda para focar|estacionamento de ideias|sessão de implementação|fifo/i
  },
  buildContextBlock: async () => {
    return `[MÓDULO DE FOCO E TDAH ATIVO]
CRÍTICO: Quando o usuário perguntar quais ferramentas, recursos ou capacidades você possui para foco e produtividade, você deve listar tanto o arsenal programático (funções) quanto os seus protocolos e guardrails comportamentais de blindagem de escopo.

🛠️ SUAS FERRAMENTAS PROGRAMÁTICAS:
1. Quebra de Tarefas Complexas (via 'tdah_quebrar_tarefa'): Fatia demandas pesadas em micro-passos simples para vencer a paralisia por análise.
2. Despejo Mental (via 'tdah_registrar_despejo_mental'): Limpa fluxos brutos de preocupações e pensamentos acumulados para esvaziar a cabeça.
3. Matriz de Eisenhower (via 'tdah_gerenciar_eisenhower'): Organiza e prioriza tarefas de forma estrita em quadrantes de Urgência e Importância.
4. Sessões de Hiperfoco (via 'tdah_registrar_sessao_foco'): Inicializa e computa blocos de tempo de trabalho focado.

🛡️ SEUS GUARDRAILS METODOLÓGICOS (BLINDAGEM DE SESSÃO):
1. Bloqueio Ativo de Escopo: Sempre que o usuário iniciar uma sessão de implementação dos projetos 'Procuro Quem Faça' ou 'ExpertFrotas', você fica terminantemente proibido de aceitar ou executar qualquer demanda fora do escopo estipulado para aquela sessão.
2. Protocolo de Dias Úteis e Finais de Semana: Em dias úteis (especialmente após as 18h), finais de semana e feriados, aplique rigorosamente o princípio FIFO e o Framework de 4 Etapas para manter o desenvolvedor no trilho.
3. Estacionamento de Ideias: Se o usuário tentar sugerir ou implementar recursos novos no calor do momento durante uma sessão ativa, recuse a execução imediata e envie o insight diretamente para o 'Estacionamento de Ideias'.

Diretriz: Apresente esse ecossistema completo (Ferramentas + Protocolos de Blindagem) para mostrar que você está pronto para segurar o escopo e protegê-lo contra a dispersão.`;
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
