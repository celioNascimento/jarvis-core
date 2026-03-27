// lib/gatilhos.ts

import {
    createOutlookEvent, updateOutlookEvent,
    getRecentEmails, addEmailKeyword, removeEmailKeyword,
  } from '@/lib/microsoft';
  import {
    createGoogleEvent, updateGoogleEvent, deleteGoogleEvent,
  } from '@/lib/google';
  import { upsertEvent } from '@/lib/extractor-jobs';
  import { updateGoalProgress } from '@/lib/diary';
  import { supabase } from '@/lib/jarvis';
  
  export interface GatilhoContext {
    userId: string;
    chatId: number;
  }
  
  interface GatilhoHandler {
    name: string;
    regex: RegExp;
    handle: (
      match: RegExpMatchArray,
      ctx: GatilhoContext
    ) => Promise<string | null>;  // retorna texto a concatenar, ou null
  }
  
  // ── helpers internos ────────────────────────────────────────
  
  async function getPlaceId(userId: string, nomeLugar: string) {
    const { data } = await supabase
      .from('favorite_places').select('id')
      .eq('user_id', userId).ilike('name', nomeLugar.trim()).single();
    return data?.id ?? null;
  }
  
  const CAT_MAP: Record<string, string> = {
    aniversario: 'family', aniversário: 'family',
    casamento: 'family', pascoa: 'family', páscoa: 'family',
    natal: 'family', 'ano novo': 'family',
    consulta: 'health', médic: 'health', exame: 'health',
    reuniao: 'work', reunião: 'work', entrega: 'work', prazo: 'work',
    viagem: 'personal', ferias: 'personal', férias: 'personal',
  };
  
  // ── handlers ────────────────────────────────────────────────
  
  const HANDLERS: GatilhoHandler[] = [
    {
      name: 'SALVAR_EVENTO',
      regex: /\[SALVAR_EVENTO:\s*(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(alta|media|baixa)\s*\|\s*(true|false)\s*\|\s*(permanent|recurring_annual|deadline|one_time)\]/gi,
      async handle(m, { userId }) {
        const title = m[1].trim();
        const titleLower = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const category = Object.entries(CAT_MAP).find(([k]) => titleLower.includes(k))?.[1] || 'personal';
        const emotionalWeight = m[3] === 'alta' ? 0.9 : m[3] === 'media' ? 0.6 : 0.3;
        await upsertEvent(userId, {
          title, event_date: m[2], priority: m[3],
          is_recurring: m[4] === 'true', decay_type: m[5],
          category, emotional_weight: emotionalWeight,
        });
        return null;
      },
    },
    {
      name: 'AGENDAR (Outlook)',
      regex: /\[AGENDAR:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i,
      async handle(m) {
        const res = await createOutlookEvent(m[1].trim(), m[2].trim(), parseInt(m[3]));
        return `\n\n🗓️ *Agendado (Outlook):* ${res}`;
      },
    },
    {
      name: 'ATUALIZAR_EVENTO (Outlook)',
      regex: /\[ATUALIZAR_EVENTO:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i,
      async handle(m) {
        const res = await updateOutlookEvent(m[1].trim(), m[2].trim(), m[3].trim(), parseInt(m[4]));
        return `\n\n🗓️ *Atualizado (Outlook):* ${res}`;
      },
    },
    {
      name: 'AGENDAR_GOOGLE',
      regex: /\[AGENDAR_GOOGLE:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i,
      async handle(m) {
        const res = await createGoogleEvent(m[1].trim(), m[2].trim(), parseInt(m[3]));
        return `\n\n🗓️ *Agendado (Google):* ${res}`;
      },
    },
    {
      name: 'ATUALIZAR_GOOGLE',
      regex: /\[ATUALIZAR_GOOGLE:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\]/i,
      async handle(m) {
        const res = await updateGoogleEvent(m[1].trim(), m[2].trim(), m[3].trim(), parseInt(m[4]));
        return `\n\n🗓️ *Atualizado (Google):* ${res}`;
      },
    },
    {
      name: 'DELETAR_GOOGLE',
      regex: /\[DELETAR_GOOGLE:\s*(.*?)\]/i,
      async handle(m) {
        const res = await deleteGoogleEvent(m[1].trim());
        return `\n\n🗑️ *Removido (Google):* ${res}`;
      },
    },
    {
      name: 'LER_EMAILS',
      regex: /\[LER_EMAILS(?::\s*([^\]]+))?\]/i,
      async handle(m) {
        const filtro = m[1]?.trim();
        const semFiltro = !filtro || filtro === '*' || filtro === 'todos';
        const emails = semFiltro
          ? await getRecentEmails(undefined, 10, true)
          : await getRecentEmails(filtro);
        return `\n\n${emails}`;
      },
    },
    {
      name: 'ADICIONAR_KEYWORD_EMAIL',
      regex: /\[ADICIONAR_KEYWORD_EMAIL:\s*([^\]]+)\]/i,
      async handle(m) {
        const res = await addEmailKeyword(m[1].trim());
        return `\n\n${res}`;
      },
    },
    {
      name: 'REMOVER_KEYWORD_EMAIL',
      regex: /\[REMOVER_KEYWORD_EMAIL:\s*([^\]]+)\]/i,
      async handle(m) {
        const res = await removeEmailKeyword(m[1].trim());
        return `\n\n${res}`;
      },
    },
    {
      name: 'ATUALIZAR_META',
      regex: /\[ATUALIZAR_META:\s*([^|]+)\|\s*(\d+)(?:\|\s*([^\]]+))?\]/i,
      async handle(m, { userId }) {
        await updateGoalProgress(userId, m[1].trim(), parseInt(m[2]), m[3]?.trim());
        return null;
      },
    },
    {
      name: 'SALVAR_LUGAR',
      regex: /\[SALVAR_LUGAR:\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(\d+)\s*\|\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        const { error } = await supabase.from('favorite_places').upsert(
          { user_id: userId, name: m[1].trim(), lat: parseFloat(m[2]), lng: parseFloat(m[3]), radius_meters: parseInt(m[4]), category: m[5].trim() },
          { onConflict: 'user_id,name' }
        );
        if (error) console.error('[gatilho:SALVAR_LUGAR]', error.message);
        return null;
      },
    },
    {
      name: 'REMOVER_LUGAR',
      regex: /\[REMOVER_LUGAR:\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        await supabase.from('favorite_places').delete()
          .eq('user_id', userId).ilike('name', m[1].trim());
        return null;
      },
    },
    {
      name: 'ADICIONAR_ITEM_LISTA',
      regex: /\[ADICIONAR_ITEM_LISTA:\s*([^|]+)\|\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        const placeId = await getPlaceId(userId, m[2]);
        if (placeId) {
          await supabase.from('shopping_items').upsert(
            { user_id: userId, item: m[1].trim(), place_id: placeId, done: false },
            { onConflict: 'user_id,item,place_id' }
          );
        }
        return null;
      },
    },
    {
      name: 'REMOVER_ITEM_LISTA',
      regex: /\[REMOVER_ITEM_LISTA:\s*([^|]+)\|\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        const placeId = await getPlaceId(userId, m[2]);
        if (placeId) {
          await supabase.from('shopping_items').delete()
            .eq('user_id', userId).ilike('item', m[1].trim()).eq('place_id', placeId);
        }
        return null;
      },
    },
    {
      name: 'MARCAR_FEITO',
      regex: /\[MARCAR_FEITO:\s*([^|]+)\|\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        const placeId = await getPlaceId(userId, m[2]);
        if (placeId) {
          await supabase.from('shopping_items').update({ done: true })
            .eq('user_id', userId).ilike('item', m[1].trim()).eq('place_id', placeId);
        }
        return null;
      },
    },
    {
      name: 'VER_LISTA',
      regex: /\[VER_LISTA:\s*([^\]]+)\]/i,
      async handle(m, { userId }) {
        const placeId = await getPlaceId(userId, m[1]);
        if (!placeId) return null;
        const { data } = await supabase.from('shopping_items')
          .select('item, done').eq('user_id', userId).eq('place_id', placeId).order('done');
        if (!data?.length) return 'Lista vazia.';
        return data.map(i => `${i.done ? '✅' : '•'} ${i.item}`).join('\n');
      },
    },
  ];
  
  // ── função principal exportada ───────────────────────────────
  
  export async function processGatilhos(
    aiReply: string,
    ctx: GatilhoContext
  ): Promise<string> {
    let reply = aiReply;
  
    for (const handler of HANDLERS) {
      // SALVAR_EVENTO usa matchAll (pode ter múltiplos no reply)
      if (handler.name === 'SALVAR_EVENTO') {
        const matches = Array.from(reply.matchAll(handler.regex));
        for (const m of matches) {
          try {
            await handler.handle(m, ctx);
          } catch (e) {
            console.error(`[gatilho:${handler.name}]`, e);
          }
          reply = reply.replace(m[0], '').trim();
        }
        continue;
      }
  
      const m = reply.match(handler.regex);
      if (!m) continue;
  
      try {
        const append = await handler.handle(m, ctx);
        reply = reply.replace(m[0], '').trim();
        if (append) {
          reply = reply ? `${reply}${append}` : append.trim();
        }
      } catch (e) {
        console.error(`[gatilho:${handler.name}]`, e);
        // remove o gatilho do reply mesmo assim — não vaza para o usuário
        reply = reply.replace(m[0], '').trim();
      }
    }
  
    return reply;
  }