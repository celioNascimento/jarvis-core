// app/api/user/search/route.ts
//
// Responsabilidade única: autenticar, delegar ao service, retornar JSON.
// Zero lógica de query, zero lógica de formatação.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis';
import { isPhone } from '@/lib/Utils/string';
import { searchByPhone, searchByName } from '@/lib/services/user-search.service';

// ── Auth ──────────────────────────────────────────────────────────────────────

function extractToken(req: Request): string | undefined {
  return req.headers.get('authorization')?.replace('Bearer ', '') ?? undefined;
}

async function getAuthUUID(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const token = extractToken(req);
  const authUUID = await getAuthUUID(token);

  if (!authUUID) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';

  if (q.length < 2) {
    return NextResponse.json({ users: [] });
  }

  try {
    const users = isPhone(q)
      ? await searchByPhone(q, authUUID)
      : await searchByName(q, authUUID);

    return NextResponse.json({ users });
  } catch (e: any) {
    console.error('[/api/user/search]', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}