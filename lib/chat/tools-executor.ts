// lib/chat/tools-executor.ts
// Dual-ID:
//   authUserId       → favorite_places + shopping_items (UUID do Auth)
//   numericUserIdStr → todas as demais tabelas jarvis (bigint)

import { supabase } from '@/lib/jarvis';
import { getRecentEmails, getMicrosoftCalendarContext } from '@/lib/microsoft';
import { getGoogleContext, searchWeb, getWeatherForecast } from '@/lib/google';
import { upsertEvent } from '@/lib/extractor-jobs';
import { extractDiary } from '@/lib/diary';
import { updateGoalProgress } from '@/lib/diary';
import { getCachedEmbedding } from './embedding-cache';
import { assertNumericUserId } from './guards';

// ===================== INSIGHTS (convertem dados em informação relevante) =====================
// Certifique-se de que os arquivos existam em lib/insights/
import { getWeatherInsight } from '@/lib/insights/weather-insights';
// import { getHolidayInsight } from '@/lib/insights/holiday-insights';    // descomente quando implementado
// import { getDocumentInsight } from '@/lib/insights/document-insights';  // descomente quando implementado
// import { getCalendarInsight } from '@/lib/insights/calendar-insights';  // descomente quando implementado
// ============================================================================================

// ---------------------------------------------------------------------------
// Helper para obter a última localização salva do usuário
// ---------------------------------------------------------------------------
async function getUserLastLocation(numericUserIdStr: string): Promise<{ lat: number; lng: number } | null> {
  const { data: locData } = await supabase
    .from('config')
    .select('value')
    .eq('key', `last_location_${numericUserIdStr}`)
    .single();
  if (!locData?.value) return null;
  try {
    const { latitude, longitude } = JSON.parse(locData.value);
    return { lat: latitude, lng: longitude };
  } catch {
    return null;
  }
}

export async function executeTool(
  toolCall: any,
  authUserId: string,
  numericUserIdStr: string
): Promise<string> {
  assertNumericUserId(numericUserIdStr, 'executeTool');

  const { name, arguments: args } = toolCall.function;
  let p: any;
  try {
    p = JSON.parse(args);
  } catch {
    return `Erro ao parsear argumentos de ${name}.`;
  }

  async function getPlaceId(nome: string): Promise<string | null> {
    const { data } = await supabase
      .from('favorite_places')
      .select('id')
      .eq('user_id', authUserId)
      .ilike('name', nome.trim())
      .single();
    return data?.id ?? null;
  }

  switch (name) {
    case 'buscar_memoria_longa': {
      const emb = await getCachedEmbedding(p.query);
      const { data: mems } = await supabase.rpc('match_memories', {
        query_embedding: emb,
        match_threshold: 0.4,
        match_count: 5,
      });
      return (
        (mems as any[])
          ?.filter((m) => !m.summary.startsWith('[CINZA]'))
          .map((m) => m.summary)
          .join('\n---\n') || 'Nenhuma memória relevante.'
      );
    }

    case 'consultar_agenda': {
      const [g, o] = await Promise.all([getGoogleContext(), getMicrosoftCalendarContext()]);
      return `Google Calendar:\n${g}\n\nOutlook:\n${o}`;
    }

    case 'listar_emails_recentes':
      return await getRecentEmails(p.filtro, 5, true);

    case 'salvar_evento': {
      const cat = p.titulo.toLowerCase().includes('aniversario') ? 'family' : 'personal';
      await upsertEvent(numericUserIdStr, {
        title: p.titulo,
        event_date: p.data,
        priority: p.prioridade,
        is_recurring: p.recorrente,
        decay_type: p.tipo,
        category: cat,
        emotional_weight: p.prioridade === 'alta' ? 0.9 : p.prioridade === 'media' ? 0.6 : 0.3,
      });
      return `Evento "${p.titulo}" salvo.`;
    }

    case 'atualizar_meta':
      return await updateGoalProgress(numericUserIdStr, p.titulo_parcial, p.progresso, p.etapa_concluida);

    case 'registrar_no_diario':
      await extractDiary(numericUserIdStr, p.texto, p.categoria || 'anytime');
      return 'Entrada registrada no diário.';

    case 'pesquisar_internet':
    case 'searchWeb': {
      console.log(`[tool] searchWeb: "${p.query}"`);
      const result = await searchWeb(p.query);
      console.log(`[tool] resultado: ${result.substring(0, 200)}`);
      return result;
    }

    case 'getWeatherForecast':
      return await getWeatherForecast(p.lat, p.lng);

    case 'salvar_lugar': {
      const { error } = await supabase.from('favorite_places').upsert(
        {
          user_id: authUserId,
          name: p.nome.trim(),
          lat: p.lat,
          lng: p.lng,
          radius_meters: p.raio_metros,
          category: p.categoria.trim(),
        },
        { onConflict: 'user_id,name' }
      );
      return error ? `Erro: ${error.message}` : `Lugar "${p.nome}" salvo.`;
    }

    case 'remover_lugar':
      await supabase.from('favorite_places').delete().eq('user_id', authUserId).ilike('name', p.nome.trim());
      return `Lugar "${p.nome}" removido.`;

    case 'adicionar_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').upsert(
        { user_id: authUserId, item: p.item.trim(), place_id: pid, done: false },
        { onConflict: 'user_id,item,place_id' }
      );
      return `"${p.item}" adicionado à lista de ${p.lugar}.`;
    }

    case 'marcar_feito': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').update({ done: true }).eq('user_id', authUserId).ilike('item', p.item.trim()).eq('place_id', pid);
      return `"${p.item}" marcado como comprado.`;
    }

    case 'remover_item_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lugar "${p.lugar}" não encontrado.`;
      await supabase.from('shopping_items').delete().eq('user_id', authUserId).ilike('item', p.item.trim()).eq('place_id', pid);
      return `"${p.item}" removido.`;
    }

    case 'ver_lista': {
      const pid = await getPlaceId(p.lugar);
      if (!pid) return `Lista de ${p.lugar} está vazia.`;
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item, done')
        .eq('user_id', authUserId)
        .eq('place_id', pid)
        .order('done');
      if (!itens?.length) return `Lista de ${p.lugar} está vazia.`;
      return `Lista de ${p.lugar}:\n${itens.map((i: any) => `${i.done ? '✅' : '•'} ${i.item}`).join('\n')}`;
    }

    // ===================== FERRAMENTAS DE INSIGHT =====================
    case 'get_weather_insights': {
      const location = await getUserLastLocation(numericUserIdStr);
      if (!location) {
        return 'Não sei sua localização atual. Compartilhe sua localização no chat para eu poder dar dicas do clima.';
      }
      // Obtém o nome do usuário (opcional) – tenta extrair do perfil
      let userName = '';
      const { data: userData } = await supabase
        .from('users')
        .select('nickname')
        .eq('id', numericUserIdStr)
        .single();
      if (userData?.nickname) userName = userData.nickname;
      return await getWeatherInsight(location.lat, location.lng, userName);
    }

    // Exemplo de como adicionar outros insights (descomente quando os módulos estiverem prontos)
    /*
    case 'get_holiday_insight': {
      return await getHolidayInsight(numericUserIdStr);
    }
    case 'get_document_insight': {
      return await getDocumentInsight(numericUserIdStr);
    }
    case 'get_calendar_insight': {
      return await getCalendarInsight(numericUserIdStr, authUserId);
    }
    */

    default:
      return `Ferramenta ${name} não implementada.`;
  }
}