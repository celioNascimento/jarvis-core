// lib/chat/pipeline/extractors/agenda.extractor.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';
import { coreCriarEvento } from '@/lib/services/agenda.service';
import { coreCriarLembrete } from '@/lib/services/reminders.service';
import { mapCategoriaToCategory } from './helpers';

export interface EventPayload {
  titulo: string;
  data_hora_inicio: string;
  data_hora_fim?: string;
  categoria?: string;
  notas?: string;
  minutos_lembrete?: number[];
  sincronizar_google?: boolean;
  forcar_conflito?: boolean;
  source?: 'lev' | 'app';
  sessionId?: string;
  // Campos para eventos comemorativas
  priority?: string;
  decay_type?: string;
  emotional_weight?: number;
  is_recurring?: boolean;
}

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
    const cleanJson = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleanJson);
    if (!data?.compromissos) return;

    const { data: userData } = await supabase
      .from('users')
      .select('auth_user_id')
      .eq('id', userId)
      .single();

    const authUserId = userData?.auth_user_id;
    if (!authUserId) return;

    for (const comp of data.compromissos) {
      if (!comp.descricao || !comp.data_hora) continue;

      try {
        // Cria o evento via service — inclui checagem de conflito e dedup
        await coreCriarEvento(Number(userId), {
          titulo: comp.descricao,
          data_hora_inicio: comp.data_hora,
          categoria: mapCategoriaToCategory(comp.categoria),
          minutos_lembrete: [comp.aviso_minutos ?? 30],
          source: 'lev',
        });

        // Cria o lembrete de push via service
        const startAt = new Date(comp.data_hora);
        const delayMinutes = comp.aviso_minutos ?? 30;
        const notifyTime = new Date(startAt.getTime() - delayMinutes * 60000);

        if (notifyTime.getTime() > Date.now()) {
          await coreCriarLembrete(Number(userId), authUserId, {
            title: `📅 ${comp.descricao}`,
            type: 'temporary',
            scheduled_time: notifyTime.toISOString(),
            metadata: { auth_user_id: authUserId, source: 'agenda_extractor' },
          });
        }
      } catch (e: any) {
        // Conflito de agenda ou duplicata — ignora silenciosamente
        if (e.message?.includes('CONFLITO_AGENDA')) continue;
        console.error('[Extrator/Agenda] Erro ao processar compromisso:', e.message);
      }
    }
  } catch (e) {
    console.error('[Extrator/Agenda] Erro geral:', e);
  }
}