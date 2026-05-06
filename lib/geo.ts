// lib/geo.ts — V3.0.0 (God RPC Integration + Haversine Fast-Path)
import { supabase } from '@/lib/jarvis';

const MAX_CACHE_SIZE = 100;
const CACHE_TTL = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 6 * 60 * 1000;

type CacheEntry = { value: string; timestamp: number };
const geoCache = new Map<string, CacheEntry>();

// ─── HELPER: CÁLCULO DE DISTÂNCIA (HAVERSINE) ────────────────────────────────
function calcularDistancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distância em km
}

// 🔁 Garbage collection (executa apenas no servidor)
if (typeof window === 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of geoCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) geoCache.delete(key);
    }
  }, CLEANUP_INTERVAL);
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Verifica proximidade usando injeção de dados da God RPC
 */
export async function checkProximidade(
  lat: number, 
  lng: number,
  numericUserId?: string,
  injectedLocations?: any[] // ← DADOS DA GOD RPC
): Promise<string> {
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return `[LOCALIZAÇÃO]\nCoordenadas inválidas.`;

  // === 1. CACHE HIT ===
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.value;

  // === 2. FAST-PATH: VERIFICAÇÃO DE LOCAIS SALVOS (RPC) ===
  // Se estivermos a menos de 100m de um local conhecido, retornamos IMEDIATAMENTE.
  if (injectedLocations && injectedLocations.length > 0) {
    for (const loc of injectedLocations) {
      const distancia = calcularDistancia(lat, lng, loc.latitude, loc.longitude);
      if (distancia < 0.1) { // 100 metros
        const res = `[LOCALIZAÇÃO]\n📍 Você está em: ${loc.name || 'Local Salvo'}`;
        geoCache.set(cacheKey, { value: res, timestamp: Date.now() });
        return res;
      }
    }
  }

  // === 3. BUSCA EXTERNA (GOOGLE/NOMINATIM) ===
  // Se chegou aqui, é um lugar novo.
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    let locationLabel = '';
    let cidade = '';
    let estado = '';

    if (apiKey?.trim()) {
      const geoRes = await fetchWithTimeout(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`,
        {}, 4000 // Timeout reduzido para 4s
      );
      const geoData = await geoRes.json();

      if (geoData.status === 'OK' && geoData.results?.[0]) {
        const comps = geoData.results[0].address_components;
        const rua = comps.find((c: any) => c.types.includes('route'))?.long_name;
        cidade = comps.find((c: any) => c.types.includes('locality'))?.long_name || '';
        estado = comps.find((c: any) => c.types.includes('administrative_area_level_1'))?.short_name || '';
        
        locationLabel = rua ? `${rua}, ${cidade}` : cidade;
      }
    }

    // Fallback silencioso (sem Nominatim se possível, ou com timeout agressivo)
    if (!locationLabel) {
       locationLabel = `Coordenadas ${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    }

    const contextString = `[LOCALIZAÇÃO]\n📍 ${locationLabel}${estado ? `, ${estado}` : ''}`;

    // === 4. UPSERT NO BANCO (SILENCIOSO) ===
    if (numericUserId && cidade) {
      const sanitizedState = (estado || '').substring(0, 2).toUpperCase();
      supabase.schema('jarvis').from('user_locations').upsert({
        user_id: numericUserId,
        latitude: lat,
        longitude: lng,
        city: cidade,
        state: sanitizedState,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'user_id' }).then(({error}) => error && console.error('[Geo DB Error]', error.message));
    }

    geoCache.set(cacheKey, { value: contextString, timestamp: Date.now() });
    return contextString;

  } catch (error) {
    return `[LOCALIZAÇÃO]\n📍 Em movimento (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
  }
}
