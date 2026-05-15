// lib/chat/pipeline/extractors/agenda.extractor.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';
import { scheduleReminderOnQStash } from '@/lib/qstash';
import { mapCategoriaToCategory } from './helpers';

export async function extractAgenda(userId: string, userMessage: string): Promise<void> {
  const anoAtual = new Date().getFullYear();
  const mesAtual = String(new Date().getMonth() + 1).padStart(2, '0');
  const diaAtual = String(new Date().getDate()).padStart(2, '0');

  const prompt = [
    {
      role: 'system',
      content: 'Você é um parser de dados invisível de um sistema TDAH. NUNCA envie introduções ou saudações. Retorne EXCLUSIVAMENTE um objeto JSON válido.'
    },
    {
      role: 'user',
      content: `Extraia compromissos com data E hora explícitas mencionados pelo USUÁRIO.
      Retorne APENAS o JSON estruturado:
      {"compromissos": [{"descricao": "Título claro", "data_hora": "ISO 8601 fuso -03:00", "categoria": "Saúde|Trabalho|Escola|Família|Pessoal", "aviso_minutos": 30}]}

      ANO ATUAL: ${anoAtual}. Data de hoje: ${anoAtual}-${mesAtual}-${diaAtual}.
      
      Mensagem: "${userMessage}"`
    }
  ];

  try {
    const raw = await callOpenRouter(prompt as any, "google/gemini-2.0-flash-001", 0.1, 4);
    let cleanJson = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleanJson);
    if (!data?.compromissos) return;

    const { data: userData } = await supabase.from('users').select('auth_user_id').eq('id', userId).single();
    const authUserId = userData?.auth_user_id;

    for (const comp of data.compromissos) {
      if (!comp.descricao || !comp.data_hora) continue;

      const startAt = new Date(comp.data_hora);
      if (isNaN(startAt.getTime())) continue;

      const endAt = new Date(startAt.getTime() + 3600000);

      // Checa duplicata
      const { data: duplicate } = await supabase.schema('jarvis').from('events')
        .select('id').eq('user_id', Number(userId)).eq('title', comp.descricao).eq('start_at', startAt.toISOString()).maybeSingle();

      if (duplicate) continue;

      const { error: evError } = await supabase.schema('jarvis').from('events').insert({
        user_id: Number(userId),
        title: comp.descricao,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        all_day: false,
        category: mapCategoriaToCategory(comp.categoria),
        source: 'lev',
        reminder_minutes: [comp.aviso_minutos ?? 30],
      });

      if (evError) continue;

      // Configura push antecipado com QStash
      if (authUserId) {
        const delayMinutes = comp.aviso_minutos ?? 30;
        const notifyTime = new Date(startAt.getTime() - delayMinutes * 60000).toISOString();

        if (new Date(notifyTime).getTime() > Date.now()) {
          const { data: reminder } = await supabase.schema('jarvis').from('reminders').insert({
            user_id: Number(userId),
            title: `📅 ${comp.descricao}`,
            type: 'agenda',
            scheduled_time: notifyTime,
            status: 'pending',
            metadata: { auth_user_id: authUserId },
          }).select('id').single();

          if (reminder) {
            const qstashId = await scheduleReminderOnQStash({
              reminderId: String(reminder.id),
              userId,
              authUserId,
              message: `📅 [Agenda] ${comp.descricao}`,
              scheduledTime: notifyTime,
            });

            if (qstashId) {
              await supabase.schema('jarvis').from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[Extrator/Agenda] Erro ao processar:', e);
  }
}