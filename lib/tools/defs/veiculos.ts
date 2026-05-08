// Definições de ferramentas: Veículos (ExpertFrotas)

export const veiculosTools = [
  {
    type: 'function',
    function: {
      name: 'registrar_abastecimento',
      description: 'Registra abastecimento de combustível.',
      parameters: {
        type: 'object',
        properties: {
          vehicle_name: { type: 'string' },
          fuel_type: { type: 'string', enum: ['gasoline', 'ethanol', 'diesel', 'gnv', 'electric'] },
          total_cost: { type: 'number' },
          odometer: { type: 'integer' },
          liters: { type: 'number' },
        },
        required: ['vehicle_name', 'fuel_type', 'total_cost', 'odometer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atualizar_odometro',
      description: 'Atualiza a quilometragem atual do veículo.',
      parameters: {
        type: 'object',
        properties: {
          vehicle_name: { type: 'string' },
          odometer: { type: 'integer' },
        },
        required: ['vehicle_name', 'odometer'],
      },
    },
  },
];