import { haversineKm, coordLabel } from './geo-math';

const NOMINATIM_TIMEOUT_MS = 5000;
const NOMINATIM_MAX_DRIFT_KM = 15;

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
  const road = address.road;
  const suburb = address.suburb || address.neighbourhood;
  const city = address.city || address.town || address.village || address.municipality || address.county;
  if (road) parts.push(road);
  if (suburb) parts.push(suburb);
  if (city) parts.push(city);
  return parts.length >= 2 ? parts.join(', ') : displayName;
}

export async function callNominatim(lat: number, lng: number): Promise<{
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

    if (!res.ok) return null;

    const geo = await res.json();
    if (geo.error) return null;

    const drift = haversineKm(lat, lng, parseFloat(geo.lat ?? '0'), parseFloat(geo.lon ?? '0'));
    if (drift > NOMINATIM_MAX_DRIFT_KM) return null;

    const address: NominatimAddress = geo.address ?? {};
    const city = address.city || address.town || address.village || address.municipality || address.county || '';

    return {
      label: buildHumanLabel(address, geo.display_name ?? coordLabel(lat, lng)),
      city,
      state: address.state || '',
      country: address.country || '',
    };
  } catch {
    return null;
  }
}
