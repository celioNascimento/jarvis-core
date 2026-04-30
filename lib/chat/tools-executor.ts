// lib/chat/tools-executor.ts
// Motor V8.21.0 — Edição Titã (ExpertFrotas, Finance, Agenda Lev & TDAH)
// Blindagem de Schemas e Idempotência Nível Produção

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';
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

// ─── EXECUTOR PRINCIPAL (O CORAÇÃO DO JARVIS) ───────────────────────────────

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

  // ─── IDEMPOTÊNCIA (Prevenção de Duplicidade Vercel / QStash) ───────────────
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
  } catch (err) {
    console.warn('[Idempotência] Erro ignorado para não travar execução.', err);
  }

  // ── HELPER DE LUGARES (UUID-based) ────────────────────────────────────────
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
          .join('\n---\n') || 'Nenhuma memória relevante encontrada para esta busca.';
      } catch (err) { return 'Erro ao acessar o banco de memórias semânticas.'; }
    }
    // ===================== AGENDA LEV + GOOGLE + OUTLOOK =====================
    case 'consultar_agenda': {
      try {
        const results = await Promise.allSettled([
          supabase.schema('jarvis').rpc('get_calendar_context_for_jarvis', { p_user_id: Number(numericUserIdStr), p_days: p.dias || 7 }),
          getGoogleContext().catch(() => 'Indisponível'),
          getMicrosoftCalendarContext().catch(() => 'Indisponível')
        ]);
        const lev = results[0].status === 'fulfilled' ? (results[0].value as any).data : 'Erro na Agenda Lev';
        const g = results[1].status === 'fulfilled' ? results[1].value : 'Google Offline';
        const o = results[2].status === 'fulfilled' ? results[2].value : 'Outlook Offline';
        return `[AGENDA LEV]\n${lev}\n\n[GOOGLE CALENDAR]\n${g}\n\n[OUTLOOK]\n${o}`;
      } catch (err) { return 'Erro ao consolidar agendas.'; }
    }

    case 'salvar_evento': {
      try {
        const { data: event, error } = await supabase.schema('jarvis').from('events').insert({
          user_id: Number(numericUserIdStr),
          title: p.title,
          start_at: p.event_date,
          description: p.notes || null,
          category: p.category || 'personal',
          source: 'lev'
        }).select().single();
        if (error) throw error;
        const dt = new Date(p.event_date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `Compromisso "${p.title}" agendado com sucesso para ${dt}.`;
      } catch (err: any) { return `Erro ao salvar evento: ${err.message}`; }
    }

    case 'criar_evento_agenda':
      try { return await createGoogleEvent(p.summary, p.startTime, p.reminderMinutes || 30); } catch (err: any) { return `Erro no Google: ${err.message}`; }

    case 'listar_emails_recentes':
      try { return await getRecentEmails(p.filtro, 5, true); } catch (err: any) { return `Erro no Gmail: ${err.message}`; }

    case 'excluir_email':
      try { return await trashGoogleEmail(p.messageId); } catch (err: any) { return `Erro ao excluir: ${err.message}`; }

    // ===================== MOTOR DE LEMBRETES (QSTASH) =====================
    case 'create_reminder': {
      try {
        const title = p.title || p.message;
        const scheduled_time = p.scheduled_time
          || (p.delay_minutes
              ? new Date(Date.now() + p.delay_minutes * 60000).toISOString()
              : new Date(Date.now() + 300000).toISOString());

        const { data: reminder, error } = await supabase
          .schema('jarvis')
          .from('reminders')
          .insert({
            user_id:        Number(numericUserIdStr),
            title,
            type:           p.type || 'temporary',
            scheduled_time,
            status:         'pending',
            metadata:       { auth_user_id: authUserId },
          })
          .select('id')
          .single();

        if (error) throw error;

        const qstashId = await scheduleReminderOnQStash({
          reminderId:    String(reminder.id),
          userId:        numericUserIdStr,
          authUserId,
          message:       title,
          scheduledTime: scheduled_time,
        });

        if (qstashId) {
          // ✅ Salva na coluna dedicada qstash_message_id, não dentro do jsonb metadata
          await supabase
            .schema('jarvis')
            .from('reminders')
            .update({ qstash_message_id: qstashId })
            .eq('id', reminder.id);
        } else {
          console.error('[create_reminder] scheduleReminderOnQStash retornou null para reminder:', reminder.id, '| userId:', numericUserIdStr);
        }

        const dtFormatted = new Date(scheduled_time).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour:     '2-digit',
          minute:   '2-digit',
        });
        return `Lembrete agendado: "${title}" às ${dtFormatted}.`;
      } catch (err: any) { return `Erro ao criar lembrete: ${err.message}`; }
    }

    case 'cancel_reminder': {
      try {
        const rid = p.reminder_id || p.reminderId;

        // ✅ Busca da coluna dedicada, não do jsonb metadata
        const { data: rem } = await supabase
          .schema('jarvis')
          .from('reminders')
          .select('qstash_message_id')
          .eq('id', rid)
          .maybeSingle();

        if (rem?.qstash_message_id) {
          await cancelReminderOnQStash(rem.qstash_message_id);
        } else {
          console.warn('[cancel_reminder] qstash_message_id ausente para reminder:', rid);
        }

        await supabase
          .schema('jarvis')
          .from('reminders')
          .update({ status: 'cancelled' })
          .eq('id', rid);

        return 'Lembrete cancelado com sucesso.';
      } catch (err: any) { return `Erro no cancelamento: ${err.message}`; }
    }

    case 'list_reminders': {
      try {
        const { data: rems } = await supabase.schema('jarvis').from('reminders').select('id, title, scheduled_time').eq('user_id', Number(numericUserIdStr)).eq('status', 'pending').order('scheduled_time', { ascending: true });
        if (!rems?.length) return 'Você não tem lembretes pendentes.';
        return rems.map(r => `• [ID ${r.id}] ${r.title} (${new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`).join('\n');
      } catch (err: any) { return `Erro ao listar: ${err.message}`; }
    }

    // ===================== EXPERTFROTAS (GESTÃO VEICULAR) =====================
    case 'registrar_abastecimento': {
      try {
        const { data: v } = await supabase.schema('jarvis').from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return `Veículo "${p.vehicle_name}" não encontrado na sua garagem.`;
        const { error } = await supabase.schema('jarvis').from('vehicle_refueling').insert({
          vehicle_id: v.id, user_id: numericUserIdStr, auth_user_id: authUserId,
          fuel_type: p.fuel_type, total_cost: p.total_cost, odometer: p.odometer, liters: p.liters || null
        });
        return error ? `Erro no abastecimento: ${error.message}` : `Abastecimento de ${p.fuel_type} (R$ ${p.total_cost}) registrado para o ${p.vehicle_name}.`;
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
        return error ? `Erro na manutenção: ${error.message}` : `A manutenção de "${p.servico}" foi registrada para o seu ${p.vehicle_name}.`;
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
          return `Tarefa "${p.texto}" adicionada ao quadrante ${p.quadrante || 'q2'} da Matriz.`;
        }
        if (p.acao === 'completar') {
          await supabase.schema('jarvis').from('eisenhower_items').update({ completed: true, completed_at: new Date() }).eq('user_id', numericUserIdStr).ilike('text', `%${p.texto}%`);
          return `Tarefa concluída com sucesso.`;
        }
        return "Ação processada na Matriz de Eisenhower.";
      } catch (err: any) { return `Erro na Matriz: ${err.message}`; }
    }

    case 'quebrar_tarefa': {
      const { error } = await supabase.from('brain').insert([{ user_id: Number(numericUserIdStr), category: 'Nota', content: `Iniciou quebra de tarefa: ${p.tarefa_principal}`, project_tag: 'foco' }]);
      return `[MODO TDAH] Tarefa: "${p.tarefa_principal}".\n1. Primeiro passo minúsculo (< 2 min).\n2. Diga "feito" para o próximo passo.`;
    }

    case 'registrar_no_diario':
      try { await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime'); return 'Entrada registrada no seu diário pessoal.'; } catch (err: any) { return `Erro no diário: ${err.message}`; }

    case 'atualizar_meta':
      try { return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida); } catch (err: any) { return `Erro na meta: ${err.message}`; }

    // ===================== PESQUISA E CLIMA =====================
    case 'searchWeb': return await searchWeb(p.query);
    case 'getWeatherForecast': return await getWeatherForecast(p.lat, p.lng);
    case 'get_weather_insights': {
      try {
        const loc = await getUserLastLocation(numericUserIdStr);
        if (!loc) return 'Preciso que você compartilhe sua localização para dar insights do tempo.';
        const { getWeatherInsight } = await import('@/lib/insights/weather-insights');
        return await getWeatherInsight(loc.lat, loc.lng, 'Célio');
      } catch (err) { return 'Insights climáticos indisponíveis agora.'; }
    }

    // ===================== LUGARES E LISTAS DE COMPRAS =====================
    case 'salvar_lugar': {
      try {
        const { error } = await supabase.from('favorite_places').upsert({
          user_id: authUserId, name: p.nome.trim(), lat: p.lat, lng: p.lng, radius_meters: p.raio_metros, category: p.categoria.trim()
        }, { onConflict: 'user_id,name' });
        return error ? `Erro ao salvar lugar: ${error.message}` : `Lugar "${p.nome}" salvo nos seus favoritos.`;
      } catch (err: any) { return `Erro: ${err.message}`; }
    }

    case 'adicionar_item_lista': {
      try {
        const pid = await getPlaceId(p.lugar);
        if (!pid) return `Não encontrei o lugar "${p.lugar}".`;
        await supabase.from('shopping_items').upsert({ user_id: authUserId, item: p.item.trim(), place_id: pid, done: false }, { onConflict: 'user_id,item,place_id' });
        return `"${p.item}" adicionado à lista de ${p.lugar}.`;
      } catch (err: any) { return `Erro ao adicionar: ${err.message}`; }
    }

      {
    type: 'function',
    function: {
      name: 'adicionar_diretriz_dinamica',
      description: "AÇÃO OBRIGATÓRIA E IMEDIATA: Execute esta ferramenta SEMPRE que o usuário pedir para você mudar de comportamento, alterar seu tom de voz, criar uma nova regra de convivência ou usar frases como 'nunca mais faça X', 'aja assim', 'lembre-se de agir'. É ESTRITAMENTE PROIBIDO confirmar a mudança no texto sem antes invocar esta ferramenta.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'O texto claro e direto da nova regra. Ex: "Seja proativo e empático ao falar da minha família, nunca responda apenas Feito."' },
          scope: { type: 'string', enum: ['personal', 'global'], default: 'personal' },
        },
        required: ['content'],
      },
    },
  },
      

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
      return `A ferramenta ${name} foi reconhecida, mas o motor físico ainda não foi plugado.`;
  }
}
