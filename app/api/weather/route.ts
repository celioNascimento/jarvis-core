// app/api/weather/route.ts
// V2.0.0 — Cache Redis + geocode delegado ao GeoStateManager
//
// MUDANÇAS:
//   - reverseGeocode() própria removida — usa updateGeoState() do geo-resolver
//   - shouldSkipWeather() evita chamar open-meteo se posição/TTL ainda válidos
//   - saveWeatherCache() persiste resultado para próximas requisições

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/jarvis';
import { fetchWeather } from '@/lib/openmeteo';
import {
  updateGeoState,
  shouldSkipWeather,
  saveWeatherCache,
} from '@/lib/geo-resolver';

// ── Auth ──────────────────────────────────────────────────────────────────────

function createAuthenticatedClient(token: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
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
  ) return null;
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

    // Coordenadas — prioridade: GPS do app → banco → fallback Londrina
    const { searchParams } = new URL(req.url);
    const gpsCoords = parseCoords(searchParams.get('lat'), searchParams.get('lon'));

    let lat = -23.27;
    let lon = -51.2;

    if (gpsCoords) {
      lat = gpsCoords.lat;
      lon = gpsCoords.lon;
    } else {
      // Tenta última localização salva no banco (config table)
      const { data: locData } = await supabase
        .from('config')
        .select('value')
        .eq('key', `last_location_${numericUserId}`)
        .limit(1)
        .maybeSingle();

      if (locData?.value) {
        try {
          const parsed = JSON.parse(locData.value);
          const saved = parseCoords(String(parsed.latitude), String(parsed.longitude));
          if (saved) { lat = saved.lat; lon = saved.lon; }
        } catch { /* usa fallback */ }
      }
    }

    // ── Cache check — evita Nominatim + open-meteo se nada mudou ──────────────
    const { skip, cached } = await shouldSkipWeather(numericUserId, lat, lon);
    if (skip && cached) {
      console.log(`[Weather] Cache hit para ${numericUserId}`);
      return NextResponse.json({
        weather:       cached.weather,
        locationLabel: cached.locationLabel,
      });
    }

    // ── Resolve localização via GeoStateManager (sem chamar Nominatim extra) ──
    const geoState = await updateGeoState(numericUserId, lat, lon);
    const locationLabel = geoState.label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    console.log(`[Weather] Buscando clima para ${locationLabel} (${lat}, ${lon})`);

    // ── Busca clima ────────────────────────────────────────────────────────────
    const weather = await fetchWeather(lat, lon);

    // ── Salva cache ────────────────────────────────────────────────────────────
    await saveWeatherCache(numericUserId, lat, lon, locationLabel, weather);

    return NextResponse.json({ weather, locationLabel });

  } catch (error: unknown) {
    console.error('[API /weather]', error);
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}