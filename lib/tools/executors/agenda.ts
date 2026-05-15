// lib/tools/executors/agenda.ts (Trecho de criar evento)
import { coreCriarEvento } from '@/lib/services/agenda.service';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { invalidateMasterContextCache } from '@/lib/chat/pipeline/intelligence';

export async function executeSalvarEvento(
  p: { 
    titulo: string; data_hora: string; categoria?: string; notas?: string; 
    minutos_lembrete?: number; sincronizar_google?: boolean; forcar?: boolean; 
  }, 
  authUserId: string, 
  numericUserId: string, 
  sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    // Entrega para a Cozinha (Service)
    const result = await coreCriarEvento(Number(targetId), {
      titulo: p.titulo,
      data_hora_inicio: p.data_hora,
      categoria: p.categoria,
      notas: p.notas,
      minutos_lembrete: p.minutos_lembrete ? [p.minutos_lembrete] : [30],
      sincronizar_google: p.sincronizar_google,
      forcar_conflito: p.forcar,
      source: 'lev'
    });

    // Limpa a Memória RAM do chat para ele lembrar do evento instantaneamente
    await invalidateMasterContextCache(Number(targetId), sessionId);

    const dataFormatada = result.startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `📅 Sucesso: Evento "${p.titulo}" salvo para ${dataFormatada}.${result.avisoGoogle}`;

  } catch (err: any) { 
    // Captura o erro customizado do Service e retorna de forma amigável para a IA
    return `Erro ao salvar: ${err.message}`; 
  }
}
