// lib/services/partner.service.ts
import { supabase } from '@/lib/jarvis';
import { RELATIONSHIP_MODULES } from '../../app/constants/modules';

export async function getPartnerContextForChat(authUserId: string): Promise<string> {
  try {
    const { data: relationships } = await supabase
      .from('relationships')
      .select('user_id_a, user_id_b, settings, contact_name')
      .eq('status', 'active')
      .or(`user_id_a.eq.${authUserId},user_id_b.eq.${authUserId}`);

    if (!relationships || relationships.length === 0) return "";

    let sharedContext = "";

    for (const rel of relationships) {
      const partnerUUID = rel.user_id_a === authUserId ? rel.user_id_b : rel.user_id_a;
      const partnerName = rel.contact_name || "Parceiro";
      const settings = rel.settings || {};

      for (const mod of RELATIONSHIP_MODULES) {
        if (settings[mod.settingsKey] === true) {
          
          let dbQuery = supabase.from(mod.tableName).select('*');

          if (mod.tableName === 'reminders') {
            dbQuery = dbQuery
              .eq('user_id', partnerUUID)
              .eq('status', 'pending')
              .gte('scheduled_time', new Date().toISOString());
          } else {
            dbQuery = dbQuery.eq('user_id', partnerUUID);
          }

          const { data: items } = await dbQuery
            .order('created_at', { ascending: false })
            .limit(5);

          if (items && items.length > 0) {
            sharedContext += `\n[${mod.contextLabel} DE ${partnerName.toUpperCase()}]:\n`;
            items.forEach((item: any) => {
              const detail = item.title || item.item || item.description || (item.amount ? `R$ ${item.amount}` : "Registro");
              const date = item.scheduled_time || item.start_at || item.created_at;
              sharedContext += `- ${detail} ${date ? `(Data/Hora: ${new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})` : ''}\n`;
            });
          }
        }
      }
    }
    return sharedContext;
  } catch (e) {
    console.error("[ModularContext] Erro na varredura de vínculos:", e);
    return "";
  }
}
