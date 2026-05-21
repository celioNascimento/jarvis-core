// middleware.ts
// V2.0.0 — Otimizado: getSession() para API (sem roundtrip ao Supabase Auth)
//
// MUDANÇA PRINCIPAL:
//   Rotas /api/* usam getSession() — lê o JWT do cookie localmente, sem chamar
//   /auth/v1/user nem /rest/v1/config. Economiza 2 chamadas externas por turno.
//
//   Rotas /wm/* continuam usando getUser() — validação server-side obrigatória
//   para interface web onde segurança é crítica.
//
// TRADEOFF CONSCIENTE:
//   getSession() confia no JWT sem revalidar com o servidor Auth.
//   Para rotas de API do chat isso é aceitável: o token tem TTL curto (1h)
//   e cada rota de API já valida o usuário via auth_user_id no banco.
//   Se precisar de validação estrita em alguma rota específica, adicione
//   getUser() só nessa rota, não no middleware global.

import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Login — ignora para evitar loop
  if (pathname.startsWith('/wm/login')) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // ── Rotas de API (/api/*) ─────────────────────────────────────────────────
  // getSession() — lê JWT localmente, zero chamadas externas ao Supabase Auth.
  if (pathname.startsWith('/api/')) {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      return NextResponse.json(
        { error: 'Sessão expirada ou inválida' },
        { status: 401 }
      );
    }

    return response;
  }

  // ── Rotas de Interface Web (/wm/*) ────────────────────────────────────────
  // getUser() — validação server-side obrigatória para interface administrativa.
  if (pathname.startsWith('/wm')) {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      const loginUrl = new URL('/wm/login', request.url);
      loginUrl.searchParams.set('redirectTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    return response;
  }

  return response;
}

export const config = {
  matcher: ['/wm/:path*', '/api/:path*'],
};