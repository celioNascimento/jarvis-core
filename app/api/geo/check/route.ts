import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { sendPushNotification } from '@/lib/notifications/push';

// Distância haversine em metros
function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export async function POST(req: Request) {
  const { userId, lat, lng } = await req.json();

  if (!userId || lat === undefined || lng === undefined) {
    return NextResponse.json({ error: 'userId, lat, lng são obrigatórios' }, { status: 400 });
  }

  const numericUserId = parseInt(userId, 10);
  if (isNaN(numericUserId)) {
    return NextResponse.json({ error: 'userId inválido' }, { status: 400 });
  }

  // Buscar lembretes do tipo location pendentes
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('user_id', numericUserId)
    .eq('type', 'location')
    .eq('status', 'pending');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let triggered = 0;
  for (const reminder of reminders) {
    // Buscar coordenadas do local em favorite_places
    const { data: place, error: placeError } = await supabase
      .from('favorite_places')
      .select('lat, lng, radius_meters')
      .eq('user_id', userId)
      .eq('name', reminder.location_trigger)
      .single();

    if (placeError || !place) {
      console.error(`[Geo] Local ${reminder.location_trigger} não encontrado para usuário ${userId}`);
      continue;
    }

    const dist = distance(lat, lng, place.lat, place.lng);
    const radius = place.radius_meters || 150;

    if (dist <= radius) {
      // Disparar lembrete
      await sendPushNotification(numericUserId, reminder.title);
      await supabase
        .from('reminders')
        .update({ status: 'triggered', updated_at: new Date().toISOString() })
        .eq('id', reminder.id);
      triggered++;
    }
  }

  return NextResponse.json({ triggered });
}