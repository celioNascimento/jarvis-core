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
    const contactEmail = process.env.NOMINATIM_CONTACT_EMAIL?.trim();
    const userAgent = contactEmail
      ? `JarvisApp/1.0 (+${contactEmail})`
      : 'JarvisApp/1.0';

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR`;
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
    });
    if (!res.ok) return 'Localização desconhecida';
    const data = await res.json();
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
    // ── Auth ──────────────────────────────────────────────────────────────────
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

    // ── Buscar numericUserId ──────────────────────────────────────────────────
    const { data: userRecord } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    const numericUserId = userRecord ? String(userRecord.id) : user.id;

    // ── Coordenadas: prioridade GPS do app → banco → fallback ─────────────────
    let lat = -23.27;
    let lon = -51.20;
    let locationLabel = 'Londrina (fallback)';

    const { searchParams } = new URL(req.url);
    const latParam = searchParams.get('lat');
    const lonParam = searchParams.get('lon');

    if (latParam && lonParam) {
      // ✅ Prioridade 1: coordenadas frescas enviadas pelo app via GPS real
      const parsedLat = parseFloat(latParam);
      const parsedLon = parseFloat(lonParam);

      if (
        !isNaN(parsedLat) && !isNaN(parsedLon) &&
        parsedLat >= -90 && parsedLat <= 90 &&
        parsedLon >= -180 && parsedLon <= 180
      ) {
        lat = parsedLat;
        lon = parsedLon;
        locationLabel = await reverseGeocode(lat, lon);
        console.log(`[Weather] GPS do app: ${lat}, ${lon} → ${locationLabel}`);
      } else {
        console.warn('[Weather] Query params lat/lon inválidos:', latParam, lonParam);
      }
    } else {
      // Prioridade 2: localização salva no banco (enviada pelo Telegram/Jarvis)
      const { data: locData } = await supabase
        .from('config')
        .select('value')
        .eq('key', `last_location_${numericUserId}`)
        .maybeSingle();

      if (locData?.value) {
        try {
          const { latitude, longitude, endereco } = JSON.parse(locData.value);
          lat = latitude;
          lon = longitude;

          const isInvalid =
            !endereco ||
            endereco.includes('não disponível') ||
            endereco.includes('Configuração pendente');

          if (isInvalid) {
            console.log('[Weather] Endereço salvo inválido, refazendo geocodificação...');
            locationLabel = await reverseGeocode(lat, lon);
          } else {
            locationLabel = endereco;
          }
          console.log(`[Weather] Localização do banco: ${lat}, ${lon} → ${locationLabel}`);
        } catch (e) {
          console.warn('[Weather] Erro ao parsear localização salva:', e);
          // Mantém fallback já definido acima
        }
      } else {
        console.log('[Weather] Nenhuma localização salva — usando fallback Londrina');
      }
    }

    const weather = await fetchWeather(lat, lon);
    return NextResponse.json({ weather, locationLabel });
  } catch (error: any) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}