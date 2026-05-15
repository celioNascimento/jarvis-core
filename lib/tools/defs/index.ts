import { memoryTools }   from './memory';
import { agendaTools }   from './agenda';
import { remindersTools} from './reminders'; // ← NOVO
import { lugaresTools }  from './lugares';
import { comprasTools }  from './compras';
import { veiculosTools } from './veiculos';
import { tdahTools }     from './tdah';
import { financesTools } from './finances';
import { projectsTools } from './projects';
import { guidelinesTools } from './guidelines';
import { relationshipsTools } from './relationships';

type ToolDef = {
  type: string;
  function?: {
    name: string;
    description: string;
    parameters?: any;
  };
};

export const tools: ToolDef[] = [
  ...memoryTools,
  ...agendaTools,
  ...remindersTools,
  ...financesTools,
  ...lugaresTools,
  ...comprasTools,
  ...veiculosTools,
  ...tdahTools,
  ...projectsTools,
  ...guidelinesTools,
  ...relationshipsTools,
];


export {
  memoryTools,
  agendaTools,
  remindersTools,
  financesTools,
  lugaresTools,
  comprasTools,
  veiculosTools,
  tdahTools,
  projectsTools,
  guidelinesTools,
  relationshipsTools
};