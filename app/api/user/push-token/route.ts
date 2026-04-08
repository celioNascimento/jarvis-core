import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const bearerToken = authHeader?.replace('Bearer ', '');
  if (!bearerToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(bearerToken);
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  const { userId, token: push_token, platform } = await req.json();

  // Resolve o id numérico independente de receber UUID ou number
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId));

  let numericId: string;
  if (isUUID) {
    // UUID recebido — resolve pelo auth_user_id (que já vem validado do token)
    // Usa o user.id do token em vez do userId do body para evitar spoofing
    const { data: userRecord, error: lookupError } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (lookupError || !userRecord) {
      console.error('[push-token] Usuário não encontrado:', lookupError?.message);
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }
    numericId = String(userRecord.id);
  } else {
    numericId = String(userId);
  }

  const { error: updateError } = await supabase
    .schema('jarvis')
    .from('users')
    .update({ push_token: push_token, last_active_token: bearerToken, last_active_platform: platform })
    .eq('id', numericId)
    .eq('auth_user_id', user.id);  // double-check de segurança

  if (updateError) {
    console.error('[push-token] Erro ao salvar push token:', updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}