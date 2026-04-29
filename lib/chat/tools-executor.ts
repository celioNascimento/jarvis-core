// lib/chat/tools-executor.ts
// Motor V8.20.0 — Edição Definitiva Sem Cortes (ExpertFrotas, Finance, Agenda & TDAH)
// Dual-ID: authUserId (UUID do Auth) | numericUserIdStr (BigInt do Banco)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';
import { extractDiary, updateGoalProgress } from '@/lib/diary';
import { getCachedEmbedding } from './embedding-cache';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';
import { handleSalvarEvento } from './tools-executor-agenda-patch';

// EXECUTORES DE FINANÇAS
import {
  executeRegistrarTransacao,
  executeConsultarFinancas,
  executeCriarOrcamento,
  executeListarOrcamentos,
} from '@/lib/finances/executor';

// ─── HELPERS DE APOIO E VALIDAÇÃO ──────────────────────────────────────────

/**
 * Garante que o ID do usuário é uma string numérica (BigInt do banco)
 */
function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`[${context}] userId invalido: esperado numerico, recebido "${id}"`);
  }
}

/**
 * Busca a última localização salva para prover insights climáticos precisos
 */
async function getUserLastLocation(numericUserIdStr: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const { data: locData, error } = await supabase
      .schema('jarvis')
      .from('config')
      .select('value')
      .eq('key', `last_location_${numericUserIdStr}`)
      .maybeSingle();

    if (error || !locData?.value) return null;

    const parsed = JSON.parse(locData.value);
    const lat = parsed.latitude ?? parsed.lat_approx ?? parsed.lat;
    const lng = parsed.longitude ?? parsed.lng_approx ?? parsed.lng;

    if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    return null;
  } catch (err) {
    console.error('[ToolsExecutor] Erro ao buscar última localização:', err);
    return null;
  }
}

// ─── EXECUTOR PRINCIPAL ────────────────────────────────────────────────────

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

  // ─── IDEMPOTÊNCIA (Prevenção de Duplicidade Vercel / QStash) ───────────────
  const callSignature = toolCall.id || args.replace(/\s+/g, '').substring(0, 50);
  const idempotencyKey = `${numericUserIdStr}_${name}_${callSignature}`;

  try {
    const { error: idemError } = await supabase
      .from('idempotency_keys')
      .insert({ key: idempotencyKey });

    if (idemError && (idemError.code === '23505' || idemError.status === 409)) {
      console.warn(`[Idempotência] Bloqueado retry para a tool: ${name}`);
      return `[SISTEMA] Comando já processado com sucesso.`;
    }
  } catch (err) {
    console.warn('[Idempotência] Erro ignorado para não travar execução.', err);
  }

  // ─── HELPER PARA BUSCA DE LUGARES (Tabelas de Compras) ─────────────────────
  async function getPlaceId(nome: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('favorite_places')
        .select('id')
        .eq('user_id', authUserId)
        .ilike('name', nome.trim())
        .maybeSingle();

      if (error) throw error;
      return data?.id ?? null;
    } catch (err) {
      console.error('[ToolsExecutor] Erro em getPlaceId:', err);
      return null;
    }
  }

  switch (name) {
    // ===================== MEMÓRIA E CORE =====================
    case 'buscar_memoria_longa': {
      try {
        const emb = await getCachedEmbedding(p.query);
        const { data: mems, error } = await supabase
          .schema('jarvis')
          .rpc('match_memories', {
            query_embedding: emb,
            match_threshold: 0.4,
            match_count: 5,
          });

        if (error) throw error;

        return (
          (mems as any[])
            ?.filter((m) => !m.summary.startsWith('[CINZA]'))
            .map((m) => m.summary)
            .join('\n---\n') || 'Nenhuma memória relevante encontrada.'
        );
      } catch (err: any) {
        console.error('[ToolsExecutor] Erro em buscar_memoria_longa:', err);
        return 'Falha ao acessar memórias. O banco de dados pode estar indisponível.';
      }
    }

    case 'adicionar_diretriz_dinamica': {
      try {
        const { error } = await supabase
          .schema('jarvis')
          .rpc('upsert_dynamic_guideline', {
            p_user_id: Number(numericUserIdStr),
            p_content: p.content,
            p_scope: p.scope || 'personal'
          });

        if (error) throw error;
        return `Diretriz "${p.content}" salva com sucesso. O comportamento será ajustado.`;
      } catch (err: any) {
        return `Erro inesperado ao salvar diretriz: ${err.message}`;
      }
    }

    // ===================== AGENDA E COMUNICAÇÃO =====================
    case 'consultar_agenda': {
      try {
        const results = await Promise.allSettled([
          supabase.schema('jarvis').rpc('get_calendar_context_for_jarvis', { 
            p_user_id: Number(numericUserIdStr), 
            p_days: p.dias || 7 
          }).then(res => res.data || 'Sem eventos na agenda Lev.'),
          getGoogleContext().catch(e => `[Erro Google: ${e.message}]`),
          getMicrosoftCalendarContext().catch(e => `[Erro Outlook: ${e.message}]`)
        ]);

        const lev = results[0].status === 'fulfilled' ? results[0].value : 'Erro ao carregar Agenda Lev';
        const g = results[1].status === 'fulfilled' ? results[1].value : `[Erro Google]`;
        const o = results[2].status === 'fulfilled' ? results[2].value : `[Erro Outlook]`;

        return `[AGENDA INTERNA LEV]\n${lev}\n\n[GOOGLE CALENDAR]\n${g}\n\n[OUTLOOK]\n${o}`;
      } catch (err: any) {
        return 'Ocorreu um erro interno ao tentar consultar as agendas.';
      }
    }

    case 'salvar_evento': {
      try {
        const { data: event, error } = await supabase
          .schema('jarvis')
          .from('events')
          .insert({
            user_id: Number(numericUserIdStr),
            title: p.title,
            start_at: p.event_date,
            description: p.notes || null,
            category: p.category || 'personal',
            is_recurring: p.is_recurring || false,
            source: 'lev'
          })
          .select()
          .single();

        if (error) throw error;
        const dt = new Date(p.event_date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `Compromisso "${p.title}" salvo na Agenda Lev para ${dt}.`;
      } catch (err: any) {
        return `Erro ao salvar o evento: ${err.message}`;
      }
    }

    case 'criar_evento_agenda':
      try {
        return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30);
      } catch (err: any) {
        return `Erro no Google Calendar: ${err.message}`;
      }

    case 'listar_emails_recentes':
      try {
        return await getRecentEmails(p.filtro, 5, true);
      } catch (err: any) {
        return `Erro ao buscar emails: ${err.message}`;
      }

    case 'excluir_email':
      try {
        return await trashGoogleEmail(p.messageId);
      } catch (err: any) {
        return `Erro ao excluir email: ${err.message}`;
      }

    // ===================== LEMBRETES (QSTASH + JARVIS SCHEMA) =====================
    case 'create_reminder': {
      try {
        const title: string = p.title || p.message;
        let scheduled_time: string | undefined = p.scheduled_time;

        if (!scheduled_time && p.delay_minutes) {
          scheduled_time = new Date(Date.now() + p.delay_minutes * 60000).toISOString();
        } else if (!scheduled_time && p.type !== 'location') {
          scheduled_time = new Date(Date.now() + 300000).toISOString(); // Fallback 5 min
        }

        const { data: reminder, error } = await supabase
          .schema('jarvis')
          .from('reminders')
          .insert({
            user_id: Number(numericUserIdStr),
            title,
            type: p.type || 'temporary',
            scheduled_time: scheduled_time || null,
            frequency: p.frequency || null,
            location_trigger: p.location_trigger || null,
            status: 'pending',
            metadata: { auth_user_id: authUserId },
          })
          .select('id')
          .single();

        if (error || !reminder) throw error;

        if (scheduled_time && p.type !== 'recurring' && p.type !== 'location') {
          const qid = await scheduleReminderOnQStash({
            reminderId: String(reminder.id),
            userId: numericUserIdStr,
            authUserId,
            message: title,
            scheduledTime: scheduled_time,
          });

          if (qid) {
            await supabase
              .schema('jarvis')
              .from('reminders')
              .update({ metadata: { auth_user_id: authUserId, qstash_message_id: qid } })
              .eq('id', reminder.id);
          }
        }

        const dtFormatted = new Date(scheduled_time!).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit', minute: '2-digit',
        });
        return JSON.stringify({ success: true, message: `Lembrete "${title}" criado para às ${dtFormatted}.` });
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }

    case 'cancel_reminder': {
      try {
        const reminderId = p.reminder_id || p.reminderId;
        const { data: rem } = await supabase
          .schema('jarvis')
          .from('reminders')
          .select('metadata')
          .eq('id', reminderId)
          .eq('user_id', Number(numericUserIdStr))
          .maybeSingle();

        if (rem?.metadata?.qstash_message_id) {
          await cancelReminderOnQStash(rem.metadata.qstash_message_id);
        }

        await supabase
          .schema('jarvis')
          .from('reminders')
          .update({ status: 'cancelled' })
          .eq('id', reminderId)
          .eq('user_id', Number(numericUserIdStr));

        return "Lembrete cancelado com sucesso.";
      } catch (err: any) {
        return `Erro ao cancelar lembrete: ${err.message}`;
      }
    }

    case 'list_reminders': {
      try {
        const { data: reminders } = await supabase
          .schema('jarvis')
          .from('reminders')
          .select('id, title, scheduled_time')
          .eq('user_id', Number(numericUserIdStr))
          .eq('status', 'pending')
          .order('scheduled_time', { ascending: true })
          .limit(10);

        if (!reminders?.length) return 'Nenhum lembrete ativo no momento.';
        return reminders.map(r => `• [${r.id}] ${r.title} — ${new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`).join('\n');
      } catch (err: any) {
        return `Erro ao buscar lembretes: ${err.message}`;
      }
    }

    // ===================== EXPERTFROTAS (VEÍCULOS) =====================
    case 'registrar_abastecimento': {
      try {
        const { data: v } = await supabase
          .schema('jarvis')
          .from('vehicles')
          .select('id')
          .ilike('name', p.vehicle_name)
          .eq('user_id', numericUserIdStr)
          .maybeSingle();

        if (!v) return `Veículo "${p.vehicle_name}" não encontrado.`;

        const { error } = await supabase
          .schema('jarvis')
          .from('vehicle_refueling')
          .insert({
            vehicle_id: v.id,
            user_id: numericUserIdStr,
            auth_user_id: authUserId,
            fuel_type: p.fuel_type,
            total_cost: p.total_cost,
            odometer: p.odometer,
            liters: p.liters || null
          });

        if (error) throw error;
        return `Abastecimento de ${p.fuel_type} (R$ ${p.total_cost}) registrado para o ${p.vehicle_name}.`;
      } catch (err: any) {
        return `Erro ao registrar abastecimento: ${err.message}`;
      }
    }

    case 'registrar_manutencao': {
      try {
        const { data: v } = await supabase
          .schema('jarvis')
          .from('vehicles')
          .select('id')
          .ilike('name', p.vehicle_name)
          .eq('user_id', numericUserIdStr)
          .maybeSingle();

        if (!v) return `Veículo não encontrado.`;

        const { error } = await supabase
          .schema('jarvis')
          .from('vehicle_maintenances')
          .insert({
            vehicle_id: v.id,
            user_id: numericUserIdStr,
            title: p.servico || p.title,
            performed_date: p.data || new Date().toISOString(),
            odometer: p.odometer,
            cost: p.custo || p.cost || 0
          });

        if (error) throw error;
        return `Manutenção registrada para o ${p.vehicle_name}.`;
      } catch (err: any) {
        return `Erro ao registrar manutenção: ${err.message}`;
      }
    }

    case 'atualizar_odometro': {
      try {
        const { data: v } = await supabase
          .schema('jarvis')
          .from('vehicles')
          .select('id')
          .ilike('name', p.vehicle_name)
          .eq('user_id', numericUserIdStr)
          .maybeSingle();

        if (!v) return "Veículo não encontrado.";

        await supabase.schema('jarvis').from('vehicle_odometer_logs').insert({
          vehicle_id: v.id, user_id: numericUserIdStr, odometer: p.odometer, source: 'manual'
        });

        await supabase
          .schema('jarvis')
          .from('vehicles')
          .update({ current_km: p.odometer })
          .eq('id', v.id);

        return `Odômetro do ${p.vehicle_name} atualizado para ${p.odometer}km.`;
      } catch (err: any) {
        return `Erro no odômetro: ${err.message}`;
      }
    }

    // ===================== FINANÇAS =====================
    case 'registrar_transacao':
      return executeRegistrarTransacao(p, authUserId, numericUserIdStr);
    case 'consultar_financas':
      return executeConsultarFinancas(p, authUserId, numericUserIdStr);
    case 'listar_orcamentos':
      return executeListarOrcamentos(authUserId, numericUserIdStr);
    case 'criar_orcamento':
      return executeCriarOrcamento(p, authUserId, numericUserIdStr);

    // ===================== FOCO E TDAH =====================
    case 'gerenciar_eisenhower': {
      try {
        if (p.acao === 'adicionar') {
          await supabase.schema('jarvis').from('eisenhower_items').insert({ 
            user_id: numericUserIdStr, text: p.texto, quadrant: p.quadrante || 'q2' 
          });
          return `Tarefa adicionada ao quadrante ${p.quadrante || 'q2'}.`;
        }
        if (p.acao === 'completar') {
          await supabase.schema('jarvis').from('eisenhower_items').update({ 
            completed: true, completed_at: new Date() 
          }).eq('user_id', numericUserIdStr).ilike('text', `%${p.texto}%`);
          return `Tarefa "${p.texto}" concluída na Matriz.`;
        }
        return "Ação processada.";
      } catch (err: any) {
        return `Erro na Matriz: ${err.message}`;
      }
    }

    case 'quebrar_tarefa': {
      const tarefa = p.tarefa_principal;
      const estado = p.estado_cognitivo || 'neutro';
      await supabase.schema('jarvis').from('brain').insert([{ 
        user_id: Number(numericUserIdStr), category: 'Nota', content: `Iniciou quebra de tarefa: ${tarefa}`, project_tag: 'foco' 
      }]);
      return `[MODO TDAH] Tarefa: "${tarefa}".\n1. Primeiro passo minúsculo (< 2 min).\n2. Aguarde o usuário confirmar antes dos próximos.`;
    }

    case 'criar_rotina': {
      try {
        await supabase.schema('jarvis').from('routines').insert([{
          user_id: Number(numericUserIdStr), anchor: p.anchor, action: p.action, period: p.period || 'anytime', is_active: true
        }]);
        return `Rotina "${p.action}" salva com sucesso!`;
      } catch (err: any) {
        return `Erro ao salvar rotina: ${err.message}`;
      }
    }

    // ===================== PESQUISA, CLIMA E METAS =====================
    case 'searchWeb':
      try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000));
        return await Promise.race([searchWeb(p.query), timeout]) as string;
      } catch { return "Busca temporariamente indisponível."; }

    case 'getWeatherForecast':
      return await getWeatherForecast(p.lat, p.lng);

    case 'get_weather_insights': {
      try {
        const loc = await getUserLastLocation(numericUserIdStr);
        if (!loc) return 'Compartilhe sua localização para dicas climáticas.';
        const { getWeatherInsight } = await import('@/lib/insights/weather-insights');
        return await getWeatherInsight(loc.lat, loc.lng, 'Célio');
      } catch { return 'Insights climáticos indisponíveis no momento.'; }
    }

    case 'atualizar_meta':
      return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida);

    case 'registrar_no_diario':
      try {
        await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime');
        return 'Entrada registrada no seu diário pessoal.';
      } catch (err: any) {
        return `Erro ao registrar no diário: ${err.message}`;
      }

    // ===================== LUGARES E LISTAS (UUID AUTH) =====================
    case 'salvar_lugar': {
      try {
        const { error } = await supabase.from('favorite_places').upsert({
          user_id: authUserId, name: p.nome.trim(), lat: p.lat, lng: p.lng, radius_meters: p.raio_metros, category: p.categoria.trim()
        }, { onConflict: 'user_id,name' });
        return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo nos favoritos.`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }
    }

    case 'remover_lugar':
      try {
        await supabase.from('favorite_places').delete().eq('user_id', authUserId).ilike('name', p.nome.trim());
        return `Lugar removido dos favoritos.`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }

    case 'adicionar_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
        await supabase.from('shopping_items').upsert({
          user_id: authUserId, item: p.item.trim(), place_id: pid, done: false
        }, { onConflict: 'user_id,item,place_id' });
        return `"${p.item}" adicionado à sua lista de ${p.lugar}.`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }
    }

    case 'marcar_feito': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar não encontrado.`;
        await supabase.from('shopping_items').update({ done: true }).eq('user_id', authUserId).ilike('item', p.item.trim()).eq('place_id', pid);
        return `"${p.item}" marcado como comprado em ${p.lugar}.`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }
    }

    case 'remover_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lugar não encontrado.`;
        await supabase.from('shopping_items').delete().eq('user_id', authUserId).ilike('item', p.item.trim()).eq('place_id', pid);
        return `"${p.item}" removido da lista de ${p.lugar}.`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }
    }

    case 'ver_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lista de ${p.lugar} não encontrada.`;
        const { data: itens } = await supabase.from('shopping_items').select('item, done').eq('user_id', authUserId).eq('place_id', pid).order('done');
        if (!itens?.length) return `A lista de ${p.lugar} está vazia.`;
        return `Lista ${p.lugar}:\n${itens.map(i => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
      } catch (err: any) {
        return `Erro: ${err.message}`;
      }
    }

    default:
      return `Ferramenta ${name} não implementada no executor principal.`;
  }
}
