// lib/tools/defs/index.ts
// Barrel: agrega todas as definições de ferramentas por domínio

import { memoryTools }   from './memory';
import { agendaTools }   from './agenda';
import { lugaresTools }  from './lugares';
import { comprasTools }  from './compras';
import { veiculosTools } from './veiculos';
import { tdahTools }     from './tdah';
import { financesTools } from './finances';
import { projectsTools } from './projects';
import { guidelinesTools } from './guidelines';
import { relationshipsTools } from './relationships';

export const tools = [
  ...memoryTools,
  ...agendaTools,
  ...financesTools,
  ...lugaresTools,
  ...comprasTools,
  ...veiculosTools,
  ...tdahTools,
  ...projectsTools,
  ...guidelinesTools,
  ...relationshipsTools,
];

// Re-exports individuais — úteis para testes ou feature flags
export {
  memoryTools,
  agendaTools,
  financesTools,
  lugaresTools,
  comprasTools,
  veiculosTools,
  tdahTools,
  projectsTools,
  guidelinesTools,
  relationshipsTools
};
