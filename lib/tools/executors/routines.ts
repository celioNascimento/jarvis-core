// lib/tools/executors/routines.ts
// V1.0.0 — Executor de Rotinas Integrado à SSOT

import { getEffectiveUserId } from '@/lib/modules/relationships';
import { 
  coreGetRoutines, 
  coreCreateRoutine, 
  coreUpdateRoutine, 
  coreDeleteRoutine,
  coreGetCheckins,
  coreProcessCheckin
} from '@/lib/services/routines.service';

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

export async function executeListarRotinas(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    
    const [routines, checkins] = await Promise.all([
      coreGetRoutines(targetId),
      coreGetCheckins(targetId, getTodayStr())
    ]);

    if (!routines.length) return 'Nenhuma rotina ativa encontrada.';

    return routines.map(r => {
      const checkin = checkins.find((c: any) => c.routine_id === r.id);
      let statusIcon = '⏳'; // Pendente
      if (checkin?.status === 'done') statusIcon = '✅';
      if (checkin?.status === 'skipped') statusIcon = '⏭️';

      return `${statusIcon} [${r.period.toUpperCase()}] ${r.anchor} -> ${r.action} (ID: ${r.id})`;
    }).join('\n');

  } catch (err: any) {
    return `Erro ao listar rotinas: ${err.message}`;
  }
}

export async function executeGerenciarRotina(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    const { acao, routine_id, anchor, action, period, goal_tag } = p;

    if (acao === 'criar') {
      const data = await coreCreateRoutine(targetId, { anchor, action, period, goal_tag });
      return `Rotina criada com sucesso: "${data.anchor} -> ${data.action}".`;
    }

    if (!routine_id) return 'O ID da rotina é obrigatório para atualizar ou remover.';

    if (acao === 'atualizar') {
      await coreUpdateRoutine(targetId, routine_id, { anchor, action, period, goal_tag });
      return 'Rotina atualizada com sucesso.';
    }

    if (acao === 'remover') {
      await coreDeleteRoutine(targetId, routine_id);
      return 'Rotina removida com sucesso.';
    }

    return 'Ação não reconhecida.';
  } catch (err: any) {
    return `Erro ao gerenciar rotina: ${err.message}`;
  }
}

export async function executeFazerCheckinRotina(p: any, authUserId: string, numericUserId: string): Promise<string> {
  try {
    const targetId = Number(await getEffectiveUserId(authUserId, numericUserId));
    const { rotina_texto, status, note } = p;

    // 1. Busca todas as rotinas para encontrar qual o usuário quer marcar
    const routines = await coreGetRoutines(targetId);
    if (!routines.length) return 'Você não possui rotinas ativas.';

    // 2. Tenta encontrar a rotina por aproximação de texto (âncora ou ação)
    const termo = rotina_texto.toLowerCase();
    const match = routines.find((r: any) => 
      r.id === rotina_texto || 
      r.action.toLowerCase().includes(termo) || 
      r.anchor.toLowerCase().includes(termo)
    );

    if (!match) return `Não encontrei nenhuma rotina parecida com "${rotina_texto}".`;

    // 3. Processa o Check-in na SSOT
    const dbStatus = status === 'reset' ? null : status;
    await coreProcessCheckin(targetId, {
      routine_id: match.id,
      status: dbStatus,
      date: getTodayStr(),
      note
    });

    if (status === 'done') return `Rotina "${match.action}" marcada como FEITA ✅!`;
    if (status === 'skipped') return `Rotina "${match.action}" PULADA hoje ⏭️.`;
    return `Check-in da rotina "${match.action}" foi removido/resetado.`;

  } catch (err: any) {
    return `Erro no check-in: ${err.message}`;
  }
}
