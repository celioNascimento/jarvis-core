// lib/tools/executors/tdah.ts
// V1.0.0 — Executor de TDAH e Foco Integrado à SSOT

import { supabase } from '@/lib/jarvis';
import { getEffectiveUserId } from '@/lib/modules/relationships';
import { 
  coreCreateBrainDump, 
  coreCreateTaskBreakdown, 
  coreCreateEisenhowerItem, 
  coreCreateFocusSession, 
  coreGetFocusSummary 
} from '@/lib/services/tdah.service';

export async function executeGerenciarEisenhower(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    const { acao, item_id, text, quadrant, completed } = p;

    if (acao === 'criar') {
      const item = await coreCreateEisenhowerItem(targetId, { text, quadrant, completed });
      return `Tarefa "${item.text}" adicionada ao quadrante ${item.quadrant.toUpperCase()}.`;
    }

    if (acao === 'listar') {
      const { data, error } = await supabase.schema('jarvis').from('eisenhower_items')
        .select('*').eq('user_id', targetId).eq('completed', false).order('created_at', { ascending: false });
      if (error) throw error;
      if (!data?.length) return 'Matriz de Eisenhower está vazia.';
      return data.map(i => `[${i.quadrant.toUpperCase()}] ${i.text} (ID: ${i.id})`).join('\n');
    }

    if (!item_id) return 'ID do item é obrigatório para atualizar ou remover.';

    if (acao === 'atualizar') {
      const updates: any = {};
      if (text) updates.text = text;
      if (quadrant) updates.quadrant = quadrant;
      if (completed !== undefined) updates.completed = completed;

      const { error } = await supabase.schema('jarvis').from('eisenhower_items')
        .update(updates).eq('id', item_id).eq('user_id', targetId);
      if (error) throw error;
      return 'Item atualizado com sucesso.';
    }

    if (acao === 'remover') {
      const { error } = await supabase.schema('jarvis').from('eisenhower_items')
        .delete().eq('id', item_id).eq('user_id', targetId);
      if (error) throw error;
      return 'Item removido da matriz.';
    }

    return 'Ação não reconhecida.';
  } catch (err: any) { return `Erro na Matriz: ${err.message}`; }
}

export async function executeQuebrarTarefa(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    await coreCreateTaskBreakdown(targetId, p);
    return `Quebra da tarefa "${p.original_task}" salva com sucesso.`;
  } catch (err: any) { return `Erro ao quebrar tarefa: ${err.message}`; }
}

export async function executeRegistrarDespejo(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    await coreCreateBrainDump(targetId, p);
    return 'Despejo mental registrado com sucesso. A mente está mais leve!';
  } catch (err: any) { return `Erro ao registrar despejo: ${err.message}`; }
}

export async function executeRegistrarSessaoFoco(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    await coreCreateFocusSession(targetId, p);
    return 'Sessão de foco registrada no banco de dados.';
  } catch (err: any) { return `Erro ao registrar sessão: ${err.message}`; }
}

export async function executeConsultarResumoFoco(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    const summary = await coreGetFocusSummary(targetId);
    return summary;
  } catch (err: any) { return `Erro ao buscar resumo: ${err.message}`; }
}
