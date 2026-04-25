// lib/chat/tools-executor.ts
// Dual-ID:
//   authUserId       → favorite_places + shopping_items (UUID do Auth)
//   numericUserIdStr → todas as demais tabelas jarvis (bigint)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';
import { extractDiary } from '@/lib/diary';
import { updateGoalProgress } from '@/lib/diary';
import { getCachedEmbedding } from './embedding-cache';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { handleSalvarEvento } from './tools-executor-agenda-patch';
import {
  executeRegistrarTransacao,
  executeConsultarFinancas,
  executeCriarOrcamento,
  executeListarOrcamentos,
} from '@/lib/finances/executor';


function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`[${context}] userId invalido: esperado numerico, recebido "${id}"`);
  }
}

async function getUserLastLocation(numericUserIdStr: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const { data: locData, error } = await supabase
      .from('config')
      .select('value')
      .eq('key', `last_location_${numericUserIdStr}`)
      .single();

    if (error || !locData?.value) return null;

    const parsed = JSON.parse(locData.value);
    const lat = parsed.latitude ?? parsed.lat_approx;
    const lng = parsed.longitude ?? parsed.lng_approx;
    if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    return null;
  } catch (err) {
    console.error('[ToolsExecutor] Erro ao buscar última localização:', err);
    return null;
  }
}

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  try {
    assertNumericUserId(numericUserIdStr, 'executeTool');
  } catch (err: any) {
    console.error(err.message);
    return `Erro interno: ${err.message}`;
  }

  const { name, arguments: args } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(args);
  } catch {
    return `Erro ao parsear argumentos de ${name}.`;
  }

  async function getPlaceId(nome: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('favorite_places')
        .select('id')
        .eq('user_id', authUserId)
        .ilike('name', nome.trim())
        .single();
        
      if (error) throw error;
      return data?.id ?? null;
    } catch (err) {
      console.error('[ToolsExecutor] Erro em getPlaceId:', err);
      return null;
    }
  }

  switch (name) {

    case 'buscar_memoria_longa': {
      try {
        const emb = await getCachedEmbedding(p.query);
        const { data: mems, error } = await supabase.rpc('match_memories', {
          query_embedding: emb,
          match_threshold: 0.4,
          match_count: 5,
        });
        
        if (error) throw error;

        return (
          (mems as any[])
            ?.filter((m) => !m.summary.startsWith('[CINZA]'))
            .map((m) => m.summary)
            .join('\n---\n') || 'Nenhuma memória relevante.'
        );
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em buscar_memoria_longa:', err);
        return 'Falha ao acessar memórias no momento. O banco de dados pode estar indisponível.';
      }
    }

    case 'consultar_agenda': {
      try {
        // Usando Promise.allSettled para evitar que uma falha derrube ambas as requisições
        const results = await Promise.allSettled([
          getGoogleContext().catch(e => `[Erro Google: ${e.message || 'Falha na autenticação'}]`),
          getMicrosoftCalendarContext().catch(e => `[Erro Outlook: ${e.message || 'Falha na autenticação'}]`)
        ]);

        const g = results[0].status === 'fulfilled' ? results[0].value : `[Erro Google: Falha na promessa]`;
        const o = results[1].status === 'fulfilled' ? results[1].value : `[Erro Outlook: Falha na promessa]`;
        
        return `Google Calendar:\n${g}\n\nOutlook:\n${o}`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro crítico em consultar_agenda:', err);
        return 'Ocorreu um erro interno ao tentar consultar as agendas. Solicite que o usuário verifique as conexões das contas.';
      }
    }

    // ===================== AGENDA E GMAIL =====================

    case 'criar_evento_agenda': {
      try {
        return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30);
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em criar_evento_agenda:', err);
        return `Erro ao criar evento na agenda: ${err.message || 'Verifique a autenticação do Google.'}`;
      }
    }

    case 'excluir_email': {
      try {
        return await trashGoogleEmail(p.messageId);
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em excluir_email:', err);
        return `Erro ao excluir email: ${err.message || 'Verifique a autenticação do Google.'}`;
      }
    }

    // ===================== GESTÃO DE DIRETRIZES DINÂMICAS =====================

    case 'adicionar_diretriz_dinamica': {
      try {
        const { error } = await supabase.rpc('upsert_dynamic_guideline', {
          p_user_id: Number(numericUserIdStr),
          p_content: p.content,
          p_scope: p.scope || 'personal'
        });

        if (error) {
          console.error('[Tools] Erro ao adicionar diretriz:', error);
          return `Erro ao salvar a diretriz: ${error.message}`;
        }

        return `Diretriz "${p.content}" salva com sucesso na base de dados. O comportamento será ajustado.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro inesperado em adicionar_diretriz_dinamica:', err);
        return `Erro inesperado ao salvar diretriz: ${err.message}`;
      }
    }

    // =================================================================

    case 'listar_emails_recentes':
      try {
        return await getRecentEmails(p.filtro, 5, true);
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em listar_emails_recentes:', err);
        return `Erro ao buscar emails: ${err.message || 'Falha na conexão com a conta de email.'}`;
      }

    case 'salvar_evento': {
      try {
        return await handleSalvarEvento(args, authUserId, numericUserIdStr);
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em salvar_evento:', err);
        return `Erro ao processar e salvar o evento: ${err.message}`;
      }
    }

    // ===================== LEMBRETES =====================

    case 'create_reminder': {
      try {
        const title: string = p.title || p.message;
        const frequency: string | undefined = p.frequency || p.recurrence;
        const location_trigger: string | undefined = p.location_trigger;
        let type: 'temporary' | 'agenda' | 'recurring' | 'location' = p.type || 'temporary';

        let scheduled_time: string | undefined = p.scheduled_time;

        if (!scheduled_time && p.delay_minutes) {
          const fireAt = new Date(Date.now() + p.delay_minutes * 60 * 1000);
          scheduled_time = fireAt.toISOString();
        }

        let isFallbackTime = false;
        if (!scheduled_time && type !== 'location' && type !== 'recurring') {
          console.warn(`[create_reminder] IA falhou no tempo. Forçando 5 minutos.`);
          const fireAt = new Date(Date.now() + 5 * 60 * 1000);
          scheduled_time = fireAt.toISOString();
          isFallbackTime = true;
          type = 'temporary';
        }

        if (!title) {
          return JSON.stringify({ success: false, error: 'Título é obrigatório.' });
        }

        // FIX: removido .schema('jarvis') redundante — client já tem schema padrão
        const { data: reminder, error } = await supabase
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

        console.log('[create_reminder] insert result:', { reminder, error });

        if (error || !reminder) {
          console.error('[create_reminder] Falha no insert:', error?.message);
          return JSON.stringify({ success: false, error: 'Falha ao salvar no banco.' });
        }

        if (scheduled_time && type !== 'recurring' && type !== 'location') {
          const qstashMessageId = await scheduleReminderOnQStash({
            reminderId: String(reminder.id),
            userId: numericUserIdStr,
            authUserId,
            message: title,
            scheduledTime: scheduled_time,
          });

          if (qstashMessageId) {
            // FIX: removido .schema('jarvis') redundante
            await supabase
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
          : 'quando solicitado';

        const avisoIA = isFallbackTime ? ' (Agendei para daqui a 5 min porque a data não ficou clara).' : '';

        return JSON.stringify({
          success: true,
          message: `Lembrete "${title}" criado para às ${formatted}.${avisoIA}`,
          reminderId: reminder.id,
        });
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em create_reminder:', err);
        return JSON.stringify({ success: false, error: `Erro inesperado: ${err.message}` });
      }
    }

    case 'cancel_reminder': {
      try {
        const reminderId: string = p.reminder_id || p.reminderId;

        if (!reminderId) {
          return JSON.stringify({ success: false, error: 'reminder_id não informado.' });
        }

        // FIX: removido .schema('jarvis') redundante
        const { data: reminder, error: fetchError } = await supabase
          .from('reminders')
          .select('metadata')
          .eq('id', reminderId)
          .eq('user_id', Number(numericUserIdStr))
          .maybeSingle();

        if (fetchError) throw fetchError;

        const qstashMessageId = reminder?.metadata?.qstash_message_id;
        if (qstashMessageId) {
          await cancelReminderOnQStash(qstashMessageId);
        }

        // FIX: removido .schema('jarvis') redundante
        const { error: updateError } = await supabase
          .from('reminders')
          .update({ status: 'cancelled' })
          .eq('id', reminderId)
          .eq('user_id', Number(numericUserIdStr));

        if (updateError) throw updateError;

        return JSON.stringify({ success: true, message: 'Lembrete cancelado.' });
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em cancel_reminder:', err);
        return JSON.stringify({ success: false, error: `Erro inesperado: ${err.message}` });
      }
    }

    case 'list_reminders': {
      try {
        // FIX: removido .schema('jarvis') redundante
        const { data: reminders, error } = await supabase
          .from('reminders')
          .select('id, title, scheduled_time, frequency, type, status')
          .eq('user_id', Number(numericUserIdStr))
          .eq('status', 'pending')
          .order('scheduled_time', { ascending: true, nullsFirst: false })
          .limit(10);

        if (error) throw error;
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
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em list_reminders:', err);
        return `Erro ao buscar lembretes: ${err.message}`;
      }
    }

    // ===================== METAS E DIÁRIO =====================

    case 'atualizar_meta':
      try {
        return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida);
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em atualizar_meta:', err);
        return `Erro ao atualizar meta: ${err.message}`;
      }

    case 'registrar_no_diario':
      try {
        await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime');
        return 'Entrada registrada no diário.';
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em registrar_no_diario:', err);
        return `Erro ao registrar no diário: ${err.message}`;
      }

    // ===================== PESQUISA =====================

    case 'pesquisar_internet':
    case 'searchWeb': {
      try {
        console.log(`[tool] searchWeb: "${p.query}"`);
        // Timeout de 8 segundos para evitar travamento da API
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de busca atingido')), 8000));
        const result = await Promise.race([searchWeb(p.query), timeout]) as string;
        console.log(`[tool] resultado: ${result?.substring(0, 200) || 'Sem resultado'}`);
        return result;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em searchWeb:', err);
        return "A pesquisa demorou muito ou falhou. Informe ao usuário que a busca está temporariamente indisponível.";
      }
    }

    case 'getWeatherForecast':
      try {
        // Timeout de 5 segundos para clima
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de previsão do tempo atingido')), 5000));
        return await Promise.race([getWeatherForecast(p.lat, p.lng), timeout]) as string;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em getWeatherForecast:', err);
        return "Serviço de previsão do tempo indisponível no momento.";
      }

    // ===================== LUGARES E LISTAS =====================

    case 'salvar_lugar': {
      try {
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
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em salvar_lugar:', err);
        return `Erro ao salvar lugar: ${err.message}`;
      }
    }

    case 'remover_lugar':
      try {
        const { error } = await supabase.from('favorite_places').delete().eq('user_id', authUserId).ilike('name', p.nome.trim());
        if (error) throw error;
        return `Lugar "${p.nome}" removido.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em remover_lugar:', err);
        return `Erro ao remover lugar: ${err.message}`;
      }

    case 'adicionar_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
        const { error } = await supabase.from('shopping_items').upsert(
          { user_id: authUserId, item: p.item.trim(), place_id: pid, done: false },
          { onConflict: 'user_id,item,place_id' }
        );
        if (error) throw error;
        return `"${p.item}" adicionado à lista de ${p.lugar}.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em adicionar_item_lista:', err);
        return `Erro ao adicionar item: ${err.message}`;
      }
    }

    case 'marcar_feito': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
        const { error } = await supabase
          .from('shopping_items')
          .update({ done: true })
          .eq('user_id', authUserId)
          .ilike('item', p.item.trim())
          .eq('place_id', pid);
        if (error) throw error;
        return `"${p.item}" marcado como comprado.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em marcar_feito:', err);
        return `Erro ao atualizar item: ${err.message}`;
      }
    }

    case 'remover_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
        const { error } = await supabase
          .from('shopping_items')
          .delete()
          .eq('user_id', authUserId)
          .ilike('item', p.item.trim())
          .eq('place_id', pid);
        if (error) throw error;
        return `"${p.item}" removido.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em remover_item_lista:', err);
        return `Erro ao remover item: ${err.message}`;
      }
    }

    case 'ver_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lista de ${p.lugar} está vazia.`;
        const { data: itens, error } = await supabase
          .from('shopping_items')
          .select('item, done')
          .eq('user_id', authUserId)
          .eq('place_id', pid)
          .order('done');
        if (error) throw error;
        if (!itens?.length) return `Lista de ${p.lugar} está vazia.`;
        return `Lista de ${p.lugar}:\n${itens.map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em ver_lista:', err);
        return `Erro ao carregar lista: ${err.message}`;
      }
    }

    // ===================== SUPORTE EXECUTIVO (TDAH) =====================

    case 'quebrar_tarefa': {
      try {
        const tarefa = p.tarefa_principal;
        const estado = p.estado_cognitivo || 'neutro';

        let instrucao_modelo = `A tarefa do usuário é "${tarefa}". O estado cognitivo detectado é "${estado}".\n\n`;
        instrucao_modelo += `REGRA DE RESPOSTA (Módulo TDAH ativado):\n`;
        instrucao_modelo += `1. Não dê preâmbulos motivacionais.\n`;
        instrucao_modelo += `2. Quebre a tarefa em 3 a 5 micro-passos sequenciais.\n`;

        if (estado === 'sobrecarregado' || estado === 'sem_energia') {
          instrucao_modelo += `3. O Passo 1 deve ser absurdamente fácil (ex: 'Levantar da cadeira' ou 'Pegar o pano').\n`;
        }

        instrucao_modelo += `4. Peça para o usuário responder "feito" apenas para o Passo 1 antes de mostrar os outros.`;

        // FIX: removido .schema('jarvis') redundante
        const { error } = await supabase.from('brain').insert([{
          user_id: Number(numericUserIdStr),
          category: 'Nota',
          content: `Usuário iniciou quebra de tarefa: ${tarefa} (Estado: ${estado})`,
          project_tag: 'foco'
        }]);

        if (error) throw error;

        return instrucao_modelo;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em quebrar_tarefa:', err);
        return `Erro ao processar quebra de tarefa. Prossiga ajudando o usuário de forma simplificada.`;
      }
    }

    // ===================== INSIGHTS =====================

    case 'get_weather_insights': {
      try {
        const location = await getUserLastLocation(numericUserIdStr);
        if (!location) return 'Compartilhe sua localização para eu poder dar dicas do clima. 📍';
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

    case 'criar_rotina': {
      try {
        assertNumericUserId(numericUserIdStr, 'criar_rotina');

        // FIX: era args.anchor/action/period (string), corrigido para p.anchor/action/period (objeto parseado)
        const anchor = p.anchor;
        const action = p.action;
        const period = p.period || 'anytime';

        // FIX: removido .schema('jarvis') redundante
        const { error } = await supabase.from('routines').insert([{
          user_id: Number(numericUserIdStr),
          anchor,
          action,
          period,
          is_active: true
        }]);

        if (error) {
          console.error('[ToolsExecutor] Erro ao criar rotina:', error);
          return 'Houve um erro técnico ao tentar guardar a rotina no repositório. Peça desculpa e sugira tentar novamente.';
        }

        return `A rotina "${action}" ancorada em "${anchor}" no período ${period} foi criada com sucesso! Confirme ao utilizador de forma curta, elegante e encorajadora.`;
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em criar_rotina:', err);
        return `Falha ao tentar criar a rotina: ${err.message}`;
      }
    }

    case 'registrar_transacao':
      return executeRegistrarTransacao(args, authUserId, numericUserIdStr);
    case 'consultar_financas':
      return executeConsultarFinancas(args, authUserId, numericUserIdStr);
    case 'criar_orcamento':
      return executeCriarOrcamento(args, authUserId, numericUserIdStr);
    case 'listar_orcamentos':
      return executeListarOrcamentos(authUserId, numericUserIdStr);

    default:
      return `Ferramenta ${name} não implementada.`;
  }
}
