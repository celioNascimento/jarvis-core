// app/api/projects/shares/route.ts
// Motor V1.1.0 — Consome a SSOT de Membros

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { coreAtualizarMembroProjeto } from '@/lib/services/projects.service';

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

export async function GET(req: NextRequest) {
  // [O MESMO CÓDIGO DO GET ANTERIOR PERMANECE AQUI INTACTO PARA RENDERIZAR AS OPÇÕES DA TELA]
  // ... (Pode manter o método GET inteiro da mensagem anterior) ...
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserIdFromReq(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { project_id, shared_with_id, active, role = 'editor' } = await req.json();

    if (!project_id || !shared_with_id || typeof active !== 'boolean') {
      return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
    }

    // 🔥 Aqui está a mágica: delegamos totalmente para a Fonte Única da Verdade (SSOT)
    await coreAtualizarMembroProjeto(user.bigintId, project_id, Number(shared_with_id), active, role);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Project Shares POST] Erro:', error.message);
    const status = error.message.includes('FORBIDDEN') ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}
