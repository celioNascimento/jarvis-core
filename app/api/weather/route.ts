// app/api/weather/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo';

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return NextResponse.json({ error: 'Token inválido' }, { status: 401 });

    // Busca numeric ID — a chave usa numericUserId, não o UUID
    const { data: userRecord } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const numericUserId = userRecord ? String(userRecord.id) : user.id;

    const { data: locData } = await supabase
      .from('config')
      .select('value')
      .eq('key', `last_location_${numericUserId}`)
      .single();

    let lat = -23.27, lon = -51.20, locationLabel = 'Londrina - Vista Bela';
    if (locData?.value) {
      const { latitude, longitude, endereco } = JSON.parse(locData.value);
      lat = latitude;
      lon = longitude;
      locationLabel = endereco || 'Localização atual';
    }

    const weather = await fetchWeather(lat, lon);
    return NextResponse.json({ weather, locationLabel });
  } catch (error: any) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}