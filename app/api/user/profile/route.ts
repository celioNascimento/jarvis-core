// app/api/user/profile/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const numericUserId = await getUserFromToken(token);
  if (!numericUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Busca dados do user
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, assistant_name, preferred_name, timezone, nickname, notification_hour')
    .eq('id', numericUserId)
    .single();
  if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });

  // Busca dados do perfil
  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('city, state, profession, birth_date, phone')
    .eq('user_id', numericUserId)
    .maybeSingle();

  if (profileErr) return NextResponse.json({ error: profileErr.message }, { status: 500 });

  return NextResponse.json({ user, profile });
}

export async function PATCH(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const numericUserId = await getUserFromToken(token);
  if (!numericUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { userFields, profileFields } = body;

  if (userFields && Object.keys(userFields).length) {
    const { error: updateUserErr } = await supabase
      .from('users')
      .update(userFields)
      .eq('id', numericUserId);
    if (updateUserErr) return NextResponse.json({ error: updateUserErr.message }, { status: 500 });
  }

  if (profileFields && Object.keys(profileFields).length) {
    // Atualiza ou insere
    const { error: upsertErr } = await supabase
      .from('user_profiles')
      .upsert({ user_id: numericUserId, ...profileFields }, { onConflict: 'user_id' });
    if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}