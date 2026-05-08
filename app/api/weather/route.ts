// app/api/weather/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo';

// ── Auth ──────────────────────────────────────────────────────────────────────
function createAuthenticatedClient(token: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}

// ── Geocodificação reversa (Nominatim / OpenStreetMap) ────────────────────────
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const contactEmail = process.env.NOMINATIM_CONTACT_EMAIL?.trim();
    const userAgent = contactEmail
      ? `JarvisApp/1.0 (+${contactEmail})`
      : 'JarvisApp/1.0';

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR`;
    const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) return 'Localização desconhecida';

    const data = await res.json();
    const addr = data.address ?? {};

    // Bairro: tenta os campos em ordem de precisão
    const neighbourhood =
      addr.neighbourhood ||
      addr.suburb ||
      addr.city_district ||
      addr.borough ||
      null;

    const city =
      addr.city ||
      addr.town ||
      addr.village ||
      null;

    // Monta: "Vila Madalena, São Paulo" ou "São Paulo, SP" como fallback
    if (neighbourhood && city) return `${neighbourhood}, ${city}`;
    if (neighbourhood && addr.state) return `${neighbourhood}, ${addr.state}`;
    if (city && addr.state) return `${city}, ${addr.state}`;
    if (city) return city;

    return data.display_name?.split(',')[0] ?? 'Localização desconhecida';
  } catch (e) {
    console.warn('[ReverseGeocode] Erro:', e);
    return 'Localização desconhecida';
  }
}

// ── Validação de coordenadas ──────────────────────────────────────────────────
function parseCoords(
  latRaw: string | null,
  lonRaw: string | null
): { lat: number; lon: number } | null {
  if (!latRaw || !lonRaw) return null;
  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (
    isNaN(lat) || isNaN(lon) ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) {
    return null;
  }
  return { lat, lon };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    // Auth
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const userSupabase = createAuthenticatedClient(token);
    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();
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

    // Coordenadas: prioridade 1 → GPS do app, 2 → banco, 3 → fallback
    let lat = -23.27;
    let lon = -51.2;
    let locationLabel = 'Londrina (fallback)';

    const { searchParams } = new URL(req.url);
    const gpsCoords = parseCoords(
      searchParams.get('lat'),
      searchParams.get('lon')
    );

    if (gpsCoords) {
      // ✅ Prioridade 1: GPS real enviado pelo app
      lat = gpsCoords.lat;
      lon = gpsCoords.lon;
      locationLabel = await reverseGeocode(lat, lon);
      console.log(`[Weather] GPS do app: ${lat}, ${lon} → ${locationLabel}`);
    } else {
      // Prioridade 2: localização salva no banco
      const { data: locData } = await supabase
        .from('config')
        .select('value')
        .eq('key', `last_location_${numericUserId}`)
        .limit(1)
        .maybeSingle();

      if (locData?.value) {
        try {
          const parsed = JSON.parse(locData.value);
          const savedCoords = parseCoords(
            String(parsed.latitude),
            String(parsed.longitude)
          );

          if (savedCoords) {
            lat = savedCoords.lat;
            lon = savedCoords.lon;

            const enderecoInvalido =
  !parsed.endereco ||
  parsed.endereco.includes('não disponível') ||
  parsed.endereco.includes('Configuração pendente') ||
  !parsed.endereco.includes(','); // ← sem vírgula = sem bairro, refaz

            locationLabel = enderecoInvalido
              ? await reverseGeocode(lat, lon)
              : parsed.endereco;

            console.log(
              `[Weather] Localização do banco: ${lat}, ${lon} → ${locationLabel}`
            );
          }
        } catch (e) {
          console.warn('[Weather] Erro ao parsear localização salva:', e);
        }
      } else {
        console.log('[Weather] Nenhuma localização salva — usando fallback Londrina');
      }
    }

    const weather = await fetchWeather(lat, lon);
    return NextResponse.json({ weather, locationLabel });
  } catch (error: unknown) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}