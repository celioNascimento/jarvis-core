// app/api/user/push-token/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  const { userId, token: pushToken, platform } = await req.json();

  // Salva o token na tabela users (coluna fcm_token)
  const { error: updateError } = await supabase
    .from('users')
    .update({ fcm_token: pushToken, last_active_platform: platform })
    .eq('id', userId)
    .eq('auth_user_id', user.id);

  if (updateError) {
    console.error('Erro ao salvar push token:', updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}