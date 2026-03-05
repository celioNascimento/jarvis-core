import { NextResponse } from 'next/server';
import { supabase, sendTelegram, callOpenRouter } from '@/lib/jarvis';

// ============================================================
// /api/relationships
//
// GET    → lista todos os vínculos do usuário
// POST   → cria um novo convite de vínculo
// PATCH  → aceita, pausa ou encerra um vínculo
// ============================================================

// ============================================================
// GET — Lista vínculos ativos do usuário
// Query: ?userId=8595482774
// ============================================================
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');

  if (!userId) {
    return NextResponse.json({ error: 'userId obrigatório' }, { status: 400 });
  }

  try {
    const { data, error } = await supabase.rpc('get_user_relationships', {
      p_user_id: parseInt(userId)
    });

    if (error) throw error;

    return NextResponse.json({ ok: true, relationships: data });

  } catch (e: any) {
    console.error('GET /relationships erro:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


// ============================================================
// POST — Cria convite de vínculo
// Body: { userIdA, userIdB, typeA, typeB, privacyLevel }
//
// typeA = como userA vê userB  (ex: "cônjuge")
// typeB = como userB vê userA  (ex: "cônjuge")
//
// Exemplos de pares:
//   pai/mãe ↔ filho/filha
//   cônjuge ↔ cônjuge
//   namorado ↔ namorada
//   amigo_próximo ↔ amigo_próximo
// ============================================================
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userIdA, userIdB, typeA, typeB, privacyLevel } = body;

    if (!userIdA || !userIdB || !typeA || !typeB) {
      return NextResponse.json(
        { error: 'userIdA, userIdB, typeA e typeB são obrigatórios' },
        { status: 400 }
      );
    }

    // Verifica se já existe vínculo entre os dois (em qualquer ordem)
    const { data: existing } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${userIdA},user_id_b.eq.${userIdB}),` +
        `and(user_id_a.eq.${userIdB},user_id_b.eq.${userIdA})`
      )
      .single();

    if (existing) {
      if (existing.status === 'ended') {
        // Vínculo encerrado — permite recriar
        await supabase
          .from('relationships')
          .delete()
          .eq('id', existing.id);
      } else {
        return NextResponse.json(
          { error: `Já existe um vínculo entre esses usuários (status: ${existing.status})` },
          { status: 409 }
        );
      }
    }

    // Define nível de privacidade padrão por tipo se não informado
    const defaultPrivacyLevel = privacyLevel || getDefaultPrivacyLevel(typeA);

    // Cria o vínculo como pendente
    const { data: relationship, error } = await supabase
      .from('relationships')
      .insert({
        user_id_a: userIdA,
        user_id_b: userIdB,
        type_a: typeA,
        type_b: typeB,
        status: 'pending',
        intensity: getDefaultIntensity(typeA),
        privacy_level: defaultPrivacyLevel,
        initiated_by: userIdA
      })
      .select()
      .single();

    if (error) throw error;

    // Cria permissões padrão baseadas no nível de privacidade
    await createDefaultPermissions(relationship.id, userIdA, userIdB, defaultPrivacyLevel);

    // Notifica userB via Telegram se possível
    const { data: userA } = await supabase
      .from('users')
      .select('name, nickname')
      .eq('id', userIdA)
      .single();

    const { data: userB } = await supabase
      .from('users')
      .select('id, name, nickname')
      .eq('id', userIdB)
      .single();

    if (userB) {
      const nomeA = userA?.nickname || userA?.name || 'Alguém';
      const tipoVinculo = formatRelationshipType(typeB); // como userB vai ver userA

      await sendTelegram(
        userB.id,
        `💌 *${nomeA}* quer se conectar com você como *${tipoVinculo}* no Lev.\n\n` +
        `Para aceitar, responda: *aceitar vínculo*\n` +
        `Para recusar: *recusar vínculo*\n\n` +
        `_ID do convite: ${relationship.id}_`
      );
    }

    return NextResponse.json({
      ok: true,
      relationship,
      message: `Convite enviado para ${userB?.nickname || userB?.name || userIdB}`
    });

  } catch (e: any) {
    console.error('POST /relationships erro:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


// ============================================================
// PATCH — Atualiza status de um vínculo
// Body: { relationshipId, userId, action }
// action: 'accept' | 'decline' | 'pause' | 'end'
// ============================================================
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { relationshipId, userId, action } = body;

    if (!relationshipId || !userId || !action) {
      return NextResponse.json(
        { error: 'relationshipId, userId e action são obrigatórios' },
        { status: 400 }
      );
    }

    // Verifica se o usuário faz parte desse vínculo
    const { data: rel } = await supabase
      .from('relationships')
      .select('*, user_id_a, user_id_b, type_a, type_b')
      .eq('id', relationshipId)
      .single();

    if (!rel) {
      return NextResponse.json({ error: 'Vínculo não encontrado' }, { status: 404 });
    }

    if (rel.user_id_a !== parseInt(userId) && rel.user_id_b !== parseInt(userId)) {
      return NextResponse.json({ error: 'Usuário não pertence a esse vínculo' }, { status: 403 });
    }

    let newStatus = rel.status;
    let message = '';

    switch (action) {
      case 'accept':
        if (rel.status !== 'pending') {
          return NextResponse.json({ error: 'Vínculo não está pendente' }, { status: 400 });
        }
        newStatus = 'active';
        message = 'Vínculo aceito e ativado!';

        // Notifica quem criou o vínculo
        const outroUserId = rel.user_id_b === parseInt(userId) ? rel.user_id_a : rel.user_id_b;
        const { data: quemAceitou } = await supabase
          .from('users')
          .select('nickname, name')
          .eq('id', userId)
          .single();

        await sendTelegram(
          outroUserId,
          `✅ *${quemAceitou?.nickname || quemAceitou?.name}* aceitou seu convite de vínculo no Lev! 🎉`
        );
        break;

      case 'decline':
        newStatus = 'ended';
        message = 'Convite recusado.';
        break;

      case 'pause':
        newStatus = 'paused';
        message = 'Vínculo pausado.';
        break;

      case 'end':
        // Usa a função SQL que congela memórias
        const { error: endError } = await supabase.rpc('end_relationship', {
          p_relationship_id: relationshipId,
          p_user_id: parseInt(userId)
        });
        if (endError) throw endError;
        return NextResponse.json({ ok: true, message: 'Vínculo encerrado. Memórias congeladas.' });
    }

    const { error: updateError } = await supabase
      .from('relationships')
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
        ...(newStatus === 'active' ? { connected_at: new Date().toISOString() } : {}),
        ...(newStatus === 'ended' ? { ended_at: new Date().toISOString() } : {})
      })
      .eq('id', relationshipId);

    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, message, newStatus });

  } catch (e: any) {
    console.error('PATCH /relationships erro:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


// ============================================================
// HELPERS
// ============================================================

function getDefaultPrivacyLevel(type: string): number {
  const levels: Record<string, number> = {
    'cônjuge':          5,
    'namorado':         4,
    'namorada':         4,
    'noivo':            4,
    'noiva':            4,
    'pai':              4,
    'mãe':              4,
    'filho':            4,
    'filha':            4,
    'irmão':            3,
    'irmã':             3,
    'avô':              3,
    'avó':              3,
    'amigo_próximo':    3,
    'amigo':            2,
    'colega':           1,
    'conhecido':        1,
  };
  return levels[type.toLowerCase()] || 2;
}

function getDefaultIntensity(type: string): number {
  const intensities: Record<string, number> = {
    'cônjuge':          0.95,
    'noivo':            0,80,
    'noiva':            0,80,
    'namorado':         0.80,
    'namorada':         0.80,
    'pai':              0.90,
    'mãe':              0.90,
    'filho':            0.90,
    'filha':            0.90,
    'irmão':            0.70,
    'irmã':             0.70,
    'amigo_próximo':    0.60,
    'amigo':            0.40,
    'colega':           0.25,
    'conhecido':        0.10,
  };
  return intensities[type.toLowerCase()] || 0.30;
}

async function createDefaultPermissions(
  relationshipId: string,
  userIdA: number,
  userIdB: number,
  privacyLevel: number
) {
  const permissionsByLevel: Record<number, string[]> = {
    1: [],
    2: ['birthday'],
    3: ['birthday', 'calendar'],
    4: ['birthday', 'calendar', 'tasks', 'memories_shared'],
    5: ['birthday', 'calendar', 'tasks', 'memories_shared', 'children'],
  };

  const permissions = permissionsByLevel[privacyLevel] || [];
  const inserts = [];

  // Cada um concede ao outro as permissões do nível
  for (const permission of permissions) {
    inserts.push({
      relationship_id: relationshipId,
      granted_by: userIdA,
      granted_to: userIdB,
      permission
    });
    inserts.push({
      relationship_id: relationshipId,
      granted_by: userIdB,
      granted_to: userIdA,
      permission
    });
  }

  if (inserts.length > 0) {
    await supabase.from('relationship_permissions').insert(inserts);
  }
}

function formatRelationshipType(type: string): string {
  const labels: Record<string, string> = {
    'cônjuge':       'cônjuge',
    'noivo':         'noivo',
    'noiva':         'noiva',
    'namorado':      'namorado',
    'namorada':      'namorada',
    'pai':           'pai',
    'mãe':           'mãe',
    'filho':         'filho',
    'filha':         'filha',
    'irmão':         'irmão',
    'irmã':          'irmã',
    'amigo_próximo': 'amigo próximo',
    'amigo':         'amigo',
    'colega':        'colega',
    'conhecido':     'conhecido',
  };
  return labels[type.toLowerCase()] || type;
}
