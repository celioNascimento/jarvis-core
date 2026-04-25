// middleware.ts — na raiz do projeto
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. Se for login, ignora para evitar loop
  if (pathname.startsWith('/wm/login')) {
    return NextResponse.next()
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh crucial da sessão para manter o token vivo
  const { data: { user } } = await supabase.auth.getUser()

  // 2. Proteção para Rotas de Interface (WEB)
  if (pathname.startsWith('/wm') && !user) {
    const loginUrl = new URL('/wm/login', request.url)
    loginUrl.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // 3. Proteção para API (JSON)
  // Se for API e não tiver usuário, retorna 401 direto em vez de redirect
  if (pathname.startsWith('/api/') && !user) {
    return NextResponse.json({ error: 'Sessão expirada ou inválida' }, { status: 401 })
  }

  return response
}

export const config = {
  // Ajustado para capturar tanto o painel web quanto a API
  matcher: ['/wm/:path*', '/api/:path*'],
}