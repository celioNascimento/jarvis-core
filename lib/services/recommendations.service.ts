// lib/services/recommendations.service.ts
import { supabase } from '@/lib/jarvis';
import { invalidateContextField } from '@/lib/services/context-cache';

export const recommendationsService = {
  async processRecommendations(userId: number, recomendacoes: any[]) {
    for (const rec of recomendacoes) {
      if (!rec.nome || !rec.tipo) continue;
      
      const { data: existing } = await supabase
        .schema('jarvis')
        .from('recommendations')
        .select('id, status')
        .eq('user_id', userId)
        .eq('type', rec.tipo)
        .ilike('name', rec.nome)
        .maybeSingle();

      if (existing) {
        if (rec.status !== 'pending' && existing.status === 'pending') {
          await supabase
            .schema('jarvis')
            .from('recommendations')
            .update({ status: rec.status, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        }
      } else {
        await supabase
          .schema('jarvis')
          .from('recommendations')
          .insert({ 
            user_id: userId, 
            type: rec.tipo, 
            name: rec.nome, 
            source: rec.source || 'jarvis', 
            status: rec.status || 'pending' 
          });
      }
    }
    await invalidateContextField(userId, 'recommendations').catch(() => {});
  }
};