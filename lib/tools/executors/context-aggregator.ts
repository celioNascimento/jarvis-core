import { executeGoogleListarEmails } from './google-context';
import { executeMicrosoftListarEmails } from './microsoft-context';

export async function executeConsultarComunicacoes(
  p: { filtro?: string; provedor?: 'google' | 'outlook' | 'ambos' }
): Promise<string> {
  const targetProvider = p.provedor ?? 'ambos';
  
  const tasks = [];
  if (targetProvider === 'ambos' || targetProvider === 'google') {
    tasks.push(executeGoogleListarEmails({ filtro: p.filtro }));
  }
  if (targetProvider === 'ambos' || targetProvider === 'outlook') {
    tasks.push(executeMicrosoftListarEmails({ filtro: p.filtro }));
  }

  const results = await Promise.all(tasks);
  return results.join('\n\n---\n\n');
}
