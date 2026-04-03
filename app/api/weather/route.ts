// app/api/weather/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { fetchWeather } from '@/lib/openmeteo';

export async function GET(req: NextRequest) {
  try {
    // 1. Obter token do header Authorization
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }
    const token = authHeader.split(' ')[1];

    // 2. Criar cliente Supabase com o token para obter o usuário
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: () => cookieStore }
    );
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
    }

    // 3. Buscar última localização do usuário na tabela config
    const { data: locData, error: locError } = await supabase
      .from('config')
      .select('value')
      .eq('key', `last_location_${user.id}`)
      .single();

    let lat: number, lon: number, locationLabel = 'Localização padrão';
    if (locData?.value && !locError) {
      const { latitude, longitude, endereco } = JSON.parse(locData.value);
      lat = latitude;
      lon = longitude;
      locationLabel = endereco || 'Localização atual';
    } else {
      // Fallback: Londrina - Vista Bela
      lat = -23.27;
      lon = -51.20;
      locationLabel = 'Londrina - Vista Bela';
    }

    // 4. Buscar clima real
    const weather = await fetchWeather(lat, lon);

    return NextResponse.json({ weather, locationLabel });
  } catch (error: any) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}