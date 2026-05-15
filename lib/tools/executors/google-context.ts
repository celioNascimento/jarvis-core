// lib/tools/executors/google-context.ts
import { trashGoogleEmail } from '@/lib/google'; 

// Se você não tiver uma função específica para listar e-mails no @/lib/google, 
// o Jarvis usará o executor consolidado.
export async function executeGoogleListarEmails(p: { filtro?: string }): Promise<string> {
  try {
    // Aqui, se no futuro você criar uma 'listGmailEmails' no @/lib/google, você troca aqui.
    return "Busca no Gmail pendente de implementação específica no @/lib/google.";
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
