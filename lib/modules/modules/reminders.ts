import { supabase } from "@/lib/jarvis";
import { getEffectiveUserId } from "../relationships";
import { ModuleDefinition } from "../types";

// lib/modules/reminders.module.ts
export const ModuloReminders: ModuleDefinition = {
  id: 'reminders_push',
  label: 'Lembretes e Notificações',
  preferredModel: 'flash',
  plan: 'free',
  trigger: {
    always: true,
    contexts: ['lembrete', 'notificacao'],
    keywords: /lembrete|me lembra|avisar|daqui a pouco|notificar/i
  },
  buildContextBlock: async (opts) => {
    try {
      const targetId = await getEffectiveUserId(opts.userId, opts.userId);
      const { data, error } = await supabase
        .from('reminders')
        .select('title, scheduled_time, frequency, type')
        .eq('user_id', Number(targetId))
        .eq('status', 'pending')
        .gte('scheduled_time', new Date().toISOString())
        .order('scheduled_time', { ascending: true })
        .limit(10);

      if (error || !data || data.length === 0) return 'Nenhum lembrete pendente.';

      const linhas = data.map((r: any) => {
        const hora = new Date(r.scheduled_time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const freq = r.frequency ? ` (${r.frequency})` : '';
        return `- ${r.title} → ${hora}${freq}`;
      }).join('\n');

      return `[LEMBRETES PENDENTES]\n${linhas}`;
    } catch (e) {
      console.error('[ModuloReminders] Erro:', e);
      return '';
    }
  },
  tools: [
    'lembrete_criar',
    'lembrete_consultar',
    'lembrete_cancelar',
  ],
  metrics: { avgTokens: 0, avgLatencyMs: 0, activationCount: 0 }
};