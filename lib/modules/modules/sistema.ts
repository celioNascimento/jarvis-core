// lib/modules/sistema.ts
import type { ModuleDefinition } from '../types';

export const ModuloSistema: ModuleDefinition = {
  id: 'sistema',
  label: 'Configurações e Diretrizes',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    // Aqui capturamos o 'perfil' que o Extrator está gerando, além de outros úteis
    contexts: ['perfil', 'sistema', 'alias'],
    keywords: /diretriz|diretrizes|regra|comportamento|perfil|permissão|guideline/i
  },
  
  buildContextBlock: async () => {
    return `### ⚙️ MÓDULO DE SISTEMA E PERFIL
Você está no modo de configuração de sistema. Use as ferramentas disponíveis para alterar suas próprias diretrizes (system prompts), registrar seu apelido/alias, ou ajustar as permissões de compartilhamento com outros contatos.`;
  },

  // Aqui nós entregamos as chaves do castelo para a IA!
  tools: [
    'adicionar_diretriz_dinamica', 
    'gerenciar_guideline',         
    'alternar_permissao_contato'   
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};