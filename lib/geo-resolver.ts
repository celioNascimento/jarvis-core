/**
 * geo-resolver.ts — V13.0.0 (GEO STATE MANAGER)
 *
 * Fonte única de verdade para localização em todo o sistema.
 *
 * ARQUITETURA:
 *   updateGeoState(userId, lat, lng)  → única função que chama Nominatim
 *   getGeoState(userId)               → leitura instantânea do Redis (qualquer consumidor)
 *   shouldSkipWeather(userId, lat, lng) → debounce de clima (500m / 10 min)
 *   verificarProximidade(userId, lat, lng) → radar de compras (raio + cooldown no state)
 *
 * REDIS KEYS:
 *   geo:{userId}      TTL 4h  — posição + label + cooldowns de alerta
 *   weather:{userId}  TTL 10m — dados de clima separados (ritmo diferente)
 *
 * REGRAS:
 *   - Nominatim só é chamado quando o GPS sai de um raio de GEO_SKIP_RADIUS_M
 *   - haversineKm é a única implementação de distância no projeto
 *   - Cooldown de alerta (2h) vive dentro do GeoState, não no Supabase
 *   - Nenhum outro arquivo deve chamar Nominatim diretamente
 */

import { Redis } from '@upstash/redis';
import { supabase } from '@/lib/jarvis';

// ─── Redis ────────────────────────────────────────────────────────────────────

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Constantes ───────────────────────────────────────────────────────────────

const GEO_SKIP_RADIUS_M   = 200;    // raio em metros — dentro disso, não chama Nominatim
const WEATHER_SKIP_RADIUS_M = 500;  // clima só atualiza se sair desse raio
const GEO_TTL_SECONDS     = 4 * 60 * 60;   // 4h
const WEATHER_TTL_SECONDS = 10 * 60;        // 10 min
const ALERT_COOLDOWN_MS   = 2 * 60 * 60 * 1000; // 2h
const NOMINATIM_TIMEOUT_MS = 5000;
const NOMINATIM_MAX_DRIFT_KM = 15;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface GeoState {
  lat: number;
  lng: number;
  label: string;
  city: string;
  state: string;
  country: string;
  resolvedAt: number;                        // timestamp da última resolução Nominatim
  alertCooldowns: Record<string, number>;    // placeId → timestamp do último alerta
}

export interface WeatherCache {
  lat: number;
  lng: number;
  locationLabel: string;
  weather: any;                              // estrutura do open-meteo
  cachedAt: number;
}

// Mantido para compatibilidade com request-context e prompt-assembler
export interface UserLocation {
  lat: number | string;
  lng: number | string;
  label?: string;
  city?: string;
  state?: string;
  country?: string;
}

// ─── Haversine — única implementação no projeto ───────────────────────────────

export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function haversineMetros(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

// ─── Redis keys ───────────────────────────────────────────────────────────────

function geoKey(userId: string): string     { return `geo:${userId}`; }
function weatherKey(userId: string): string { return `weather:${userId}`; }

// ─── Nominatim ────────────────────────────────────────────────────────────────

interface NominatimAddress {
  road?: string;
  suburb?: string;
  neighbourhood?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
}

interface NominatimResponse {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: NominatimAddress;
  error?: string;
}

function coordLabel(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'O' : 'L'}`;
}

function buildHumanLabel(address: NominatimAddress, displayName: string): string {
  const parts: string[] = [];
  const road   = address.road;
  const suburb = address.suburb || address.neighbourhood;
  const city   = address.city || address.town || address.village ||
                 address.municipality || address.county;
  if (road)   parts.push(road);
  if (suburb) parts.push(suburb);
  if (city)   parts.push(city);
  return parts.length >= 2 ? parts.join(', ') : displayName;
}

async function callNominatim(lat: number, lng: number): Promise<{
  label: string; city: string; state: string; country: string;
} | null> {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', lat.toString());
    url.searchParams.set('lon', lng.toString());
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('accept-language', 'pt-BR');

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'JarvisCore/1.3 (contato@procuroquemfaca.com.br)' },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[Geo] Nominatim HTTP ${res.status}`);
      return null;
    }

    const geo: NominatimResponse = await res.json();
    if (geo.error) {
      console.warn(`[Geo] Nominatim error: ${geo.error}`);
      return null;
    }

    // BBOX guard — rejeita resultado com drift excessivo
    const geoLat = parseFloat(geo.lat ?? '0');
    const geoLon = parseFloat(geo.lon ?? '0');
    const drift  = haversineKm(lat, lng, geoLat, geoLon);

    if (drift > NOMINATIM_MAX_DRIFT_KM) {
      console.warn(`[Geo] DRIFT ${drift.toFixed(1)}km — resultado descartado: "${geo.display_name}"`);
      return null;
    }

    const address = geo.address ?? {};
    const city    = address.city || address.town || address.village ||
                    address.municipality || address.county || '';

    return {
      label:   buildHumanLabel(address, geo.display_name ?? coordLabel(lat, lng)),
      city,
      state:   address.state   || '',
      country: address.country || '',
    };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.warn('[Geo] Nominatim timeout');
    } else {
      console.error('[Geo] Nominatim erro:', err?.message);
    }
    return null;
  }
}

// ─── GeoStateManager — API pública ───────────────────────────────────────────

/**
 * Lê o GeoState do Redis. Retorna null se não houver estado salvo.
 * Chamado por qualquer consumidor que precise da localização atual.
 */
export async function getGeoState(userId: string): Promise<GeoState | null> {
  try {
    const raw = await redis.get<GeoState>(geoKey(userId));
    return raw ?? null;
  } catch {
    return null;
  }
}

/**
 * Atualiza o GeoState a partir de coordenadas brutas.
 *
 * Se o novo GPS estiver dentro de GEO_SKIP_RADIUS_M do estado anterior,
 * retorna o estado em cache sem chamar Nominatim (modo preguiça).
 *
 * É a ÚNICA função que chama Nominatim em todo o projeto.
 */
export async function updateGeoState(
  userId: string,
  lat: number,
  lng: number
): Promise<GeoState> {
  // 1. Tenta ler estado anterior
  const cached = await getGeoState(userId);

  if (cached) {
    const distM = haversineMetros(lat, lng, cached.lat, cached.lng);
    if (distM < GEO_SKIP_RADIUS_M) {
      console.info(`[Geo] Cache hit — ${distM.toFixed(0)}m dentro do raio, Nominatim ignorado`);
      return cached;
    }
  }

  // 2. Fora do raio — precisa resolver
  const resolved = await callNominatim(lat, lng);

  const newState: GeoState = {
    lat,
    lng,
    label:   resolved?.label   ?? coordLabel(lat, lng),
    city:    resolved?.city    ?? '',
    state:   resolved?.state   ?? '',
    country: resolved?.country ?? '',
    resolvedAt:     Date.now(),
    alertCooldowns: cached?.alertCooldowns ?? {},   // preserva cooldowns
  };

  try {
    await redis.set(geoKey(userId), newState, { ex: GEO_TTL_SECONDS });
    console.info(`[Geo] State atualizado: (${lat}, ${lng}) → "${newState.label}"`);
  } catch (err) {
    console.error('[Geo] Falha ao salvar state no Redis:', err);
  }

  return newState;
}

// ─── shouldSkipWeather ────────────────────────────────────────────────────────

/**
 * Retorna true se o cache de clima ainda é válido para esse GPS.
 * Condição: dentro de WEATHER_SKIP_RADIUS_M E dentro do TTL de 10 min.
 */
export async function shouldSkipWeather(
  userId: string,
  lat: number,
  lng: number
): Promise<{ skip: boolean; cached: WeatherCache | null }> {
  try {
    const cached = await redis.get<WeatherCache>(weatherKey(userId));
    if (!cached) return { skip: false, cached: null };

    const distM = haversineMetros(lat, lng, cached.lat, cached.lng);
    const ageMs = Date.now() - cached.cachedAt;

    const skip = distM < WEATHER_SKIP_RADIUS_M && ageMs < WEATHER_TTL_SECONDS * 1000;
    if (skip) {
      console.info(`[Weather] Cache hit — ${distM.toFixed(0)}m, ${(ageMs / 1000).toFixed(0)}s atrás`);
    }
    return { skip, cached: skip ? cached : null };
  } catch {
    return { skip: false, cached: null };
  }
}

/**
 * Salva o resultado do clima no Redis com TTL de 10 min.
 */
export async function saveWeatherCache(
  userId: string,
  lat: number,
  lng: number,
  locationLabel: string,
  weather: any
): Promise<void> {
  try {
    const payload: WeatherCache = { lat, lng, locationLabel, weather, cachedAt: Date.now() };
    await redis.set(weatherKey(userId), payload, { ex: WEATHER_TTL_SECONDS });
  } catch (err) {
    console.error('[Weather] Falha ao salvar cache:', err);
  }
}

// ─── verificarProximidade ─────────────────────────────────────────────────────

export interface ProximidadeResult {
  temAlerta: boolean;
  mensagem: string;
  placeId?: string;
  placeName?: string;
  itens?: string[];
}

/**
 * Radar de compras — verifica se o usuário está perto de um lugar favorito
 * com itens pendentes na lista de compras.
 *
 * Cooldown de 2h por lugar é armazenado dentro do GeoState (Redis),
 * não mais na tabela config do Supabase.
 */
export async function verificarProximidade(
  userId: string,
  lat: number,
  lng: number
): Promise<ProximidadeResult> {
  try {
    const { data: lugares } = await supabase
      .from('favorite_places')
      .select('id, name, lat, lng, radius_meters')
      .eq('user_id', userId);

    if (!lugares?.length) return { temAlerta: false, mensagem: '' };

    // Lê estado atual para checar cooldowns
    const geoState = await getGeoState(userId);
    const cooldowns = geoState?.alertCooldowns ?? {};

    for (const lugar of lugares) {
      const distM = haversineMetros(lat, lng, lugar.lat, lugar.lng);
      const raio  = lugar.radius_meters ?? 200;

      if (distM > raio) continue;

      // Cooldown — dentro das 2h para esse lugar?
      const ultimoAlerta = cooldowns[lugar.id] ?? 0;
      if (Date.now() - ultimoAlerta < ALERT_COOLDOWN_MS) continue;

      // Busca itens pendentes
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item')
        .eq('place_id', lugar.id)
        .eq('done', false)
        .eq('archived', false);

      if (!itens?.length) continue;

      // Registra cooldown dentro do GeoState
      const novosCooldowns = { ...cooldowns, [lugar.id]: Date.now() };

      if (geoState) {
        const updatedState: GeoState = { ...geoState, alertCooldowns: novosCooldowns };
        await redis.set(geoKey(userId), updatedState, { ex: GEO_TTL_SECONDS }).catch(() => {});
      }

      const listaItens = itens.map(i => i.item);

      return {
        temAlerta: true,
        mensagem: `Você está perto de ${lugar.name}. Itens pendentes: ${listaItens.join(', ')}.`,
        placeId:  lugar.id,
        placeName: lugar.name,
        itens:    listaItens,
      };
    }

    return { temAlerta: false, mensagem: '' };
  } catch (err) {
    console.error('[Geo] verificarProximidade erro:', err);
    return { temAlerta: false, mensagem: '' };
  }
}

// ─── Adaptadores de compatibilidade ──────────────────────────────────────────
// Mantidos para não quebrar request-context e prompt-assembler durante migração.

/**
 * @deprecated Use updateGeoState() + getGeoState() em código novo.
 * Mantido para compatibilidade com request-context.ts.
 */
export async function resolveLocation(
  raw: UserLocation | null
): Promise<UserLocation | null> {
  if (!raw) return null;

  const lat = typeof raw.lat === 'string' ? parseFloat(raw.lat) : raw.lat;
  const lng = typeof raw.lng === 'string' ? parseFloat(raw.lng) : raw.lng;

  if (!isFinite(lat) || !isFinite(lng)) return raw;
  if (raw.label && !/^-?\d/.test(raw.label) && raw.city) return raw;

  // Delega para o GeoStateManager — sem userId nesse contexto, usa cache temporário
  const resolved = await callNominatim(lat, lng);
  if (!resolved) return { ...raw, lat, lng, label: coordLabel(lat, lng) };

  return {
    ...raw,
    lat,
    lng,
    label:   resolved.label,
    city:    resolved.city,
    state:   resolved.state,
    country: resolved.country,
  };
}

/**
 * @deprecated Use getGeoState() em código novo.
 */
export function normalizeLocationForModules(
  loc: UserLocation | null,
): { latitude: number; longitude: number; label?: string; city?: string; state?: string } | null {
  if (!loc) return null;
  const lat = typeof loc.lat === 'string' ? parseFloat(loc.lat) : loc.lat;
  const lng = typeof loc.lng === 'string' ? parseFloat(loc.lng) : loc.lng;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { latitude: lat, longitude: lng, label: loc.label, city: loc.city, state: loc.state };
}

/**
 * Formata o GeoState (ou UserLocation legado) em string para o system prompt.
 */
export function formatLocationForPrompt(loc: UserLocation | GeoState | null): string {
  if (!loc) return 'Localização não disponível';

  const lat = 'latitude' in loc ? (loc as any).latitude : (typeof loc.lat === 'string' ? parseFloat(loc.lat) : loc.lat);
  const lng = 'longitude' in loc ? (loc as any).longitude : (typeof loc.lng === 'string' ? parseFloat(loc.lng) : loc.lng);

  if (!isFinite(lat) || !isFinite(lng)) return 'Localização inválida';

  const parts: string[] = [];
  if (loc.label && !/^-?\d/.test(loc.label)) parts.push(loc.label);
  if (loc.city && !loc.label?.includes(loc.city)) parts.push(loc.city);
  if (loc.state) parts.push(loc.state);
  if (loc.country) parts.push(loc.country);

  const address = parts.join(', ') || coordLabel(lat, lng);
  return `${address} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

/**
 * Gera bloco geo para injeção no system prompt.
 */
export function buildGeoBlock(loc: UserLocation | GeoState | null): string {
  if (!loc) return '';
  return `📍 Localização atual: ${formatLocationForPrompt(loc)}`;
}