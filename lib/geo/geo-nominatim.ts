// lib/geo-nominatim.ts

import { haversineKm, coordLabel } from './geo-math';

const NOMINATIM_TIMEOUT_MS = 5000;
const NOMINATIM_MAX_DRIFT_KM = 15;

// Fallback por coordenada — cobre regiões brasileiras comuns
const CITY_FALLBACKS: Array<{
  lat: number; lng: number; radiusKm: number;
  city: string; state: string; country: string; label: string;
}> = [
  { lat: -23.3045, lng: -51.1696, radiusKm: 30, city: 'Londrina',      state: 'PR', country: 'Brasil', label: 'Londrina, PR' },
  { lat: -23.5505, lng: -46.6333, radiusKm: 40, city: 'São Paulo',     state: 'SP', country: 'Brasil', label: 'São Paulo, SP' },
  { lat: -22.9068, lng: -43.1729, radiusKm: 40, city: 'Rio de Janeiro',state: 'RJ', country: 'Brasil', label: 'Rio de Janeiro, RJ' },
  { lat: -25.4284, lng: -49.2733, radiusKm: 30, city: 'Curitiba',      state: 'PR', country: 'Brasil', label: 'Curitiba, PR' },
  { lat: -19.9167, lng: -43.9345, radiusKm: 30, city: 'Belo Horizonte',state: 'MG', country: 'Brasil', label: 'Belo Horizonte, MG' },
  { lat: -30.0346, lng: -51.2177, radiusKm: 30, city: 'Porto Alegre',  state: 'RS', country: 'Brasil', label: 'Porto Alegre, RS' },
  { lat: -12.9714, lng: -38.5014, radiusKm: 30, city: 'Salvador',      state: 'BA', country: 'Brasil', label: 'Salvador, BA' },
  { lat: -3.7172,  lng: -38.5433, radiusKm: 30, city: 'Fortaleza',     state: 'CE', country: 'Brasil', label: 'Fortaleza, CE' },
  { lat: -8.0476,  lng: -34.877,  radiusKm: 30, city: 'Recife',        state: 'PE', country: 'Brasil', label: 'Recife, PE' },
  { lat: -15.7801, lng: -47.9292, radiusKm: 40, city: 'Brasília',      state: 'DF', country: 'Brasil', label: 'Brasília, DF' },
];

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

function buildHumanLabel(address: NominatimAddress, displayName: string): string {
  const parts: string[] = [];
  const road   = address.road;
  const suburb = address.suburb || address.neighbourhood;
  const city   = address.city || address.town || address.village || address.municipality || address.county;
  if (road)   parts.push(road);
  if (suburb) parts.push(suburb);
  if (city)   parts.push(city);
  return parts.length >= 2 ? parts.join(', ') : displayName;
}

function cityFallback(lat: number, lng: number): {
  label: string; city: string; state: string; country: string;
} | null {
  for (const ref of CITY_FALLBACKS) {
    const distKm = haversineKm(lat, lng, ref.lat, ref.lng);
    if (distKm <= ref.radiusKm) {
      return { label: ref.label, city: ref.city, state: ref.state, country: ref.country };
    }
  }
  return null;
}

export async function callNominatim(lat: number, lng: number): Promise<{
  label: string; city: string; state: string; country: string;
} | null> {
  // 1. Tenta Nominatim
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat',            lat.toString());
    url.searchParams.set('lon',            lng.toString());
    url.searchParams.set('format',         'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom',           '18');
    url.searchParams.set('accept-language','pt-BR');

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'JarvisCore/1.3 (contato@procuroquemfaca.com.br)' },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });

    if (res.ok) {
      const geo = await res.json();
      if (!geo.error) {
        const drift = haversineKm(lat, lng, parseFloat(geo.lat ?? '0'), parseFloat(geo.lon ?? '0'));
        if (drift <= NOMINATIM_MAX_DRIFT_KM) {
          const address: NominatimAddress = geo.address ?? {};
          const city = address.city || address.town || address.village || address.municipality || address.county || '';
          return {
            label:   buildHumanLabel(address, geo.display_name ?? coordLabel(lat, lng)),
            city,
            state:   address.state   || '',
            country: address.country || '',
          };
        }
      }
    }
  } catch {
    // Nominatim falhou (timeout, bloqueio de rede, etc.) — segue para fallback
  }

  // 2. Fallback por proximidade geográfica
  const fallback = cityFallback(lat, lng);
  if (fallback) {
    console.warn(`[Nominatim] Indisponível — usando fallback para ${fallback.city}`);
    return fallback;
  }

  // 3. Nenhum fallback cobre — retorna null (coordLabel será usado pelo caller)
  return null;
}
