// app/api/user/me/route.ts
// V12.5.0 — Identidade Unificada & Resiliência a Contexto Vazio

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { getUserFromToken } from '@/lib/auth';

/**
 * GET: Retorna os dados do usuário e perfil.
 * Ajustado para usar .maybeSingle() e evitar o erro 406 no log.
 */
export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const numericUserId = await getUserFromToken(token);
    
    if (!numericUserId) {
      return NextResponse.json({ error: 'Sessão inválida ou expirada.' }, { status: 401 });
    }

    // 1. Busca dados do usuário (Blindagem com .maybeSingle)
    // Se o usuário não existir no banco, retornamos null em vez de estourar erro 406.
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, assistant_name, preferred_name, timezone, nickname, notification_hour, preferred_voice, email')
      .eq('id', numericUserId)
      .maybeSingle();
      
    if (userErr) throw userErr;

    // 2. Busca dados do perfil
    const { data: profile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('full_name, city, state, profession, birth_date, phone')
      .eq('user_id', numericUserId)
      .maybeSingle();

    if (profileErr) throw profileErr;

    // Se o usuário for null, significa que o token é válido mas o registro no DB sumiu.
    if (!user) {
      return NextResponse.json({ error: 'Registro de usuário não localizado no banco.' }, { status: 404 });
    }

    return NextResponse.json({ user, profile: profile ?? {} });
  } catch (err: any) {
    console.error('[API_ME_GET] Erro:', err.message);
    return NextResponse.json({ error: 'Erro interno ao carregar perfil.' }, { status: 500 });
  }
}

/**
 * PATCH: Atualização atômica de campos.
 */
export async function PATCH(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    const numericUserId = await getUserFromToken(token);
    
    if (!numericUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { userFields, profileFields } = body;

    // 1. Atualiza a tabela 'users' se houver campos
    if (userFields && Object.keys(userFields).length) {
      const { error: updateUserErr } = await supabase
        .from('users')
        .update(userFields)
        .eq('id', numericUserId);
      
      if (updateUserErr) throw updateUserErr;
    }

    // 2. Upsert na 'user_profiles' (Cria se não existir, atualiza se existir)
    if (profileFields && Object.keys(profileFields).length) {
      const { error: upsertErr } = await supabase
        .from('user_profiles')
        .upsert(
          { user_id: numericUserId, ...profileFields }, 
          { onConflict: 'user_id' }
        );
      
      if (upsertErr) throw upsertErr;
    }

    return NextResponse.json({ ok: true, message: 'Dados atualizados com sucesso.' });
  } catch (err: any) {
    console.error('[API_ME_PATCH] Erro:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
