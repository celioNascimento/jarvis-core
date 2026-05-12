// lib/tools/defs/relationships.ts

export const relationshipsTools = [
  {
    type: 'function',
    function: {
      name: 'alternar_permissao_contato',
      description: `Ativa ou desativa a permissão de compartilhar módulos (como projetos ou listas de compras) com um contato.
Use quando o usuário disser: "Permita que a Giselle acesse meus projetos", "Bloqueie as compras do João", ou "Quero compartilhar listas com a Maria".`,
      parameters: {
        type: 'object',
        properties: {
          contato: {
            type: 'string',
            description: 'Nome ou email da pessoa (ex: "Giselle").',
          },
          modulo: {
            type: 'string',
            enum: ['shopping_enabled', 'projects_enabled'],
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