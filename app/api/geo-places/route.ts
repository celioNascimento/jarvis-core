// app/api/geo-places/route.ts
//
// Retorna os lugares favoritos do usuário para o app registrar as zonas de geofencing.
// Chamado uma vez na inicialização do app (ativarRadarDeFundo).

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'userId é obrigatório' }, { status: 400 });
    }

    const { data: lugares, error } = await supabase
      .schema('jarvis')
      .from('favorite_places')
      .select('id, name, lat, lng, radius_meters')
      .eq('user_id', userId);

    if (error) throw error;

    return NextResponse.json(lugares ?? []);

  } catch (error: any) {
    console.error('[Geo Places] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}