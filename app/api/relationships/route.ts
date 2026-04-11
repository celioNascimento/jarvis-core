// app/api/relationships/route.ts
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

    // 🔁 Converte IDs numéricos para auth_user_id (UUID)
    const { data: userA, error: errA } = await supabase
      .from('users')
      .select('auth_user_id')
      .eq('id', parseInt(userIdA))
      .single();
    const { data: userB, error: errB } = await supabase
      .from('users')
      .select('auth_user_id')
      .eq('id', parseInt(userIdB))
      .single();

    if (errA || !userA?.auth_user_id) {
      return NextResponse.json({ error: 'Usuário A não encontrado' }, { status: 404 });
    }
    if (errB || !userB?.auth_user_id) {
      return NextResponse.json({ error: 'Usuário B não encontrado' }, { status: 404 });
    }

    const authIdA = userA.auth_user_id;
    const authIdB = userB.auth_user_id;

    // Verifica se já existe vínculo entre os dois (em qualquer ordem)
    const { data: existing } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${authIdA},user_id_b.eq.${authIdB}),` +
        `and(user_id_a.eq.${authIdB},user_id_b.eq.${authIdA})`
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

    // Cria o vínculo como pendente (usando auth_user_id)
    const { data: relationship, error } = await supabase
      .from('relationships')
      .insert({
        user_id_a: authIdA,
        user_id_b: authIdB,
        type_a: typeA,
        type_b: typeB,
        status: 'pending',
        intensity: getDefaultIntensity(typeA),
        privacy_level: defaultPrivacyLevel,
        initiated_by: authIdA
      })
      .select()
      .single();

    if (error) throw error;

    // Cria permissões padrão baseadas no nível de privacidade
    await createDefaultPermissions(relationship.id, parseInt(userIdA), parseInt(userIdB), defaultPrivacyLevel);

    // Notifica userB via Telegram se possível
    const { data: userAData } = await supabase
      .from('users')
      .select('name, nickname')
      .eq('id', parseInt(userIdA))
      .single();

    const { data: userBData } = await supabase
      .from('users')
      .select('id, name, nickname')
      .eq('id', parseInt(userIdB))
      .single();

    if (userBData) {
      const nomeA = userAData?.nickname || userAData?.name || 'Alguém';
      const tipoVinculo = formatRelationshipType(typeB); // como userB vai ver userA

      await sendTelegram(
        userBData.id,
        `💌 *${nomeA}* quer se conectar com você como *${tipoVinculo}* no Lev.\n\n` +
        `Para aceitar, responda: *aceitar vínculo*\n` +
        `Para recusar: *recusar vínculo*\n\n` +
        `_ID do convite: ${relationship.id}_`
      );
    }

    return NextResponse.json({
      ok: true,
      relationship,
      message: `Convite enviado para ${userBData?.nickname || userBData?.name || userIdB}`
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

    // rel.user_id_a e rel.user_id_b são UUIDs; o userId recebido é numérico (bigint)
    // Precisamos do auth_user_id do usuário que está fazendo a ação
    const { data: requester } = await supabase
      .from('users')
      .select('auth_user_id')
      .eq('id', parseInt(userId))
      .single();

    if (!requester?.auth_user_id) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 });
    }

    if (rel.user_id_a !== requester.auth_user_id && rel.user_id_b !== requester.auth_user_id) {
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

        // 🔥 APLICA REGRAS PADRÃO DE COMPARTILHAMENTO AUTOMÁTICO
        await applyDefaultShares(relationshipId, rel.user_id_a, rel.user_id_b);

        // Notifica quem criou o vínculo
        const outroAuthId = rel.user_id_b === requester.auth_user_id ? rel.user_id_a : rel.user_id_b;
        const { data: quemAceitou } = await supabase
          .from('users')
          .select('nickname, name, id')
          .eq('auth_user_id', requester.auth_user_id)
          .single();

        // Buscar ID numérico do outro usuário para enviar Telegram
        const { data: outroUser } = await supabase
          .from('users')
          .select('id')
          .eq('auth_user_id', outroAuthId)
          .single();

        if (outroUser) {
          await sendTelegram(
            outroUser.id,
            `✅ *${quemAceitou?.nickname || quemAceitou?.name}* aceitou seu convite de vínculo no Lev! 🎉`
          );
        }
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
        // Usa a função SQL que congela memórias e remove compartilhamentos
        const { error: endError } = await supabase.rpc('end_relationship', {
          p_relationship_id: relationshipId,
          p_user_id: parseInt(userId)
        });
        if (endError) throw endError;
        return NextResponse.json({ ok: true, message: 'Vínculo encerrado. Memórias congeladas e compartilhamentos removidos.' });
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
    'noivo':            0.80,
    'noiva':            0.80,
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
    // Tabela relationship_permissions deve existir
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

// ============================================================
// COMPARTILHAMENTO AUTOMÁTICO (default_shares)
// ============================================================

/**
 * Aplica as regras padrão de compartilhamento quando um vínculo é ativado.
 * @param relationshipId - UUID do relacionamento
 * @param authIdA - auth_user_id do primeiro usuário (UUID)
 * @param authIdB - auth_user_id do segundo usuário (UUID)
 */
async function applyDefaultShares(relationshipId: string, authIdA: string, authIdB: string) {
  // 1. Buscar o relacionamento para obter os tipos (type_a, type_b)
  const { data: rel } = await supabase
    .from('relationships')
    .select('type_a, type_b')
    .eq('id', relationshipId)
    .single();
  if (!rel) return;

  // 2. Buscar regras para cada tipo
  const [rulesForA, rulesForB] = await Promise.all([
    supabase.from('default_shares').select('*').eq('relationship_type', rel.type_a),
    supabase.from('default_shares').select('*').eq('relationship_type', rel.type_b)
  ]);

  // 3. Precisamos dos IDs numéricos dos donos para consultar os recursos (budgets.user_id é bigint)
  const { data: ownerNumericA } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', authIdA)
    .single();
  const { data: ownerNumericB } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', authIdB)
    .single();

  if (!ownerNumericA?.id || !ownerNumericB?.id) {
    console.error('[applyDefaultShares] Não foi possível encontrar IDs numéricos');
    return;
  }

  // 4. Aplicar regras (A compartilha com B conforme type_a, e vice-versa)
  await shareResourcesByRules(rulesForA.data || [], ownerNumericA.id, authIdB);
  await shareResourcesByRules(rulesForB.data || [], ownerNumericB.id, authIdA);
}

/**
 * Compartilha recursos do owner com o target, baseado nas regras definidas.
 * @param rules - array de regras da tabela default_shares
 * @param ownerNumericId - ID numérico do dono (bigint)
 * @param targetAuthId - auth_user_id do destinatário (UUID)
 */
async function shareResourcesByRules(rules: any[], ownerNumericId: number, targetAuthId: string) {
  for (const rule of rules) {
    // Buscar recursos do owner que atendem ao filtro (se houver)
    let query = supabase
      .from(rule.resource_type)
      .select('id, shared_with')
      .eq('user_id', ownerNumericId);

    if (rule.filter && typeof rule.filter === 'object') {
      Object.entries(rule.filter).forEach(([key, value]) => {
        query = query.eq(key, value);
      });
    }

    const { data: resources } = await query;
    if (!resources?.length) continue;

    for (const res of resources) {
      const currentShared = res.shared_with || [];
      if (!currentShared.includes(targetAuthId)) {
        await supabase
          .from(rule.resource_type)
          .update({ shared_with: [...currentShared, targetAuthId] })
          .eq('id', res.id);
      }
    }
  }
}