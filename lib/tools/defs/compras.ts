// lib/tools/defs/compras.ts
// Definições: Lista de Compras
// Separado de lugares.ts — domínios distintos.

export const comprasTools = [
  {
    type: 'function',
    function: {
      name: 'adicionar_item_lista',
      description:
        'Adiciona um item à lista de compras. O lugar é opcional — se omitido, o item fica na lista geral. O project_id também é opcional: use apenas quando o item pertencer a um projeto específico (ex: materiais de reforma).',
      parameters: {
        type: 'object',
        properties: {
          item: {
            type: 'string',
            description: 'Nome do item a comprar (ex: "cimento", "detergente").',
          },
          lugar: {
            type: 'string',
            description: 'Nome do lugar favorito onde comprar. Omitir para lista geral.',
          },
          category: {
            type: 'string',
            enum: ['mercado', 'higiene', 'farmacia', 'academia', 'reforma', 'casa', 'roupas', 'tecnologia', 'outros'],
            description: 'Categoria do item. Padrão: "outros".',
          },
          project_id: {
            type: 'string',
            description: 'Nome, Tag ou UUID do projeto (ex: "reforma banheiro"). Omitir se for uma compra pessoal comum.',
          },
        },
        required: ['item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_lista',
      description: 'Mostra a lista de compras de um lugar favorito.',
      parameters: {
        type: 'object',
        properties: {
          lugar: { type: 'string', description: 'Nome do lugar favorito.' },
        },
        required: ['lugar'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'marcar_item_comprado',
      description: 'Marca um item da lista como comprado.',
      parameters: {
        type: 'object',
        properties: {
          item:  { type: 'string', description: 'Nome do item.' },
          lugar: { type: 'string', description: 'Nome do lugar. Omitir busca em todas as listas.' },
        },
        required: ['item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_compras_projeto',
      description:
        'Lista todos os itens de compra vinculados a um projeto. Use quando o usuário perguntar "o que falta comprar para [projeto]" ou pedir a lista de materiais de um projeto.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Nome, Tag ou UUID do projeto. Envie apenas o nome se não souber o UUID.',
          },
        },
        required: ['project_id'],
      },
    },
  },
];
