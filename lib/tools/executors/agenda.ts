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
  // Validação do título
  const tituloLimpo = p.titulo?.trim() ?? '';
  const TITULOS_INVALIDOS = ['evento', 'compromisso', 'reunião', 'tarefa', 'lembrete', 'item'];
  if (tituloLimpo.length < 3 || TITULOS_INVALIDOS.includes(tituloLimpo.toLowerCase())) {
    return `Erro: título "${p.titulo}" é genérico demais. Informe um título descritivo (ex: "Consulta Dr. Adriano", "Reunião com cliente").`;
  }

  // Validação da data
  const dataISO = new Date(p.data_hora);
  if (isNaN(dataISO.getTime())) {
    return `Erro: data/hora inválida "${p.data_hora}". Use o formato ISO (ex: 2026-05-16T14:00:00).`;
  }
  if (dataISO < new Date()) {
    return `Erro: não é possível agendar eventos no passado (${p.data_hora}).`;
  }

  try {
    const targetId = await getEffectiveUserId(authUserId, numericUserId);
    
    const result = await coreCriarEvento(Number(targetId), {
      titulo:           tituloLimpo,
      data_hora_inicio: p.data_hora,
      categoria:        p.categoria,
      notas:            p.notas,
      minutos_lembrete: p.minutos_lembrete ? [p.minutos_lembrete] : [30],
      sincronizar_google: p.sincronizar_google,
      forcar_conflito:  p.forcar,
      source:           'lev',
      sessionId,
    });

    const dataFormatada = result.startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `📅 Evento "${tituloLimpo}" salvo para ${dataFormatada}.${result.avisoGoogle ?? ''}`;

  } catch (err: any) {
    // Instrui o modelo a agir em vez de perguntar
    if (err.message?.includes('CONFLITO_DETECTADO') || err.message?.includes('conflito')) {
      return `CONFLITO_DETECTADO: Já existe um evento neste horário. Para forçar o agendamento, chame agenda_salvar_evento novamente com forcar: true.`;
    }
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
