// app/api/geo-enter/route.ts
// V2.0.0 — Cooldown migrado do Supabase config para Redis (via GeoState)
//
// Chamado pelo app nativo quando o usuário entra numa zona de geofencing.
// Dispara push com itens pendentes da lista de compras.
//
// MUDANÇAS em relação à V1:
//   - verificarCooldown() e registrarCooldown() removidos
//   - Cooldown agora vive em GeoState.alertCooldowns (Redis, TTL 4h)
//   - verificarProximidade() do geo-resolver centraliza toda a lógica
//   - placeId agora pode ser resolvido via GPS direto (sem depender só do app)

import { NextResponse } from 'next/server';
import { sendPushNotification } from '@/lib/notifications/push';
import {
  verificarProximidade,
  updateGeoState,
} from '@/lib/geo-resolver';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { userId, lat, lng, placeId } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId é obrigatório' }, { status: 400 });
    }

    // Aceita tanto evento de zona (placeId) quanto ping de GPS (lat/lng).
    // Em ambos os casos passa pelo verificarProximidade que tem o cooldown correto.
    if (lat !== undefined && lng !== undefined) {
      // Atualiza o GeoState com a posição atual (pode ser cache hit se dentro do raio)
      await updateGeoState(String(userId), lat, lng);
    }

    // Caso o app envie apenas placeId sem coords, buscamos o GeoState atual
    // e verificamos a proximidade com base nele
    const { getGeoState } = await import('@/lib/geo-resolver');
    const geoState = await getGeoState(String(userId));

    if (!geoState) {
      return NextResponse.json({ triggered: false, reason: 'no_location_state' });
    }

    // verificarProximidade cuida do raio + cooldown + busca de itens
    const resultado = await verificarProximidade(
      String(userId),
      geoState.lat,
      geoState.lng
    );

    if (!resultado.temAlerta) {
      return NextResponse.json({
        triggered: false,
        reason: resultado.mensagem || 'no_items_or_cooldown',
      });
    }

    // Envia push
    await sendPushNotification(Number(userId), `🛒 ${resultado.mensagem}`);

    console.log(
      `[Geo Enter] Push enviado para ${userId} — ${resultado.itens?.length} item(s) em ${resultado.placeName}`
    );

    return NextResponse.json({
      triggered: true,
      items:     resultado.itens?.length ?? 0,
      place:     resultado.placeName,
    });

  } catch (error: any) {
    console.error('[Geo Enter] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}