import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(request: Request) {
  try {
    const { userId, lat, lon } = await request.json();

    console.log(`📍 Ping recebido (Usuário: ${userId})! Lat: ${lat}, Lon: ${lon}`);

    // 1. Consulta rápida: Ajustamos para 'shopping_items' e o filtro de 'done'
    const { data: lista, error } = await supabase
      .schema('jarvis')
      .from('shopping_items') // CORREÇÃO: Alinhado com o nome no seu banco
      .select('item')
      .eq('user_id', Number(userId))
      .eq('done', false)      // CORREÇÃO: No seu banco, itens pendentes são done = false
      .eq('archived', false); // CORREÇÃO: Garante que não pega itens antigos arquivados

    if (error) throw error;

    // 2. Lógica de decisão
    if (lista && lista.length > 0) {
      console.log(`🛒 Usuário ${userId} em movimento. Radar ativo para ${lista.length} itens: ${lista.map(i => i.item).join(', ')}`);
      // Próximo passo: Integração com Google Places aqui.
    } else {
      console.log(`✅ Nenhuma ação para o usuário ${userId}. Lista de compras vazia ou já concluída.`);
    }

    return NextResponse.json({ success: true, message: 'Radar processado' });
  } catch (error: any) {
    console.error('Erro no ping de localização:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}