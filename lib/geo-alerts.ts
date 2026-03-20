import { supabase } from './jarvis';

// Distância em metros entre duas coordenadas (Haversine)
function distanciaMetros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Chave de cooldown no Supabase — evita spam a cada atualização do Live Location
async function jáAvisouRecentemente(userId: string, placeId: string): Promise<boolean> {
  const key = `geo_alert_${userId}_${placeId}`;
  const { data } = await supabase.from('config').select('value').eq('key', key).single();
  if (!data?.value) return false;
  const ultimoAviso = parseInt(data.value);
  const duasHoras = 2 * 60 * 60 * 1000;
  return (Date.now() - ultimoAviso) < duasHoras;
}

async function registrarAviso(userId: string, placeId: string): Promise<void> {
  const key = `geo_alert_${userId}_${placeId}`;
  await supabase.from('config').upsert(
    { key, value: String(Date.now()) },
    { onConflict: 'key' }
  );
}

export interface GeoAlertResult {
  temAlerta: boolean;
  mensagem: string;
}

export async function verificarAlertasDeProximidade(
  userId: string,
  lat: number,
  lng: number
): Promise<GeoAlertResult> {
  try {
    // Busca todos os lugares favoritos do usuário
    const { data: lugares, error } = await supabase
      .from('favorite_places')
      .select('*')
      .eq('user_id', userId);

    if (error || !lugares?.length) {
      console.log('[GeoAlert] Nenhum lugar favorito cadastrado para:', userId);
      return { temAlerta: false, mensagem: '' };
    }

    for (const lugar of lugares) {
      const distancia = distanciaMetros(lat, lng, lugar.lat, lugar.lng);
      console.log(`[GeoAlert] ${lugar.name}: ${Math.round(distancia)}m (raio: ${lugar.radius_meters}m)`);

      if (distancia > lugar.radius_meters) continue;

      // Está dentro do raio — verifica cooldown
      if (await jáAvisouRecentemente(userId, lugar.id)) {
        console.log(`[GeoAlert] ${lugar.name}: cooldown ativo, pulando`);
        continue;
      }

      // Busca itens pendentes para este lugar
      const { data: itens } = await supabase
        .from('shopping_items')
        .select('item')
        .eq('user_id', userId)
        .eq('place_id', lugar.id)
        .eq('done', false);

      if (!itens?.length) {
        console.log(`[GeoAlert] ${lugar.name}: sem itens pendentes`);
        continue;
      }

      // Registra o aviso antes de retornar
      await registrarAviso(userId, lugar.id);

      const listaItens = itens.map(i => `• ${i.item}`).join('\n');
      const mensagem =
        `🛒 Você está perto de *${lugar.name}*!\n\n` +
        `Itens pendentes na sua lista:\n${listaItens}\n\n` +
        `Quer marcar algum como feito?`;

      console.log(`[GeoAlert] Alerta disparado para ${lugar.name} — ${itens.length} itens`);
      return { temAlerta: true, mensagem };
    }

    return { temAlerta: false, mensagem: '' };

  } catch (err) {
    console.error('[GeoAlert] Erro:', err);
    return { temAlerta: false, mensagem: '' };
  }
}