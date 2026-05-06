import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis'; // Ajuste o caminho do seu client Supabase

export async function POST(request: Request) {
  try {
    const { userId, lat, lon } = await request.json();

    console.log(`📍 Ping recebido (Usuário: ${userId})! Lat: ${lat}, Lon: ${lon}`);

    // 1. Consulta rápida: a lista de compras tem algo para ESTE usuário?
    const { data: lista, error } = await supabase
      .schema('jarvis')
      .from('shopping_list')
      .select('item')
      .eq('user_id', Number(userId)) // Filtro dinâmico inserido
      .eq('status', 'pending');

    if (error) throw error;

    // 2. Lógica de decisão (Apenas log no terminal por enquanto)
    if (lista && lista.length > 0) {
      console.log(`🛒 Usuário ${userId} está em movimento e tem ${lista.length} itens pendentes. Ativar busca de mercado!`);
      // A implementação da busca no Google Places e disparo de Push entraremos aqui depois.
    } else {
      console.log(`✅ Lista limpa para o usuário ${userId}. Nenhuma ação necessária para este ping.`);
    }

    return NextResponse.json({ success: true, message: 'Radar processado' });
  } catch (error: any) {
    console.error('Erro no ping de localização:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}