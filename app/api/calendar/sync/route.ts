import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { syncGoogleCalendarToLev } from '@/lib/google'; // Certifique-se de que a função que te enviei antes está no lib/google.ts

export async function POST(req: NextRequest) {
  try {
    const authUserId = req.headers.get('x-user-id');
    if (!authUserId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    // Busca o ID numérico do usuário
    const { data: user } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (!user) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });

    const success = await syncGoogleCalendarToLev(BigInt(user.id));

    return NextResponse.json({ 
      success, 
      message: success ? 'Agenda sincronizada' : 'Falha na sincronização' 
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}