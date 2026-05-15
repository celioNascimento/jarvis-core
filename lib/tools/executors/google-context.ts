import { getRecentEmails, trashGoogleEmail } from '@/lib/google';

export async function executeGoogleListarEmails(p: { filtro?: string }): Promise<string> {
  try {
    const emails = await getRecentEmails(p.filtro, 5, true);
    return `[GMAIL]\n${emails || 'Nenhum e-mail recente encontrado.'}`;
  } catch (err: any) { 
    return `Erro no Gmail: ${err.message}`; 
  }
}

export async function executeGoogleExcluirEmail(p: { messageId: string }): Promise<string> {
  try {
    return await trashGoogleEmail(p.messageId);
  } catch (err: any) { 
    return `Erro ao excluir no Gmail: ${err.message}`; 
  }
}
