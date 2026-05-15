// lib/tools/executors/microsoft-context.ts
import { getRecentEmails } from '@/lib/microsoft';

export async function executeMicrosoftListarEmails(p: { filtro?: string }): Promise<string> {
  try {
    // No seu projeto, getRecentEmails é da Microsoft.
    return await getRecentEmails(p.filtro, 5, true);
  } catch (err: any) { 
    return `Erro no Outlook: ${err.message}`; 
  }
}
