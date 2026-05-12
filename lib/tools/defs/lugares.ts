// lib/tools/defs/lugares.ts
// Definições: Lugares Favoritos
// Compras foram movidas para defs/compras.ts

export const lugaresTools = [
  {
    type: 'function',
    function: {
      name: 'salvar_lugar',
      description:
        'Salva um lugar favorito com coordenadas GPS e raio de proximidade. Use quando o usuário mencionar um endereço, estabelecimento ou ponto de referência que ele quer guardar.',
      parameters: {
        type: 'object',
        properties: {
          nome:        { type: 'string', description: 'Nome do lugar (ex: "Mercado São João").' },
          lat:         { type: 'number', description: 'Latitude.' },
          lng:         { type: 'number', description: 'Longitude.' },
          raio_metros: { type: 'number', description: 'Raio de alerta em metros. Padrão: 200.' },
          categoria:   { type: 'string', description: 'Categoria livre (ex: "mercado", "academia", "trabalho").' },
        },
        required: ['nome', 'lat', 'lng', 'raio_metros', 'categoria'],
      },
    },
  },
];
