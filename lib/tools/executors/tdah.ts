// lib/tools/executors/tdah.ts
// Domínio: Foco, TDAH e Diário
// Tools: gerenciar_eisenhower, quebrar_tarefa, criar_rotina,
//        registrar_no_diario, atualizar_meta

import { supabase } from '@/lib/jarvis';
import { extractDiary, updateGoalProgress } from '@/lib/diary';

// ─── gerenciar_eisenhower ─────────────────────────────────────────────────────

export async function executeGerenciarEisenhower(
  p: {
    acao: 'adicionar' | 'completar' | 'mover';
    texto: string;
    quadrante?: string;
  },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    if (p.acao === 'adicionar') {
      await supabase
        .schema('jarvis')
        .from('eisenhower_items')
        .insert({ user_id: numericUserId, text: p.texto, quadrant: p.quadrante || 'q2' });
      return `Tarefa "${p.texto}" adicionada ao quadrante ${p.quadrante || 'q2'} da Matriz.`;
    }

    if (p.acao === 'completar') {
      await supabase
        .schema('jarvis')
        .from('eisenhower_items')
        .update({ completed: true, completed_at: new Date() })
        .eq('user_id', numericUserId)
        .ilike('text', `%${p.texto}%`);
      return 'Tarefa concluída com sucesso.';
    }

    return 'Ação processada na Matriz de Eisenhower.';
  } catch (err: any) {
    return `Erro na Matriz: ${err.message}`;
  }
}

// ─── quebrar_tarefa ───────────────────────────────────────────────────────────

export async function executeQuebrarTarefa(
  p: { tarefa_principal: string; estado_cognitivo: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  await supabase.from('brain').insert([{
    user_id:     Number(numericUserId),
    category:    'Nota',
    content:     `Iniciou quebra de tarefa: ${p.tarefa_principal}`,
    project_tag: 'foco',
  }]);

  return `[MODO TDAH] Tarefa: "${p.tarefa_principal}".\n1. Primeiro passo minúsculo (< 2 min).\n2. Diga "feito" para o próximo passo.`;
}

// ─── criar_rotina ─────────────────────────────────────────────────────────────

export async function executeCriarRotina(
  p: { anchor: string; action: string; period: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    const { error } = await supabase
      .schema('jarvis')
      .from('routines')
      .insert({
        user_id: Number(numericUserId),
        anchor:  p.anchor,
        action:  p.action,
        period:  p.period,
        active:  true,
      });

    return error
      ? `Erro ao criar rotina: ${error.message}`
      : `Rotina criada: "${p.anchor}" → "${p.action}" (${p.period}).`;
  } catch (err: any) {
    return `Erro técnico: ${err.message}`;
  }
}

// ─── registrar_no_diario ──────────────────────────────────────────────────────

export async function executeRegistrarNoDiario(
  p: { texto: string; categoria?: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    await extractDiary(numericUserId, p.texto, p.categoria as any || 'anytime');
    return 'Entrada registrada no seu diário pessoal.';
  } catch (err: any) {
    return `Erro no diário: ${err.message}`;
  }
}

// ─── atualizar_meta ───────────────────────────────────────────────────────────

export async function executeAtualizarMeta(
  p: { titulo_parcial: string; progresso: number; etapa_concluida?: string },
  _authUserId: string,
  numericUserId: string
): Promise<string> {
  try {
    return await updateGoalProgress(numericUserId, p.titulo_parcial, p.progresso, p.etapa_concluida);
  } catch (err: any) {
    return `Erro na meta: ${err.message}`;
  }
}