// lib/chat/tools-executor.ts
// Motor V10.0.2 — Edição Titã (ExpertFrotas, Finance, Agenda Lev & TDAH)
// Rigor Total: Fuso Londrina, Recorrência Cron e Saneamento de Origem

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { extractDiary, updateGoalProgress } from '@/lib/diary';
import { getCachedEmbedding } from './embedding-cache';
import { scheduleReminderOnQStash, cancelReminderOnQStash } from '@/lib/qstash';

// EXECUTORES EXTERNOS
import {
  executeRegistrarTransacao,
  executeConsultarFinancas,
  executeCriarOrcamento,
  executeListarOrcamentos,
} from '@/lib/finances/executor';

// ─── HELPERS DE INFRAESTRUTURA ──────────────────────────────────────────────

/**
 * Mapeia frequências humanas para expressões Cron padrão.
 */
const getCronExpression = (freq: string, time: Date) => {
  const m = time.getMinutes();
  const h = time.getHours();
  switch (freq) {
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly':   return `${m} ${h} * * ${time.getDay()}`;
    case 'monthly':  return `${m} ${h} ${time.getDate()} * *`;
    default: return null;
  }
};

async function detectarConflitos(userId: number, inicio: string, fim: string) {
  const { data: conflitos } = await supabase
    .schema('jarvis')
    .from('events')
    .select('title, start_at')
    .eq('user_id', userId)
    .lt('start_at', fim)
    .gt('end_at', inicio);
  return conflitos || [];
}

function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`[${context}] userId inválido: esperado BigInt, recebido "${id}"`);
  }
}

async function getUserLastLocation(numericUserIdStr: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const { data: locData } = await supabase
      .schema('jarvis')
      .from('config')
      .select('value')
      .eq('key', `last_location_${numericUserIdStr}`)
      .maybeSingle();

    if (!locData?.value) return null;
    const parsed = JSON.parse(locData.value);
    const lat = parsed.latitude ?? parsed.lat;
    const lng = parsed.longitude ?? parsed.lng;
    return (typeof lat === 'number' && typeof lng === 'number') ? { lat, lng } : null;
  } catch (err) {
    console.error('[ToolsExecutor] Erro ao buscar localização:', err);
    return null;
  }
}

// ─── EXECUTOR PRINCIPAL ─────────────────────────────────────────────────────

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  try {
    assertNumericUserId(numericUserIdStr, 'executeTool');
  } catch (err: any) {
    return `Erro de Identidade: ${err.message}`;
  }

  const { name, arguments: args } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(args);
  } catch {
    return `Erro crítico: Falha ao parsear argumentos da ferramenta ${name}.`;
  }

  // ─── IDEMPOTÊNCIA ───
  const callSignature = toolCall.id || args.replace(/\s+/g, '').substring(0, 50);
  const idempotencyKey = `${numericUserIdStr}_${name}_${callSignature}`;

  try {
    const { error: idemError } = await supabase
      .from('idempotency_keys')
      .insert({ key: idempotencyKey });

    if (idemError && idemError.code === '23505') {
      console.warn(`[Idempotência] Bloqueado retry para a tool: ${name}`);
      return `[SISTEMA] Comando já processado com sucesso.`;
    }
  } catch (err) { /* Ignora */ }

  const getPlaceId = async (nome: string) => {
    const { data } = await supabase
      .from('favorite_places')
      .select('id')
      .eq('user_id', authUserId)
      .ilike('name', nome.trim())
      .maybeSingle();
    return data?.id ?? null;
  };

  switch (name) {
    // ===================== MEMÓRIA E CONFIGURAÇÃO =====================
    case 'buscar_memoria_longa': {
      try {
        const emb = await getCachedEmbedding(p.query);
        const { data: mems, error } = await supabase.schema('jarvis').rpc('match_memories', {
          query_embedding: emb, match_threshold: 0.4, match_count: 5
        });
        if (error) throw error;
        return (mems as any[])
          ?.filter(m => !m.summary.startsWith('[CINZA]'))
          .map(m => m.summary)
          .join('\n---\n') || 'Nenhuma memória relevante encontrada.';
      } catch (err) { return 'Erro ao acessar o banco de memórias.'; }
    }

    case 'adicionar_diretriz_dinamica': {
      try {
        const { error } = await supabase.schema('jarvis').from('dynamic_guidelines').insert({
          user_id: Number(numericUserIdStr), content: p.content, scope: p.scope || 'personal', active: true
        });
        if (error) throw error;
        return `Entendido, Célio. Diretriz aplicada: "${p.content}".`;
      } catch (err: any) { return `Erro técnico ao salvar diretriz: ${err.message}`; }
    }

    // ===================== AGENDA LEV + GOOGLE + OUTLOOK =====================
    case 'consultar_agenda': {
      try {
        const [levRes, googleRes, outlookRes] = await Promise.allSettled([
          supabase.schema('jarvis').rpc('get_calendar_context_for_jarvis', {
            p_user_id: Number(numericUserIdStr), p_days: p.dias || 7,
          }),
          getGoogleContext().catch(() => null),
          getMicrosoftCalendarContext().catch(() => null),
        ]);
        const lev = levRes.status === 'fulfilled' && levRes.value.data ? levRes.value.data : 'Nenhum evento Lev.';
        let result = `[AGENDA LEV]\n${lev}`;
        if (googleRes.status === 'fulfilled' && googleRes.value) result += `\n\n[GOOGLE]\n${googleRes.value}`;
        return result;
      } catch (err) { return 'Erro ao consultar agenda.'; }
    }

    case 'salvar_evento': {
      try {
        const agora = new Date();
        let rawDate = (p.event_date || p.startTime || '').trim().replace(' ', 'T');

        if (rawDate.length <= 5 && rawDate.includes(':')) {
           rawDate = `${agora.toLocaleDateString('en-CA')}T${rawDate}:00`;
        }

        const dateString = /(Z|[+-]\d{2}:\d{2})$/.test(rawDate) ? rawDate : `${rawDate}-03:00`;
        const startDate = new Date(dateString);
        if (isNaN(startDate.getTime())) return `Erro: data inválida — "${p.event_date}".`;

        const startISO = startDate.toISOString();
        const endISO = new Date(startDate.getTime() + (p.duration_minutes || 60) * 60000).toISOString();

        if (!p.force) {
          const conflitos = await detectarConflitos(Number(numericUserIdStr), startISO, endISO);
          if (conflitos.length > 0) {
            const hora = new Date(conflitos[0].start_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            return `[CONFLITO] Você já tem "${conflitos[0].title}" às ${hora}. Deseja forçar?`;
          }
        }

        const { error } = await supabase.schema('jarvis').from('events').insert({
          user_id: Number(numericUserIdStr), title: p.title || p.summary,
          start_at: startISO, end_at: endISO, all_day: !!p.all_day,
          category: p.category || 'personal', source: 'lev', // IMPORTANTE
          reminder_minutes: [p.reminderMinutes ?? 30], notes: p.notes || null,
        });
        if (error) throw error;
        return `Evento "${p.title || p.summary}" salvo para ${startDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`;
      } catch (err: any) { return `Erro ao salvar: ${err.message}`; }
    }

    case 'deletar_evento': {
      try {
        const { error } = await supabase.schema('jarvis').from('events')
          .delete().eq('user_id', Number(numericUserIdStr)).ilike('title', `%${p.query}%`);
        return error ? 'Erro ao deletar.' : `Evento "${p.query}" removido.`;
      } catch { return 'Falha na exclusão.'; }
    }

    case 'criar_evento_agenda': {
      try { return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30); }
      catch (err: any) { return `Erro no Google: ${err.message}`; }
    }

    case 'listar_emails_recentes':
      try { return await getRecentEmails(p.filtro, 5, true); } catch (err: any) { return `Erro no Gmail: ${err.message}`; }

    case 'excluir_email':
      try { return await trashGoogleEmail(p.messageId); } catch (err: any) { return `Erro ao excluir: ${err.message}`; }

    // ===================== MOTOR DE LEMBRETES (QSTASH) =====================
    case 'create_reminder': {
      try {
        const title = p.title || p.message;
        let scheduled_time = p.scheduled_time;
        const agora = new Date();

        if (scheduled_time && scheduled_time.length <= 5 && scheduled_time.includes(':')) {
          const dataRef = new Date(`${agora.toLocaleDateString('en-CA')}T${scheduled_time}:00-03:00`);
          if (dataRef.getTime() <= agora.getTime()) dataRef.setDate(dataRef.getDate() + 1);
          scheduled_time = dataRef.toISOString();
        } else if (scheduled_time) {
          const ds = /(Z|[+-]\d{2}:\d{2})$/.test(scheduled_time) ? scheduled_time : `${scheduled_time}-03:00`;
          scheduled_time = new Date(ds).toISOString();
        } else {
          scheduled_time = new Date(agora.getTime() + (p.delay_minutes || 5) * 60000).toISOString();
        }

        let frequency = p.frequency || null;
        if (frequency?.toLowerCase().includes('útil') || frequency === 'segunda a sexta') frequency = 'weekdays';

        const { data: reminder, error } = await supabase.schema('jarvis').from('reminders').insert({
          user_id: Number(numericUserIdStr), title, type: p.type || 'temporary',
          scheduled_time, frequency, status: 'pending', source: 'lev', // IMPORTANTE
          metadata: { auth_user_id: authUserId },
        }).select('id').single();

        if (error) throw error;

        // Lógica Cron para QStash
        const cron = frequency ? getCronExpression(frequency, new Date(scheduled_time)) : null;

        const qstashId = await scheduleReminderOnQStash({
          reminderId: String(reminder.id), userId: numericUserIdStr, authUserId,
          message: title, scheduledTime: cron ? null : scheduled_time, cron // 👈 ENVIA O CRON
        });

        if (qstashId) await supabase.schema('jarvis').from('reminders').update({ qstash_message_id: qstashId }).eq('id', reminder.id);

        const dtFmt = new Date(scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        return `Lembrete "${title}" às ${dtFmt}${frequency ? ` (${frequency})` : ''}.`;
      } catch (err: any) { return `Erro ao criar lembrete: ${err.message}`; }
    }

    case 'consultar_lembretes': {
      try {
        const { data: reminders } = await supabase.schema('jarvis').from('reminders').select('title, scheduled_time, status, frequency')
          .eq('user_id', Number(numericUserIdStr)).eq('status', 'pending').gte('scheduled_time', new Date().toISOString()).order('scheduled_time', { ascending: true });
        if (!reminders?.length) return "Nenhum lembrete pendente.";
        return reminders.map(r => `- ${r.title} (${new Date(r.scheduled_time!).toLocaleString('pt-BR', {timeZone: 'America/Sao_Paulo'})}) ${r.frequency || ''}`).join('\n');
      } catch (err) { return "Erro ao ler lembretes."; }
    }

    case 'cancelar_lembrete': {
      try {
        const { data: r } = await supabase.schema('jarvis').from('reminders').select('id, qstash_message_id').eq('user_id', Number(numericUserIdStr))
          .ilike('title', `%${p.query}%`).eq('status', 'pending').maybeSingle();
        if (!r) return `Lembrete "${p.query}" não encontrado.`;
        if (r.qstash_message_id) await cancelReminderOnQStash(r.qstash_message_id);
        await supabase.schema('jarvis').from('reminders').update({ status: 'cancelled' }).eq('id', r.id);
        return `Lembrete "${p.query}" cancelado.`;
      } catch { return 'Erro ao cancelar.'; }
    }

    // ===================== EXPERTFROTAS (GESTÃO VEICULAR) =====================
    case 'registrar_abastecimento': {
      try {
        const { data: v } = await supabase.schema('jarvis').from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return `Veículo "${p.vehicle_name}" não encontrado.`;
        const { error } = await supabase.schema('jarvis').from('vehicle_refueling').insert({
          vehicle_id: v.id, user_id: numericUserIdStr, auth_user_id: authUserId,
          fuel_type: p.fuel_type, total_cost: p.total_cost, odometer: p.odometer, liters: p.liters || null
        });
        return error ? `Erro: ${error.message}` : `Abastecimento de ${p.fuel_type} (R$ ${p.total_cost}) registrado.`;
      } catch (err: any) { return `Erro técnico: ${err.message}`; }
    }

    case 'registrar_manutencao': {
      try {
        const { data: v } = await supabase.schema('jarvis').from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return "Veículo não encontrado.";
        const { error } = await supabase.schema('jarvis').from('vehicle_maintenances').insert({
          vehicle_id: v.id, user_id: numericUserIdStr, title: p.servico || p.title,
          performed_date: p.data || new Date().toISOString(), odometer: p.odometer, cost: p.custo || 0
        });
        return error ? `Erro: ${error.message}` : `Manutenção de "${p.servico}" registrada.`;
      } catch (err: any) { return `Erro técnico: ${err.message}`; }
    }

    case 'atualizar_odometro': {
      try {
        const { data: v } = await supabase.schema('jarvis').from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return "Veículo não encontrado.";
        await supabase.schema('jarvis').from('vehicle_odometer_logs').insert({ vehicle_id: v.id, user_id: numericUserIdStr, odometer: p.odometer, source: 'manual' });
        await supabase.schema('jarvis').from('vehicles').update({ current_km: p.odometer }).eq('id', v.id);
        return `Odômetro do ${p.vehicle_name} atualizado para ${p.odometer}km.`;
      } catch (err: any) { return `Erro no odômetro: ${err.message}`; }
    }

    // ===================== MÓDULO FINANCEIRO =====================
    case 'registrar_transacao': return executeRegistrarTransacao(p, authUserId, numericUserIdStr);
    case 'consultar_financas': return executeConsultarFinancas(p, authUserId, numericUserIdStr);
    case 'listar_orcamentos': return executeListarOrcamentos(authUserId, numericUserIdStr);
    case 'criar_orcamento': return executeCriarOrcamento(p, authUserId, numericUserIdStr);

    // ===================== FOCO, TDAH & DIÁRIO =====================
    case 'gerenciar_eisenhower': {
      try {
        if (p.acao === 'adicionar') {
          await supabase.schema('jarvis').from('eisenhower_items').insert({ user_id: numericUserIdStr, text: p.texto, quadrant: p.quadrante || 'q2' });
          return `Tarefa "${p.texto}" adicionada ao quadrante ${p.quadrante || 'q2'}.`;
        }
        if (p.acao === 'completar') {
          await supabase.schema('jarvis').from('eisenhower_items').update({ completed: true, completed_at: new Date() }).eq('user_id', numericUserIdStr).ilike('text', `%${p.texto}%`);
          return `Tarefa concluída.`;
        }
        return "Ação processada.";
      } catch (err: any) { return `Erro na Matriz: ${err.message}`; }
    }

    case 'quebrar_tarefa': {
      await supabase.from('brain').insert([{ user_id: Number(numericUserIdStr), category: 'Nota', content: `Quebra de tarefa: ${p.tarefa_principal}`, project_tag: 'foco' }]);
      return `[MODO TDAH] Tarefa: "${p.tarefa_principal}". 1. Primeiro passo minúsculo. Diga "feito".`;
    }

    case 'registrar_no_diario':
      try { await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime'); return 'Entrada registrada.'; } catch (err: any) { return `Erro no diário: ${err.message}`; }

    case 'atualizar_meta':
      try { return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida); } catch (err: any) { return `Erro na meta: ${err.message}`; }

    // ===================== PESQUISA E CLIMA =====================
    case 'searchWeb': return await searchWeb(p.query);
    case 'getWeatherForecast': return await getWeatherForecast(p.lat, p.lng);
    case 'get_weather_insights': {
      try {
        const loc = await getUserLastLocation(numericUserIdStr);
        if (!loc) return 'Localização não encontrada.';
        const { getWeatherInsight } = await import('@/lib/insights/weather-insights');
        return await getWeatherInsight(loc.lat, loc.lng, 'Célio');
      } catch (err) { return 'Insights climáticos indisponíveis.'; }
    }

    // ===================== LUGARES E LISTAS DE COMPRAS =====================
    case 'salvar_lugar': {
      try {
        const { error } = await supabase.from('favorite_places').upsert({
          user_id: authUserId, name: p.nome.trim(), lat: p.lat, lng: p.lng, radius_meters: p.raio_metros, category: p.categoria.trim()
        }, { onConflict: 'user_id,name' });
        return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo.`;
      } catch (err: any) { return `Erro: ${err.message}`; }
    }

    case 'adicionar_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Não encontrei o lugar "${p.lugar}".`;
        await supabase.from('shopping_items').upsert({ user_id: authUserId, item: p.item.trim(), place_id: pid, done: false }, { onConflict: 'user_id,item,place_id' });
        return `"${p.item}" adicionado à lista.`;
      } catch (err: any) { return `Erro ao adicionar: ${err.message}`; }
    }

    case 'ver_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Lista de ${p.lugar} não encontrada.`;
        const { data: itens } = await supabase.from('shopping_items').select('item, done').eq('user_id', authUserId).eq('place_id', pid).order('done');
        if (!itens?.length) return `Sua lista de ${p.lugar} está vazia.`;
        return `Lista ${p.lugar}:\n${itens.map(i => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
      } catch (err: any) { return `Erro ao carregar lista: ${err.message}`; }
    }

    default:
      return `A ferramenta ${name} reconhecida, motor não plugado.`;
  }
}
