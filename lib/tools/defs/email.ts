// lib/tools/defs/email.ts
// V1.0.0 — Definições do Módulo de E-mails (Google & Microsoft)

export const emailTools = [
  {
    type: 'function',
    function: {
      name: 'email_listar_recentes',
      description: 'Busca e lista os e-mails recentes do usuário para obter contexto, ler newsletters, checar notas fiscais, voos ou informações importantes recebidas. NÃO use para agendar compromissos ou criar tarefas.',
      parameters: {
        type: 'object',
        properties: {
          filtro: { 
            type: 'string', 
            description: 'Termo de busca ou palavra-chave para filtrar os e-mails (ex: nome de empresa, remetente, assunto).' 
          },
          provedor: { 
            type: 'string', 
            enum: ['google', 'outlook', 'ambos'],
            description: 'Provedor específico a ser consultado. Se omitido, buscará em ambos por padrão.',
            default: 'ambos'
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_excluir',
      description: 'Envia um e-mail específico para a lixeira/trash com base no ID da mensagem e no provedor correto.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { 
            type: 'string', 
            description: 'O ID único da mensagem de e-mail que deve ser excluída.' 
          },
          provedor: { 
            type: 'string', 
            enum: ['google', 'outlook'],
            description: 'O provedor de e-mail onde a mensagem reside (obrigatório).' 
          },
        },
        required: ['messageId', 'provedor'],
      },
    },
  }
];
