import { supabase } from '@/lib/jarvis';

interface CreateReminderParams {
  title: string;
  type: 'temporary' | 'agenda' | 'recurring' | 'location';
  delay_minutes?: number;
  scheduled_time?: string;   // ISO com timezone, ex: "2026-04-10T17:00:00-03:00"
  frequency?: 'daily' | 'weekly' | 'monthly';
  location_trigger?: string; // nome do local (deve existir em favorite_places)
}

export async function createReminderTool(
  params: CreateReminderParams,
  numericUserId: string,
  _authUserId: string
): Promise<string> {
  const { title, type, delay_minutes, scheduled_time, frequency, location_trigger } = params;

  // Validações
  if (!title || title.trim().length === 0) {
    return 'Erro: título do lembrete é obrigatório.';
  }

  if (type === 'temporary') {
    if (!delay_minutes || delay_minutes <= 0) {
      return 'Erro: lembrete temporário precisa de delay_minutes positivo.';
    }
  } else if (type === 'agenda') {
    if (!scheduled_time) {
      return 'Erro: lembrete de agenda precisa de scheduled_time (data/hora).';
    }
    const parsed = new Date(scheduled_time);
    if (isNaN(parsed.getTime())) {
      return 'Erro: scheduled_time inválido. Use formato ISO com timezone.';
    }
  } else if (type === 'recurring') {
    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency)) {
      return 'Erro: lembrete recorrente precisa de frequency (daily, weekly, monthly).';
    }
  } else if (type === 'location') {
    if (!location_trigger || location_trigger.trim().length === 0) {
      return 'Erro: lembrete por localização precisa de location_trigger (ex: "casa", "mercado").';
    }
  } else {
    return `Erro: tipo de lembrete desconhecido: ${type}`;
  }

  let scheduledTime: Date | null = null;
  let delayMins: number | null = null;

  if (type === 'temporary') {
    scheduledTime = new Date(Date.now() + delay_minutes! * 60 * 1000);
    delayMins = delay_minutes!;
  } else if (type === 'agenda') {
    scheduledTime = new Date(scheduled_time!);
  }
  // recurring e location não têm scheduled_time inicial (location será tratado por geofencing)

  const { data, error } = await supabase
    .from('reminders')
    .insert({
      user_id: parseInt(numericUserId, 10),
      title: title.trim(),
      type,
      scheduled_time: scheduledTime?.toISOString() || null,
      delay_minutes: delayMins,
      frequency: frequency || null,
      location_trigger: location_trigger || null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.error('[createReminderTool] Erro ao salvar:', error);
    return `Erro ao salvar lembrete: ${error.message}`;
  }

  // Mensagem de confirmação amigável
  let confirm = `✅ Lembrete "${title}" criado. `;
  if (type === 'temporary') {
    confirm += `Vou te avisar em ${delay_minutes} minutos.`;
  } else if (type === 'agenda') {
    const formatted = new Date(scheduled_time!).toLocaleString('pt-BR');
    confirm += `Agendado para ${formatted}.`;
  } else if (type === 'recurring') {
    const freqText = { daily: 'todos os dias', weekly: 'toda semana', monthly: 'todo mês' }[frequency!];
    confirm += `Vou repetir ${freqText}.`;
  } else if (type === 'location') {
    confirm += `Vou avisar quando você chegar em ${location_trigger}.`;
  }

  return JSON.stringify({ success: true, reminder_id: data.id, message: confirm });
}