import { Redis } from '@upstash/redis';
import { supabase } from '@/lib/jarvis';
import { haversineMetros, coordLabel } from './geo-math';
import { callNominatim } from './geo-nominatim';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const GEO_SKIP_RADIUS_M = 200;
const WEATHER_SKIP_RADIUS_M = 500;
const GEO_TTL_SECONDS = 4 * 60 * 60;
const WEATHER_TTL_SECONDS = 10 * 60;
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export interface GeoState {
  lat: number; lng: number; label: string; city: string; state: string; country: string;
  resolvedAt: number; alertCooldowns: Record<string, number>;
}
export interface WeatherCache { lat: number; lng: number; locationLabel: string; weather: any; cachedAt: number; }
export interface UserLocation { lat: number | string; lng: number | string; label?: string; city?: string; state?: string; country?: string; }

const geoKey = (uid: string) => `geo:${uid}`;
const weatherKey = (uid: string) => `weather:${uid}`;

export async function getGeoState(userId: string): Promise<GeoState | null> {
  return (await redis.get<GeoState>(geoKey(userId))) ?? null;
}

export async function updateGeoState(userId: string, lat: number, lng: number): Promise<GeoState> {
  const cached = await getGeoState(userId);
  if (cached) {
    const distM = haversineMetros(lat, lng, cached.lat, cached.lng);
    if (distM < GEO_SKIP_RADIUS_M) return cached;
  }

  const resolved = await callNominatim(lat, lng);
  const newState: GeoState = {
    lat, lng,
    label: resolved?.label ?? coordLabel(lat, lng),
    city: resolved?.city ?? '', state: resolved?.state ?? '', country: resolved?.country ?? '',
    resolvedAt: Date.now(), alertCooldowns: cached?.alertCooldowns ?? {},
  };

  await redis.set(geoKey(userId), newState, { ex: GEO_TTL_SECONDS }).catch(() => {});
  return newState;
}

export async function shouldSkipWeather(userId: string, lat: number, lng: number): Promise<{ skip: boolean; cached: WeatherCache | null }> {
  const cached = await redis.get<WeatherCache>(weatherKey(userId));
  if (!cached) return { skip: false, cached: null };

  const distM = haversineMetros(lat, lng, cached.lat, cached.lng);
  const ageMs = Date.now() - cached.cachedAt;
  const skip = distM < WEATHER_SKIP_RADIUS_M && ageMs < WEATHER_TTL_SECONDS * 1000;

  return { skip, cached: skip ? cached : null };
}

export async function saveWeatherCache(userId: string, lat: number, lng: number, locationLabel: string, weather: any): Promise<void> {
  const payload: WeatherCache = { lat, lng, locationLabel, weather, cachedAt: Date.now() };
  await redis.set(weatherKey(userId), payload, { ex: WEATHER_TTL_SECONDS }).catch(() => {});
}

export async function verificarProximidade(userId: string, lat: number, lng: number): Promise<any> {
  const { data: lugares } = await supabase.from('favorite_places').select('id, name, lat, lng, radius_meters').eq('user_id', userId);
  if (!lugares?.length) return { temAlerta: false, mensagem: '' };

  const geoState = await getGeoState(userId);
  const cooldowns = geoState?.alertCooldowns ?? {};

  for (const lugar of lugares) {
    const distM = haversineMetros(lat, lng, lugar.lat, lugar.lng);
    if (distM > (lugar.radius_meters ?? 200)) continue;
    if (Date.now() - (cooldowns[lugar.id] ?? 0) < ALERT_COOLDOWN_MS) continue;

    const { data: itens } = await supabase.from('shopping_items').select('item').eq('place_id', lugar.id).eq('done', false).eq('archived', false);
    if (!itens?.length) continue;

    const novosCooldowns = { ...cooldowns, [lugar.id]: Date.now() };
    if (geoState) {
      await redis.set(geoKey(userId), { ...geoState, alertCooldowns: novosCooldowns }, { ex: GEO_TTL_SECONDS }).catch(() => {});
    }

    const listaItens = itens.map(i => i.item);
    return {
      temAlerta: true,
      mensagem: `Você está perto de ${lugar.name}. Itens: ${listaItens.join(', ')}.`,
      placeId: lugar.id, placeName: lugar.name, itens: listaItens
    };
  }
  return { temAlerta: false, mensagem: '' };
}

// ─── Adaptadores Legados (Mantidos para não quebrar o prompt-assembler) ───────
export async function resolveLocation(raw: UserLocation | null): Promise<UserLocation | null> {
  if (!raw) return null;
  const lat = typeof raw.lat === 'string' ? parseFloat(raw.lat) : raw.lat;
  const lng = typeof raw.lng === 'string' ? parseFloat(raw.lng) : raw.lng;
  if (!isFinite(lat) || !isFinite(lng) || (raw.label && !/^-?\d/.test(raw.label) && raw.city)) return raw;

  const resolved = await callNominatim(lat, lng);
  return { ...raw, lat, lng, label: resolved?.label ?? coordLabel(lat, lng), city: resolved?.city, state: resolved?.state, country: resolved?.country };
}

export function formatLocationForPrompt(loc: any): string {
  if (!loc) return 'Localização não disponível';
  const lat = 'latitude' in loc ? loc.latitude : (typeof loc.lat === 'string' ? parseFloat(loc.lat) : loc.lat);
  const lng = 'longitude' in loc ? loc.longitude : (typeof loc.lng === 'string' ? parseFloat(loc.lng) : loc.lng);
  const parts = [loc.label, loc.city, loc.state, loc.country].filter(p => p && !/^-?\d/.test(p));
  return `${parts.join(', ') || coordLabel(lat, lng)} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

export function buildGeoBlock(loc: any): string { return loc ? `📍 Localização atual: ${formatLocationForPrompt(loc)}` : ''; }
export function normalizeLocationForModules(loc: any) {
  if (!loc) return null;
  return { latitude: Number(loc.lat), longitude: Number(loc.lng), label: loc.label, city: loc.city, state: loc.state };
}
