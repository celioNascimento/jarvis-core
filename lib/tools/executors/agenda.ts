import { coreConsultarAgenda, coreCriarEvento, coreDeletarEventoPorBusca } from '@/lib/services/agenda.service';
import { getEffectiveUserId } from '@/lib/modules/relationships';

export async function executeConsultarAgenda(p: { dias?: number }, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    return await coreConsultarAgenda(Number(targetId), p.dias);
  } catch (err: any) {
    return `Erro ao consultar agenda: ${err.message}`;
  }
}

export async function executeSalvarEvento(
  p: { 
    titulo: string; data_hora: string; categoria?: string; notas?: string; 
    minutos_lembrete?: number; sincronizar_google?: boolean; forcar?: boolean; 
  }, 
  authUserId: string, numericUserId: string, sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    const result = await coreCriarEvento(Number(targetId), {
      titulo: p.titulo,
      data_hora_inicio: p.data_hora,
      categoria: p.categoria,
      notas: p.notas,
      minutos_lembrete: p.minutos_lembrete ? [p.minutos_lembrete] : [30],
      sincronizar_google: p.sincronizar_google,
      forcar_conflito: p.forcar,
      source: 'lev',
      sessionId: sessionId
    });

    const dataFormatada = result.startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `📅 Sucesso: Evento "${p.titulo}" salvo para ${dataFormatada}.${result.avisoGoogle}`;
  } catch (err: any) { 
    return `Erro ao salvar evento: ${err.message}`; 
  }
}

export async function executeDeletarEvento(
  p: { busca: string }, authUserId: string, numericUserId: string, sessionId: string
): Promise<string> {
  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    const deletados = await coreDeletarEventoPorBusca(Number(targetId), p.busca, sessionId);
    
    if (deletados.length > 0) return `🗑️ ${deletados.length} evento(s) sobre "${p.busca}" removido(s).`;
    return `Nenhum evento encontrado com o termo "${p.busca}".`;
  } catch (err: any) {
    return `Erro ao deletar: ${err.message}`;
  }
}
