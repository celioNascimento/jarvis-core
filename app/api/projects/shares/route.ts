// app/api/projects/shares/route.ts
// Motor V1.0.0 — Compartilhamento de Projetos (Padrão Unificado)

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';

// ─── HELPER DE AUTENTICAÇÃO (Mapeia UUID -> BigInt) ──────────────────────────
async function getUserIdFromReq(req: NextRequest): Promise<{ uuid: string; bigintId: number } | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data: authData } = await supabase.auth.getUser(token);
  if (!authData?.user) return null;
  
  const { data: profile } = await supabase
    .schema('jarvis')
    .from('users')
    .select('id')
    .eq('auth_user_id', authData.user.id)
    .single();
    
  return profile ? { uuid: authData.user.id, bigintId: profile.id } : null;
}

// ─── GET OPTIONS (Lista de Parceiros e Status no Projeto) ─────────────────────
export async function GET(req: NextRequest) {
  try {
    const user = await getUserIdFromReq(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const project_id = searchParams.get('project_id');
    if (!project_id) return NextResponse.json({ error: 'project_id ausente' }, { status: 400 });

    // 1. DUAL QUERY (Bypass do erro 42601 para buscar relações)
    const [resA, resB] = await Promise.all([
      supabase.schema('jarvis').from('relationships').select('user_id_a, user_id_b, contact_name').eq('status', 'active').eq('user_id_a', user.uuid),
      supabase.schema('jarvis').from('relationships').select('user_id_a, user_id_b, contact_name').eq('status', 'active').eq('user_id_b', user.uuid)
    ]);

    if (resA.error) throw resA.error;
    if (resB.error) throw resB.error;

    const relationships = [...(resA.data || []), ...(resB.data || [])];
    if (relationships.length === 0) return NextResponse.json({ ok: true, options: [] });

    // 2. Isola UUIDs e traduz para BigInts
    const partnerUUIDs = Array.from(new Set(relationships.map(rel => 
      rel.user_id_a === user.uuid ? rel.user_id_b : rel.user_id_a
    )));

    const { data: partnerUsers, error: usersError } = await supabase
      .schema('jarvis')
      .from('users')
      .select('id, auth_user_id, nickname')
      .in('auth_user_id', partnerUUIDs);

    if (usersError) throw usersError;
    if (!partnerUsers || partnerUsers.length === 0) return NextResponse.json({ ok: true, options: [] });

    const partnerBigintIds = partnerUsers.map(u => u.id);

    // 3. Verifica quem já é membro deste projeto específico
    const { data: members, error: memError } = await supabase
      .schema('jarvis')
      .from('project_members')
      .select('user_id, role')
      .eq('project_id', project_id)
      .in('user_id', partnerBigintIds);

    if (memError) throw memError;

    // Mapa de membros ativos para busca rápida
    const activeMembers = new Map(members?.map(m => [String(m.user_id), m.role]));

    // 4. Monta o payload padronizado para o Modal de Compartilhamento do App
    const options = partnerUsers.map(u => {
      const relDoc = relationships.find(rel => rel.user_id_a === u.auth_user_id || rel.user_id_b === u.auth_user_id);
      return {
        user_id: u.auth_user_id,
        bigint_id: u.id,
        contact_name: relDoc?.contact_name || u.nickname || 'Parceiro',
        is_active: activeMembers.has(String(u.id)),
        role: activeMembers.get(String(u.id)) || null // Expõe o papel (editor, viewer, etc)
      };
    });

    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    console.error('[Project Shares GET] Erro:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ─── POST MUTATION (Toggle de Acesso) ─────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const user = await getUserIdFromReq(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { project_id, shared_with_id, active, role = 'editor' } = await req.json();

    if (!project_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'project_id, shared_with_id e active são obrigatórios' },
        { status: 400 }
      );
    }

    // 1. Valida permissão: Apenas 'owner' ou 'editor' do projeto pode gerenciar membros
    const { data: myMembership, error: memErr } = await supabase
      .schema('jarvis')
      .from('project_members')
      .select('role')
      .eq('project_id', project_id)
      .eq('user_id', user.bigintId)
      .single();

    if (memErr || !myMembership || !['owner', 'editor'].includes(myMembership.role)) {
      return NextResponse.json({ error: 'Permissão negada para compartilhar este projeto' }, { status: 403 });
    }

    // 2. Executa a Ação (Ativar = Inserir/Atualizar | Desativar = Deletar)
    if (active) {
      const { error } = await supabase
        .schema('jarvis')
        .from('project_members')
        .upsert(
          { 
            project_id, 
            user_id: Number(shared_with_id), 
            invited_by: user.bigintId,
            role: role, 
            status: 'active' // No app, assumimos auto-aceitação para parceiros
          },
          { onConflict: 'project_id,user_id' }
        );
      if (error) throw error;
    } else {
      const { error } = await supabase
        .schema('jarvis')
        .from('project_members')
        .delete()
        .eq('project_id', project_id)
        .eq('user_id', Number(shared_with_id));
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Project Shares POST] Erro:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
