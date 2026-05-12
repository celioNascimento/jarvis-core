// lib/modules/relacionamentos.ts
import type { ModuleDefinition } from '../types';
import { supabase } from '@/lib/jarvis';

export const ModuloRelacionamentos: ModuleDefinition = {
  id: 'relacionamentos',
  label: 'Contatos e Permissões',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    // Isso bate exatamente com o log que você mostrou: contextos: ['relacao']
    contexts: ['relacao', 'contatos', 'familia'],
    // Gatilhos de intenção para forçar a ativação do módulo
    keywords: /contato|permissão|compartilhar|acesso|liberar|bloquear|giselle/i 
  },
  
  buildContextBlock: async (opts) => {
    // Busca as conexões ativas do usuário e quais módulos estão liberados
    const { data, error } = await supabase
      .from('relationships')
      .select(`
        id,
        settings,
        user_id_a,
        user_id_b
      `)
      .eq('status', 'active')
      .or(`user_id_a.eq.${opts.userId},user_id_b.eq.${opts.userId}`);

    if (error || !data?.length) return '';

    // Como os nomes dos usuários estão na tabela 'users', para economizar queries,
    // vamos listar as permissões de forma genérica para a IA ter o estado atual.
    const linhas = ['### 🤝 RELACIONAMENTOS (Permissões Ativas)'];

    linhas.push('Você possui conexões ativas. Se o usuário pedir para compartilhar algo, use a ferramenta alternar_permissao_contato se não estiver liberado.');

    // Nota técnica: Idealmente, faríamos um JOIN com a tabela 'users' aqui para
    // buscar o nome de quem é o A ou B. Mas só saber que existem permissões ativas
    // já ajuda o Jarvis a tomar a decisão de não negar acesso de imediato.

    return linhas.join('\n');
  },

  // Aqui as ferramentas finalmente "nascem" para a IA
  tools: [
    'alternar_permissao_contato', // A tool que liga/desliga JSONB
    'gerenciar_membros_projeto'   // Opcional, mas faz sentido a IA poder rodar isso aqui também
  ],
  
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};