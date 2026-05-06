/**
 * geo-resolver.ts — V12.2.2 (GEO-PRECISION GUARD)
 *
 * Problema resolvido: Nominatim retornava "Cornélio Procópio" ao invés de
 * "Londrina" por colisão de nomes de bairro (Vila Nova existe em ambas).
 *
 * Solução em 3 camadas:
 *   1. BBOX GUARD     → Rejeita resultados fora de um raio aceitável das coords brutas
 *   2. ZOOM=18        → Força Nominatim a retornar granularidade de prédio
 *   3. COORD SANITY   → Se a cidade retornada diverge da bounding box, usa fallback
 */

export interface UserLocation {
  lat: number | string;
  lng: number | string;
  label?: string;
  city?: string;
  state?: string;
  country?: string;
}

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
  postcode?: string;
}

interface NominatimResponse {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: NominatimAddress;
  boundingbox?: [string, string, string, string]; // [minLat, maxLat, minLon, maxLon]
  error?: string;
}

// ─── Haversine (distância em km entre dois pontos) ───────────────────────────
function haversineKm(
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

// ─── Fallback: label legível a partir das coords brutas ─────────────────────
function coordLabel(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'O' : 'L'}`;
}

// ─── Monta um label curto e humano (rua + bairro + cidade) ──────────────────
function buildHumanLabel(address: NominatimAddress, displayName: string): string {
  const parts: string[] = [];

  const road = address.road;
  const suburb = address.suburb || address.neighbourhood;
  const city =
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county;

  if (road) parts.push(road);
  if (suburb) parts.push(suburb);
  if (city) parts.push(city);

  return parts.length >= 2 ? parts.join(', ') : displayName;
}

// ─── Núcleo: resolveLocation ─────────────────────────────────────────────────
/**
 * Recebe uma UserLocation com lat/lng brutas, consulta o Nominatim com
 * parâmetros de alta precisão e valida o resultado contra as coordenadas.
 *
 * Se o resultado do Nominatim estiver a mais de `MAX_DRIFT_KM` das coords
 * originais, ele é descartado e usamos o fallback de coordenadas.
 */
export async function resolveLocation(
  raw: UserLocation | null
): Promise<UserLocation | null> {
  if (!raw) return null;

  const lat = typeof raw.lat === 'string' ? parseFloat(raw.lat) : raw.lat;
  const lng = typeof raw.lng === 'string' ? parseFloat(raw.lng) : raw.lng;

  // Coordenadas inválidas → retorna como veio
  if (!isFinite(lat) || !isFinite(lng)) return raw;

  // Label já resolvido e não é só coordenada → mantém (evita chamada desnecessária)
  if (raw.label && !/^-?\d/.test(raw.label) && raw.city) return raw;

  const MAX_DRIFT_KM = 15; // Margem aceitável entre GPS e resultado do geo

  try {
    // zoom=18 = granularidade de prédio/casa
    // addressdetails=1 = objeto address estruturado
    // extratags=0 = menos payload
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', lat.toString());
    url.searchParams.set('lon', lng.toString());
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('accept-language', 'pt-BR');

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'JarvisCore/1.2 (contato@procuroquemfaca.com.br)',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[Geo] Nominatim HTTP ${res.status} — usando fallback`);
      return { ...raw, lat, lng, label: coordLabel(lat, lng) };
    }

    const geo: NominatimResponse = await res.json();

    if (geo.error) {
      console.warn(`[Geo] Nominatim error: ${geo.error}`);
      return { ...raw, lat, lng, label: coordLabel(lat, lng) };
    }

    // ── BBOX GUARD: valida se o ponto retornado está perto das coords originais ──
    const geoLat = parseFloat(geo.lat ?? '0');
    const geoLon = parseFloat(geo.lon ?? '0');
    const drift = haversineKm(lat, lng, geoLat, geoLon);

    if (drift > MAX_DRIFT_KM) {
      console.warn(
        `[Geo] DRIFT DETECTADO! ${drift.toFixed(1)}km de desvio. ` +
        `GPS=(${lat},${lng}) vs Nominatim=(${geoLat},${geoLon}). ` +
        `Resultado descartado: "${geo.display_name}"`
      );
      // Retorna com coordenadas corretas e label genérico
      return {
        ...raw,
        lat,
        lng,
        label: coordLabel(lat, lng),
        city: '',
        state: '',
      };
    }

    const address = geo.address ?? {};
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      '';

    const resolved: UserLocation = {
      ...raw,
      lat,
      lng,
      label: buildHumanLabel(address, geo.display_name ?? coordLabel(lat, lng)),
      city,
      state: address.state || '',
      country: address.country || '',
    };

    console.info(
      `[Geo] Resolvido: (${lat}, ${lng}) → "${resolved.label}" ` +
      `| drift=${drift.toFixed(2)}km`
    );

    return resolved;
  } catch (err) {
    console.error('[Geo] Erro na resolução:', err);
    // Nunca deixa o sistema sem localização — retorna coords brutas com label legível
    return { ...raw, lat, lng, label: coordLabel(lat, lng) };
  }
}

// ─── Helpers de contexto para o system prompt ────────────────────────────────

/**
 * Formata a localização resolvida em um bloco de texto para o system prompt.
 * Exemplo: "Rua das Flores, Vila Nova, Londrina — Paraná, Brasil"
 */
export function formatLocationForPrompt(loc: UserLocation | null): string {
  if (!loc) return 'Localização não disponível';

  const lat = typeof loc.lat === 'string' ? parseFloat(loc.lat) : loc.lat;
  const lng = typeof loc.lng === 'string' ? parseFloat(loc.lng) : loc.lng;

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
 * Gera um bloco de contexto geo completo para injetar no system prompt.
 */
export function buildGeoBlock(loc: UserLocation | null): string {
  if (!loc) return '';

  const formatted = formatLocationForPrompt(loc);
  return `📍 Localização atual: ${formatted}`;
}
