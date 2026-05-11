// Barrel: agrega todas as definições de ferramentas por domínio
// Substitui lib/chat/tools-def.ts

import { memoryTools }   from './memory';
import { agendaTools }   from './agenda';
import { lugaresTools }  from './lugares';
import { veiculosTools } from './veiculos';
import { tdahTools }     from './tdah';
import { financesTools } from './finances';
import { projectsTools } from '../tools/definitions/projects';

export const tools = [
  ...memoryTools,
  ...agendaTools,
  ...financesTools,
  ...lugaresTools,
  ...veiculosTools,
  ...tdahTools,
  ...projectsTools,
];

// Re-exports individuais — úteis para testes ou feature flags
 export { memoryTools, agendaTools, financesTools, lugaresTools, veiculosTools, tdahTools, projectsTools };
