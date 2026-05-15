import { getRecentEmails as getOutlookEmails } from '@/lib/microsoft';

export async function executeMicrosoftListarEmails(p: { filtro?: string }): Promise<string> {
  try {
    // Supondo que sua lib microsoft siga o padrão de retornar string formatada
    const emails = await getOutlookEmails(p.filtro, 5, true);
    return `[OUTLOOK]\n${emails || 'Nenhum e-mail recente encontrado no Outlook.'}`;
  } catch (err: any) { 
    return `Erro no Outlook: ${err.message}`; 
  }
}
