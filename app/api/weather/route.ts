// app/api/weather/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo';

// Cria um cliente Supabase autenticado com o token do usuário
function createAuthenticatedClient(token: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}

// Geocodificação reversa gratuita via Nominatim (OpenStreetMap)
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JarvisApp/1.0' },
    });
    if (!res.ok) return 'Localização desconhecida';
    const data = await res.json();
    // Tenta extrair cidade, estado ou endereço formatado
    const city = data.address?.city || data.address?.town || data.address?.village;
    const state = data.address?.state;
    if (city && state) return `${city}, ${state}`;
    if (city) return city;
    return data.display_name?.split(',')[0] || 'Localização desconhecida';
  } catch (e) {
    console.warn('[ReverseGeocode] Erro:', e);
    return 'Localização desconhecida';
  }
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const userSupabase = createAuthenticatedClient(token);
    const { data: { user }, error: userError } = await userSupabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
    }

    // Buscar numericUserId
    const { data: userRecord } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    const numericUserId = userRecord ? String(userRecord.id) : user.id;

    // Buscar localização salva
    const { data: locData } = await supabase
      .from('config')
      .select('value')
      .eq('key', `last_location_${numericUserId}`)
      .maybeSingle();

    let lat = -23.27;
    let lon = -51.20;
    let locationLabel = 'Londrina - Vista Bela (fallback)';

    if (locData?.value) {
      try {
        const { latitude, longitude, endereco } = JSON.parse(locData.value);
        lat = latitude;
        lon = longitude;

        // Verifica se o endereço salvo é inválido (contém mensagem de erro)
        const isInvalid = !endereco || endereco.includes('não disponível') || endereco.includes('Configuração pendente');
        if (isInvalid) {
          console.log('[Weather] Endereço salvo inválido, refazendo geocodificação...');
          const freshAddress = await reverseGeocode(lat, lon);
          locationLabel = freshAddress;
        } else {
          locationLabel = endereco;
        }
      } catch (e) {
        console.warn('[Weather] Erro ao parsear localização:', e);
      }
    }

    const weather = await fetchWeather(lat, lon);
    return NextResponse.json({ weather, locationLabel });
  } catch (error: any) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}