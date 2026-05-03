/**
 * REPOSITÓRIO CENTRAL DE MÓDULOS (Tomadas do Jarvis)
 */

export interface ModuleDefinition {
  key: string;
  icon: string;
  label: string;
  description: string;
  settingsKey: string;      // Chave em relationships.settings
  tableName: string;        // Tabela no banco para a IA consultar
  contextLabel: string;     // Rótulo que a IA verá no prompt
}

export const RELATIONSHIP_MODULES: ModuleDefinition[] = [
  {
    key: 'agenda',
    icon: '📅',
    label: 'Agenda',
    description: 'Permitir acesso modular à agenda',
    settingsKey: 'agenda_enabled',
    tableName: 'calendar_events',
    contextLabel: 'PRÓXIMOS COMPROMISSOS'
  },
  {
    key: 'shopping',
    icon: '🛒',
    label: 'Listas de Compras',
    description: 'Permitir acesso modular às listas',
    settingsKey: 'shopping_enabled',
    tableName: 'shopping_items',
    contextLabel: 'LISTA DE COMPRAS'
  },
  {
    key: 'finance',
    icon: '💰',
    label: 'Finanças',
    description: 'Compartilhar contas e gastos',
    settingsKey: 'finance_enabled',
    tableName: 'transactions', // Nome exato da sua tabela SQL
    contextLabel: 'ÚLTIMAS TRANSAÇÕES/FINANÇAS'
  }
];