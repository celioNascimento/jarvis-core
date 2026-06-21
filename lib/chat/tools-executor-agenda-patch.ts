// lib/chat/tools-executor-agenda-patch.ts
// PATCH para a função executeTool existente em tools-executor.ts
//
// INSTRUÇÃO DE INTEGRAÇÃO:
// No seu tools-executor.ts, substitua o case 'salvar_evento' pelo bloco abaixo.
// A lógica agora salva SEMPRE em jarvis.agenda (compromissos com hora)
// e mantém jarvis.events apenas para datas importantes/aniversários sem hora fixa.

import {supabase} from "@/lib/jarvis";

// ── Tipo do args esperado pelo LLM ────────────────────────────────────────────
interface SalvarEventoArgs {
  title:       string;
  event_date:  string;        // ISO: "2025-05-10T14:00:00"
  category?:   string;
  notes?:      string;
  recurrence?: string | null;
  is_recurring?: boolean;
}

// ── Resolve numeric user ID a partir do auth UUID ─────────────────────────────
async function resolveNumericUserId(authUserId: string): Promise<string | null> {
  const { data } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.id ? String(data.id) : null;
}

// ── Detecta se a data tem hora significativa ──────────────────────────────────
function hasSignificantTime(isoDate: string): boolean {
  if (!isoDate.includes('T')) return false;
  const time = isoDate.split('T')[1] || '';
  return !time.startsWith('00:00');
}

// ── Handler principal ─────────────────────────────────────────────────────────
export async function handleSalvarEvento(
  args: SalvarEventoArgs,
  authUserId: string,
  numericUserIdStr: string,
): Promise<string> {
  try {
    const { title, event_date, category = 'Compromisso', notes, is_recurring } = args;

    if (!title || !event_date) {
      return JSON.stringify({ success: false, error: 'title e event_date são obrigatórios.' });
    }

    // Valida ISO
    const parsedDate = new Date(event_date);
    if (isNaN(parsedDate.getTime())) {
      return JSON.stringify({ success: false, error: `Data inválida: ${event_date}` });
    }

    const numericUserId = numericUserIdStr || await resolveNumericUserId(authUserId);
    if (!numericUserId) {
      return JSON.stringify({ success: false, error: 'Usuário não encontrado.' });
    }

    // ── Decisão de tabela ─────────────────────────────────────────────────────
    // • jarvis.agenda  → compromissos com hora (consultas, reuniões, eventos)
    // • jarvis.events  → datas importantes sem hora (aniversários, feriados pessoais, metas)

    const isTimedEvent = hasSignificantTime(event_date);
    const isAnniversaryOrMemorial = /aniversário|aniversario|nascimento|morte|memorial|formatura/i.test(category + ' ' + title);

    if (isTimedEvent && !isAnniversaryOrMemorial) {
      // ── Salva em jarvis.agenda ──
      const { data, error } = await supabase
        .schema('jarvis')
        .from('agenda')
        .insert({
          user_id:     parseInt(numericUserId, 10),
          description: title,
          event_at:    parsedDate.toISOString(),
          category:    category,
          is_notified: false,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[salvar_evento] Erro ao inserir em agenda:', error);
        return JSON.stringify({ success: false, error: error.message });
      }

      const formattedDate = parsedDate.toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long',
      });
      const formattedTime = parsedDate.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit',
      });

      console.log(`[salvar_evento] Salvo em jarvis.agenda — id: ${data?.id}, user: ${numericUserId}`);

      return JSON.stringify({
        success:  true,
        id:       data?.id,
        table:    'agenda',
        message:  `Feito. "${title}" na agenda para ${formattedDate} às ${formattedTime}.`,
      });

    } else {
      // ── Salva em jarvis.events (datas importantes / recorrentes) ──
      const { data, error } = await supabase
        .schema('jarvis')
        .from('events')
        .insert({
          user_id:          parseInt(numericUserId, 10),
          title,
          event_date:       parsedDate.toISOString(),
          category:         category,
          notes:            notes || null,
          relevance_score:  0.7,
          emotional_weight: 0.5,
          is_recurring:     is_recurring ?? isAnniversaryOrMemorial,
          decay_type:       is_recurring ? 'annual' : 'none',
        })
        .select('id')
        .single();

      if (error) {
        console.error('[salvar_evento] Erro ao inserir em events:', error);
        return JSON.stringify({ success: false, error: error.message });
      }

      const formattedDate = parsedDate.toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric',
      });

      console.log(`[salvar_evento] Salvo em jarvis.events — id: ${data?.id}, user: ${numericUserId}`);

      return JSON.stringify({
        success:  true,
        id:       data?.id,
        table:    'events',
        message:  `Feito. "${title}" registrado para ${formattedDate}.`,
      });
    }

  } catch (e: any) {
    console.error('[salvar_evento] Exceção:', e?.message);
    return JSON.stringify({ success: false, error: e?.message || 'Erro desconhecido.' });
  }
}

