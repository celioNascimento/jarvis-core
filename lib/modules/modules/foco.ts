// lib/modules/modules/foco.ts
// V13.0.0 — Arquitetura V2 (Sinal de fumaça): Redução drástica de payload estático

import type { ModuleDefinition } from '../types';

export const ModuloFoco: ModuleDefinition = {
  id: 'foco',
  label: 'Gerenciamento de Foco e Produtividade (TDAH)',
  preferredModel: 'flash',
  plan: 'free',
  version: 'v2', // ← OFICIALMENTE V2
  trigger: {
    contexts: ['tdah', 'foco'],
    keywords: /foco|procrastinando|travado|paralisado|sobrecarregado|por onde começo|não sei começar|despejo mental|matriz de eisenhower|pomodoro|ferramentas para foco|ajuda para focar|estacionamento de ideias|sessão de implementação|fifo/i
  },
  
  buildContextBlock: async () => {
    // V2: Remoção do bloco gigante de texto. 
    // Mantemos apenas um gatilho comportamental restrito (Blindagem) e o roteamento das tools.
    return `[Módulo: Foco e TDAH] Ativo. Postura: Guardião de Escopo (bloqueie demandas fora do roteiro nos projetos 'Procuro Quem Faça' ou 'ExpertFrotas', aplique FIFO e envie distrações para o 'Estacionamento de Ideias'). Ferramentas de apoio prontas para uso: 'tdah_quebrar_tarefa', 'tdah_registrar_despejo_mental', 'tdah_gerenciar_eisenhower' e 'tdah_registrar_sessao_foco'.`;
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
