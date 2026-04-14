// lib/chat/tools-executor.ts
// Dual-ID:
//   authUserId       → favorite_places + shopping_items (UUID do Auth)
//   numericUserIdStr → todas as demais tabelas jarvis (bigint)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';
import { extractDiary } from '@/lib/diary';
import { updateGoalProgress } from '@/lib/diary';
import { getCachedEmbedding } from './embedding-cache';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';

function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`[${context}] userId invalido: esperado numerico, recebido "${id}"`);
  }
}

async function getUserLastLocation(numericUserIdStr: string): Promise<{ lat: number; lng: number } | null> {
  const { data: locData } = await supabase
    .from('config')
    .select('value')
    .eq('key', `last_location_${numericUserIdStr}`)
    .single();

  if (!locData?.value) return null;

  try {
    const parsed = JSON.parse(locData.value);
    const lat = parsed.latitude ?? parsed.lat_approx;
    const lng = parsed.longitude ?? parsed.lng_approx;
    if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    return null;
  } catch {
    return null;
  }
}

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  assertNumericUserId(numericUserIdStr, 'executeTool');

  const { name, arguments: args } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(args);
  } catch {
    return `Erro ao parsear argumentos de ${name}.`;
  }

  async function getPlaceId(nome: string): Promise<string | null> {
    const { data } = await supabase
      .from('favorite_places')
      .select('id')
      .eq('user_id', authUserId)
      .ilike('name', nome.trim())
      .single();
    return data?.id ?? null;
  }

  switch (name) {

    case 'buscar_memoria_longa': {
      const emb = await getCachedEmbedding(p.query);
      const { data: mems } = await supabase.rpc('match_memories', {
        query_embedding: emb,
        match_threshold: 0.4,
        match_count: 5,
      });
      return (
        (mems as any[])
          ?.filter((m) => !m.summary.startsWith('[CINZA]'))
          .map((m) => m.summary)
          .join('\n---\n') || 'Nenhuma memória relevante.'
      );
    }

    case 'consultar_agenda': {
      const [g, o] = await Promise.all([getGoogleContext(), getMicrosoftCalendarContext()]);
      return `Google Calendar:\n${g}\n\nOutlook:\n${o}`;
    }

    case 'listar_emails_recentes':
      return await getRecentEmails(p.filtro, 5, true);

    case 'salvar_evento': {
      const cat = p.titulo.toLowerCase().includes('aniversario') ? 'family' : 'personal';
      await upsertEvent(numericUserIdStr, {
        title: p.titulo,
        event_date: p.data,
        priority: p.prioridade,
        is_recurring: p.recorrente,
        decay_type: p.tipo,
        category: cat,
        emotional_weight: p.prioridade === 'alta' ? 0.9 : p.prioridade === 'media' ? 0.6 : 0.3,
      });
      return `Evento "${p.titulo}" salvo.`;
    }

    // ===================== LEMBRETES =====================

    case 'create_reminder': {
      const title: string = p.title || p.message;
      const frequency: string | undefined = p.frequency || p.recurrence;
      const location_trigger: string | undefined = p.location_trigger;
      let type: 'temporary' | 'agenda' | 'recurring' | 'location' = p.type || 'temporary';

      // 1. Tenta pegar a data que a IA mandou
      let scheduled_time: string | undefined = p.scheduled_time;
      
      // 2. Se ela mandou em minutos (ex: "em 10 min"), converte para data real
      if (!scheduled_time && p.delay_minutes) {
        const fireAt = new Date(Date.now() + p.delay_minutes * 60 * 1000);
        scheduled_time = fireAt.toISOString();
      }

      // 3. SEGURANÇA: Se não tem data e não é um lembrete de lugar/repetição...
      let isFallbackTime = false;
      if (!scheduled_time && type !== 'location' && type !== 'recurring') {
          console.warn(`[create_reminder] IA falhou no tempo. Forçando 5 minutos.`);
          const fireAt = new Date(Date.now() + 5 * 60 * 1000); // Daqui a 5 minutos
          scheduled_time = fireAt.toISOString();
          isFallbackTime = true;
          type = 'temporary'; 
      }

      if (!title) {
        return JSON.stringify({ success: false, error: 'Título é obrigatório.' });
      }

      // 4. Salva no banco (Agora garantimos que scheduled_time não será NULL por erro)
      const { data: reminder, error } = await supabase
        .schema('jarvis')
        .from('reminders')
        .insert({
          user_id: Number(numericUserIdStr),
          title,
          type,
          scheduled_time: scheduled_time || null,
          frequency: frequency || null,
          location_trigger: location_trigger || null,
          status: 'pending',
          metadata: { auth_user_id: authUserId },
        })
        .select('id')
        .single();

      if (error || !reminder) {
        return JSON.stringify({ success: false, error: 'Falha ao salvar no banco.' });
      }

      // 5. Envia para o QStash (O serviço que vai "acordar" o celular na hora certa)
      if (scheduled_time && type !== 'recurring' && type !== 'location') {
        const qstashMessageId = await scheduleReminderOnQStash({
          reminderId: String(reminder.id),
          userId: numericUserIdStr,
          authUserId,
          message: title,
          scheduledTime: scheduled_time,
        });

        if (qstashMessageId) {
          await supabase
            .schema('jarvis')
            .from('reminders')
            .update({ metadata: { auth_user_id: authUserId, qstash_message_id: qstashMessageId } })
            .eq('id', reminder.id);
        }
      }

      const formatted = scheduled_time
        ? new Date(scheduled_time).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit', minute: '2-digit',
          })
        : "quando solicitado";

      // Mensagem que o Assistente vai ler para você
      const avisoIA = isFallbackTime ? " (Agendei para daqui a 5 min porque a data não ficou clara)." : "";

      return JSON.stringify({
        success: true,
        message: `Lembrete "${title}" criado para às ${formatted}.${avisoIA}`,
        reminderId: reminder.id,
      });
    }
    
    case 'cancel_reminder': {
      const reminderId: string = p.reminder_id || p.reminderId;

      if (!reminderId) {
        return JSON.stringify({ success: false, error: 'reminder_id não informado.' });
      }

      const { data: reminder } = await supabase
        .schema('jarvis')
        .from('reminders')
        .select('metadata')
        .eq('id', reminderId)
        .eq('user_id', Number(numericUserIdStr))
        .maybeSingle();

      const qstashMessageId = reminder?.metadata?.qstash_message_id;
      if (qstashMessageId) {
        await cancelReminderOnQStash(qstashMessageId);
      }

      await supabase
        .schema('jarvis')
        .from('reminders')
        .update({ status: 'cancelled' })
        .eq('id', reminderId)
        .eq('user_id', Number(numericUserIdStr));

      return JSON.stringify({ success: true, message: 'Lembrete cancelado.' });
    }

    case 'list_reminders': {
      const { data: reminders } = await supabase
        .schema('jarvis')
        .from('reminders')
        .select('id, title, scheduled_time, frequency, type, status')
        .eq('user_id', Number(numericUserIdStr))
        .eq('status', 'pending')
        .order('scheduled_time', { ascending: true, nullsFirst: false })
        .limit(10);

      if (!reminders?.length) return 'Nenhum lembrete ativo.';

      const lines = reminders.map((r: any) => {
        const dt = r.scheduled_time
          ? new Date(r.scheduled_time).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo',
              day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit',
            })
          : r.frequency || r.type;
        return `• [${r.id}] ${r.title} — ${dt}`;
      });

      return lines.join('\n');
    }

    // ===================== METAS E DIÁRIO =====================

    case 'atualizar_meta':
      return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida);

    case 'registrar_no_diario':
      await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime');
      return 'Entrada registrada no diário.';

    // ===================== PESQUISA =====================

    case 'pesquisar_internet':
    case 'searchWeb': {
      console.log(`[tool] searchWeb: "${p.query}"`);
      const result = await searchWeb(p.query);
      console.log(`[tool] resultado: ${result.substring(0, 200)}`);
      return result;
    }

    case 'getWeatherForecast':
      return await getWeatherForecast(p.lat, p.lng);

    // ===================== LUGARES E LISTAS =====================

    case 'salvar_lugar': {
      const { error } = await supabase.from('favorite_places').upsert(
        {
          user_id: authUserId,
          name: p.nome.trim(),
          lat: p.lat,
          lng: p.lng,
          radius_meters: p.raio_metros,
          category: p.categoria.trim(),
        },
        { onConflict: 'user_id,name' }
      );
      return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo.`;
    }

    case 'remover_lugar':
      await supabase.from('favorite_places').delete().eq('user_id', authUserId).ilike('name', p.nome.trim());
      return `Lugar "${p.nome}" removido.`;

    case 'adicionar_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').upsert(
        { user_id: authUserId, item: p.item.trim(), place_id: pid, done: false },
        { onConflict: 'user_id,item,place_id' }
      );
      return `"${p.item}" adicionado à lista de ${p.lugar}.`;
    }

    case 'marcar_feito': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase
        .from('shopping_items')
        .update({ done: true })
        .eq('user_id', authUserId)
        .ilike('item', p.item.trim())
        .eq('place_id', pid);
      return `"${p.item}" marcado como comprado.`;
    }

    case 'remover_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase
        .from('shopping_items')
        .delete()
        .eq('user_id', authUserId)
        .ilike('item', p.item.trim())
        .eq('place_id', pid);
      return `"${p.item}" removido.`;
    }

    case 'ver_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lista de ${p.lugar} está vazia.`;
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item, done')
        .eq('user_id', authUserId)
        .eq('place_id', pid)
        .order('done');
      if (!itens?.length) return `Lista de ${p.lugar} está vazia.`;
      return `Lista de ${p.lugar}:\n${itens.map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
    }

    // ===================== INSIGHTS =====================

    case 'get_weather_insights': {
      const location = await getUserLastLocation(numericUserIdStr);
      if (!location) return 'Compartilhe sua localização para eu poder dar dicas do clima. 📍';
      try {
        const { getWeatherInsight } = await import('@/lib/insights/weather-insights');
        const { data: userData } = await supabase
          .from('users')
          .select('nickname')
          .eq('id', numericUserIdStr)
          .single();
        return await getWeatherInsight(location.lat, location.lng, userData?.nickname || '');
      } catch (err) {
        console.error('[WeatherInsight] Erro ao carregar módulo:', err);
        return 'Funcionalidade de insights climáticos em desenvolvimento. Em breve! 🌤️';
      }
    }

    default:
      return `Ferramenta ${name} não implementada.`;
  }
}