// lib/tools/defs/relationships.ts
export const relationshipsTools = [
  {
    type: 'function',
    function: {
      name: 'contato_alternar_permissao', // Padronizado com prefixo
      description: `Ativa ou desativa a permissão de compartilhar módulos com um contato ativo.
Use para comandos como: "Permita que a Giselle veja minha agenda", "Bloqueie as compras do João", ou "Quero compartilhar projetos com a Maria".`,
      parameters: {
        type: 'object',
        properties: {
          contato: {
            type: 'string',
            description: 'Nome ou email da pessoa (ex: "Giselle").',
          },
          modulo: {
            type: 'string',
            enum: ['shopping_enabled', 'projects_enabled', 'agenda_enabled'], // AGENDA ADICIONADA AQUI
            description: 'Qual módulo está sendo liberado ou bloqueado.',
          },
          habilitar: {
            type: 'boolean',
            description: 'true para liberar/compartilhar, false para bloquear/revogar.',
          },
        },
        required: ['contato', 'modulo', 'habilitar'],
      },
    },
  },
];
