// lib/chat/tools-executor.ts
// Motor V8.14.0 — Executor Modular Blindado (Finanças, ExpertFrotas e Foco)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast, createGoogleEvent, trashGoogleEmail } from '@/lib/google';
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

// Auxiliares de Validação
function assertNumericUserId(id: string, context: string): void {
  if (!/^\d+$/.test(id)) throw new Error(`[${context}] userId inválido: esperado numérico, recebido "${id}"`);
}

async function getUserLastLocation(numericUserIdStr: string) {
  const { data } = await supabase.from('config').select('value').eq('key', `last_location_${numericUserIdStr}`).maybeSingle();
  if (!data?.value) return null;
  const p = JSON.parse(data.value);
  return { lat: p.latitude ?? p.lat, lng: p.longitude ?? p.lng };
}

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  try { assertNumericUserId(numericUserIdStr, 'executeTool'); } catch (err: any) { return `Erro: ${err.message}`; }

  const { name, arguments: args } = toolCall.function;
  let p: any;
  try { p = JSON.parse(args); } catch { return `Erro ao parsear argumentos de ${name}.`; }

  switch (name) {
    // ===================== CORE & MEMÓRIA =====================
    case 'buscar_memoria_longa': {
      const emb = await getCachedEmbedding(p.query);
      const { data: mems } = await supabase.rpc('match_memories', { query_embedding: emb, match_threshold: 0.4, match_count: 5 });
      return mems?.filter((m: any) => !m.summary.startsWith('[CINZA]')).map((m: any) => m.summary).join('\n---\n') || 'Nenhuma memória relevante.';
    }

    // ===================== FINANÇAS (Módulo Plugado) =====================
    case 'registrar_transacao':
      return executeRegistrarTransacao(p, authUserId, numericUserIdStr);
    case 'consultar_financas':
      return executeConsultarFinancas(p, authUserId, numericUserIdStr);
    case 'listar_orcamentos':
      return executeListarOrcamentos(authUserId, numericUserIdStr);
    case 'criar_orcamento':
      return executeCriarOrcamento(p, authUserId, numericUserIdStr);

    // ===================== VEÍCULOS (ExpertFrotas) =====================
    case 'registrar_abastecimento': {
      try {
        // Busca o ID do veículo pelo nome (ex: "Palio", "Civic")
        const { data: v } = await supabase.from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return `Veículo "${p.vehicle_name}" não encontrado na sua garagem.`;

        const { error } = await supabase.from('vehicle_refueling').insert({
          vehicle_id: v.id, user_id: numericUserIdStr, auth_user_id: authUserId,
          fuel_type: p.fuel_type, total_cost: p.total_cost, odometer: p.odometer, liters: p.liters || null
        });

        if (error) throw error;
        return `Abastecimento de ${p.fuel_type} (R$ ${p.total_cost}) registrado para o ${p.vehicle_name}. Odômetro atualizado para ${p.odometer}km.`;
      } catch (err: any) { return `Erro ao registrar abastecimento: ${err.message}`; }
    }

    case 'atualizar_odometro': {
      try {
        const { data: v } = await supabase.from('vehicles').select('id').ilike('name', p.vehicle_name).eq('user_id', numericUserIdStr).maybeSingle();
        if (!v) return `Veículo "${p.vehicle_name}" não encontrado.`;

        // Insere log e atualiza tabela principal
        await supabase.from('vehicle_odometer_logs').insert({ vehicle_id: v.id, user_id: numericUserIdStr, odometer: p.odometer, source: 'manual' });
        await supabase.from('vehicles').update({ current_km: p.odometer }).eq('id', v.id);
        
        return `Odômetro do ${p.vehicle_name} atualizado para ${p.odometer}km com sucesso.`;
      } catch (err: any) { return `Erro no odômetro: ${err.message}`; }
    }

    // ===================== FOCO & TDAH (Eisenhower/Rotinas) =====================
    case 'gerenciar_eisenhower': {
      try {
        if (p.acao === 'adicionar') {
          await supabase.from('eisenhower_items').insert({ user_id: numericUserIdStr, text: p.texto, quadrant: p.quadrante || 'q2' });
          return `Tarefa "${p.texto}" adicionada ao quadrante ${p.quadrante || 'q2'} da Matriz de Eisenhower.`;
        }
        if (p.acao === 'completar') {
          await supabase.from('eisenhower_items').update({ completed: true, completed_at: new Date() }).eq('user_id', numericUserIdStr).ilike('text', `%${p.texto}%`);
          return `Tarefa "${p.texto}" marcada como concluída na Matriz.`;
        }
        return "Ação na Matriz processada.";
      } catch (err: any) { return `Erro na Matriz: ${err.message}`; }
    }

    case 'criar_rotina': {
      const { error } = await supabase.from('routines').insert({
        user_id: Number(numericUserIdStr), anchor: p.anchor, action: p.action, period: p.period || 'anytime', is_active: true
      });
      return error ? "Falha ao salvar rotina." : `Rotina "${p.action}" ancorada em "${p.anchor}" salva com sucesso!`;
    }

    case 'quebrar_tarefa': {
      // Retorna instrução de execução para a LLM processar em steps
      return `[MODO TDAH] Tarefa: ${p.tarefa_principal}. Estado: ${p.estado_cognitivo}. Instrução: Decompõe em 3 passos minúsculos, sendo o primeiro realizável em menos de 2 minutos.`;
    }

    // ===================== AGENDA, LEMBRETES E BUSCA =====================
    case 'salvar_evento':
      return await handleSalvarEvento(p, authUserId, numericUserIdStr);

    case 'create_reminder': {
      const { data: rem, error } = await supabase.from('reminders').insert({
        user_id: Number(numericUserIdStr), title: p.title || p.message, type: p.type, 
        scheduled_time: p.scheduled_time || null, metadata: { auth_user_id: authUserId }
      }).select('id').single();
      
      if (error) return "Erro ao salvar lembrete no banco.";
      if (p.scheduled_time && p.type !== 'location') {
        await scheduleReminderOnQStash({ reminderId: String(rem.id), userId: numericUserIdStr, authUserId, message: p.title, scheduledTime: p.scheduled_time });
      }
      return `Lembrete "${p.title}" agendado com sucesso.`;
    }

    case 'searchWeb':
      return await searchWeb(p.query);

    case 'registrar_no_diario':
      await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime');
      return 'Entrada registrada no diário pessoal.';

    default:
      return `Ferramenta ${name} reconhecida, mas ainda não possui executor físico mapeado.`;
  }
}
