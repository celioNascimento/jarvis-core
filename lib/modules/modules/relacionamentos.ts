// lib/modules/modules/relacionamentos.ts
// V12 — Zero DB Calls
import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';

export const ModuloRelacionamentos: ModuleDefinition = {
  id: 'relacionamentos',
  label: 'Contatos e Permissões',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    contexts: ['relacao'],
    keywords: /contato|permissão|compartilhar|acesso|liberar|bloquear|giselle/i 
  },
  
  buildContextBlock: async (opts) => {
    try {
      // ✅ Usa o array 'relationships' que já vem no get_consolidated_context
      const rels = (opts as any).masterContext?.relationships;
      
      if (rels && rels.length > 0) {
        const linhas = ['### 🤝 RELACIONAMENTOS (Permissões Ativas)'];
        linhas.push('Você possui conexões ativas. Se o usuário pedir para compartilhar algo, use a ferramenta alternar_permissao_contato se não estiver liberado.');
        return linhas.join('\n');
      }

      // Fallback apenas se o contexto falhar por algum motivo bizarro
      const { data, error } = await supabase
        .from('relationships')
        .select(`id, settings, user_id_a, user_id_b`)
        .eq('status', 'active')
        .or(`user_id_a.eq.${opts.userId},user_id_b.eq.${opts.userId}`);

      if (error || !data?.length) return '';

      const linhas = ['### 🤝 RELACIONAMENTOS (Permissões Ativas)'];
      linhas.push('Você possui conexões ativas. Se o usuário pedir para compartilhar algo, use a ferramenta alternar_permissao_contato se não estiver liberado.');
      return linhas.join('\n');
    } catch (e) {
      return '';
    }
  },

  tools: [
    'alternar_permissao_contato',
    'gerenciar_membros_projeto'
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};
