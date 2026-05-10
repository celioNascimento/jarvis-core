// app/api/geo-enter/route.ts
//
// Substitui o /api/location-ping.
// Recebe o evento de entrada numa zona e dispara push se houver itens pendentes.
// Tem cooldown de 2h por usuário/lugar para evitar spam.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { sendPushNotification } from '@/lib/notifications/push';

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 horas

async function verificarCooldown(userId: string, placeId: string): Promise<boolean> {
  const key = `geo_alert_${userId}_${placeId}`;
  const { data } = await supabase
    .schema('jarvis')
    .from('config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (!data?.value) return false;
  return Date.now() - parseInt(data.value) < COOLDOWN_MS;
}

async function registrarCooldown(userId: string, placeId: string): Promise<void> {
  const key = `geo_alert_${userId}_${placeId}`;
  await supabase
    .schema('jarvis')
    .from('config')
    .upsert({ key, value: String(Date.now()) }, { onConflict: 'key' });
}

export async function POST(request: Request) {
  try {
    const { userId, placeId } = await request.json();

    if (!userId || !placeId) {
      return NextResponse.json({ error: 'userId e placeId são obrigatórios' }, { status: 400 });
    }

    console.log(`[Geo Enter] Usuário ${userId} entrou na zona ${placeId}`);

    // 1. Verifica cooldown — evita notificar toda vez que o usuário passa pelo lugar
    const emCooldown = await verificarCooldown(userId, placeId);
    if (emCooldown) {
      console.log(`[Geo Enter] Cooldown ativo para ${userId}/${placeId}. Ignorando.`);
      return NextResponse.json({ triggered: false, reason: 'cooldown' });
    }

    // 2. Busca o nome do lugar
    const { data: lugar, error: lugarError } = await supabase
      .schema('jarvis')
      .from('favorite_places')
      .select('name')
      .eq('id', placeId)
      .eq('user_id', userId)
      .maybeSingle();

    if (lugarError || !lugar) {
      console.warn(`[Geo Enter] Lugar ${placeId} não encontrado para usuário ${userId}`);
      return NextResponse.json({ triggered: false, reason: 'place_not_found' });
    }

    // 3. Busca itens pendentes vinculados a este lugar
    const { data: itens, error: itensError } = await supabase
      .schema('jarvis')
      .from('shopping_items')
      .select('item')
      .eq('user_id', userId)
      .eq('place_id', placeId)
      .eq('done', false)
      .eq('archived', false);

    if (itensError) throw itensError;

    if (!itens?.length) {
      console.log(`[Geo Enter] Nenhum item pendente em ${lugar.name} para ${userId}`);
      return NextResponse.json({ triggered: false, reason: 'no_items' });
    }

    // 4. Registra cooldown antes de notificar
    await registrarCooldown(userId, placeId);

    // 5. Monta e envia o push
    const listaItens = itens.map(i => i.item).join(', ');
    const mensagem = `🛒 Você está perto de ${lugar.name}! Lembre de pegar: ${listaItens}`;

    await sendPushNotification(Number(userId), mensagem);

    console.log(`[Geo Enter] Push enviado para ${userId} — ${itens.length} item(s) em ${lugar.name}`);

    return NextResponse.json({ triggered: true, items: itens.length, place: lugar.name });

  } catch (error: any) {
    console.error('[Geo Enter] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}