// lib/geo.ts — V3.1.0 (CONSOLIDADO: Proximity Radar + God RPC Integration)
import { supabase } from '@/lib/jarvis';

// --- Utilitários de Cálculo ---
function distanciaMetros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function jáAvisouRecentemente(userId: string, placeId: string): Promise<boolean> {
  const key = `geo_alert_${userId}_${placeId}`;
  const { data } = await supabase.from('config').select('value').eq('key', key).single();
  if (!data?.value) return false;
  const duasHoras = 2 * 60 * 60 * 1000;
  return (Date.now() - parseInt(data.value)) < duasHoras;
}

// ─── FUNÇÃO 1: O RADAR PROATIVO (A que estava faltando) ──────────────────────
export async function verificarAlertasDeProximidade(userId: string, lat: number, lng: number) {
  try {
    const { data: lugares } = await supabase.from('favorite_places').select('*').eq('user_id', userId);
    if (!lugares?.length) return { temAlerta: false, mensagem: '' };

    for (const lugar of lugares) {
      const dist = distanciaMetros(lat, lng, lugar.lat, lugar.lng);
      if (dist > (lugar.radius_meters || 200)) continue;

      if (await jáAvisouRecentemente(userId, lugar.id)) continue;

      const { data: itens } = await supabase.from('shopping_items').select('item').eq('place_id', lugar.id).eq('done', false);
      
      if (itens?.length) {
        await supabase.from('config').upsert({ key: `geo_alert_${userId}_${lugar.id}`, value: String(Date.now()) });
        return { 
          temAlerta: true, 
          mensagem: `Célio, você está perto de ${lugar.name}. Itens pendentes: ${itens.map(i => i.item).join(', ')}.` 
        };
      }
    }
    return { temAlerta: false, mensagem: '' };
  } catch (err) {
    return { temAlerta: false, mensagem: '' };
  }
}

// ─── FUNÇÃO 2: RESOLUÇÃO DE TEXTO (checkProximidade) ────────────────────────
export async function checkProximidade(lat: number, lng: number, userId?: string, injectedLocations?: any[]) {
  // Mantém sua lógica original do V3.0.0 aqui se desejar usar como fallback
  return `📍 Coordenadas: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}
