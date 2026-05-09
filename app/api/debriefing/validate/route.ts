// app/api/debriefing/validate/route.ts
// Recebe a resposta do usuário aos botões ✅ / ❌ do app Expo.
//
// Chamada pelo app mobile após o usuário tocar em confirmar ou rejeitar.
// Requer Bearer token de autenticação.
//
// Exemplos:
//   CONFIRMAR: POST /api/debriefing/validate  { insightId: "uuid", confirm: true }
//   REJEITAR:  POST /api/debriefing/validate  { insightId: "uuid", confirm: false }

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

export async function POST(req: NextRequest) {
  // 1. Autenticação via Bearer token (mesmo padrão do registerForPushNotifications)
  const authHeader = req.headers.get('authorization') || '';
  const accessToken = authHeader.replace('Bearer ', '').trim();

  if (!accessToken) {
    return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
  }

  // Valida o token com o Supabase Auth
  const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !authUser) {
    return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
  }

  // 2. Parse do body
  let insightId: string;
  let confirm: boolean;

  try {
    const body = await req.json();
    insightId = body.insightId;
    confirm   = Boolean(body.confirm);

    if (!insightId) throw new Error('insightId ausente');
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
  }

  // 3. Busca o insight e valida ownership
  const { data: insight, error: fetchError } = await supabase
    .schema('jarvis')
    .from('learned_insights')
    .select('id, user_id, source_type')
    .eq('id', insightId)
    .single();

  if (fetchError || !insight) {
    return NextResponse.json({ error: 'Insight não encontrado' }, { status: 404 });
  }

  // Garante que o insight pertence ao usuário autenticado
  const { data: dbUser } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', authUser.id)
    .single();

  if (!dbUser || insight.user_id !== dbUser.id) {
    return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
  }

  // 4. Aplica a validação
  if (confirm) {
    // Usuário confirmou — promove para user_confirmed e valida agora
    const { error } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .update({
        source_type:       'user_confirmed',
        confidence_score:  1.0,
        last_validated_at: new Date().toISOString(),
      })
      .eq('id', insightId);

    if (error) return NextResponse.json({ error: 'Erro ao confirmar' }, { status: 500 });

    return NextResponse.json({ ok: true, action: 'confirmed' });

  } else {
    // Usuário rejeitou — desativa silenciosamente
    const { error } = await supabase
      .schema('jarvis')
      .from('learned_insights')
      .update({ is_active: false })
      .eq('id', insightId);

    if (error) return NextResponse.json({ error: 'Erro ao rejeitar' }, { status: 500 });

    return NextResponse.json({ ok: true, action: 'rejected' });
  }
}