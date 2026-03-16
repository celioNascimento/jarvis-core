// app/api/wm/debug/route.ts
// REMOVER após resolver o problema

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET() {
  const results: any = {}

  // 1. Verifica variáveis de ambiente
  results.env = {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }

  // 2. Testa service role no schema jarvis (já funciona no webhook)
  try {
    const jarvis = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'jarvis' } }
    )
    const { data, error } = await jarvis.from('users').select('id').limit(1)
    results.jarvis_service_role = error ? `ERRO: ${error.message}` : `OK (${data?.length} rows)`
  } catch (e: any) {
    results.jarvis_service_role = `EXCEPTION: ${e.message}`
  }

  // 3. Testa service role no schema white_martins
  try {
    const wm = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'white_martins' } }
    )
    const { data, error } = await wm.from('equipment').select('id').limit(1)
    results.wm_service_role = error ? `ERRO: ${error.message}` : `OK (${data?.length} rows)`
  } catch (e: any) {
    results.wm_service_role = `EXCEPTION: ${e.message}`
  }

  // 4. Testa anon key no schema white_martins (sem auth)
  try {
    const wm_anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { db: { schema: 'white_martins' } }
    )
    const { data, error } = await wm_anon.from('equipment').select('id').limit(1)
    results.wm_anon_no_auth = error ? `ERRO: ${error.message}` : `OK (${data?.length} rows)`
  } catch (e: any) {
    results.wm_anon_no_auth = `EXCEPTION: ${e.message}`
  }

  // 5. Verifica sessão do usuário atual via cookies
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
    )
    const { data: { user }, error } = await supabase.auth.getUser()
    results.session = error ? `ERRO: ${error.message}` : user ? `OK (${user.email})` : 'Sem sessão'
  } catch (e: any) {
    results.session = `EXCEPTION: ${e.message}`
  }

  // 6. Testa anon key COM token de sessão server-side
  try {
    const cookieStore = await cookies()
    const serverAuth = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
    )
    const { data: { session } } = await serverAuth.auth.getSession()

    if (session?.access_token) {
      const wm_with_token = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          db: { schema: 'white_martins' },
          global: { headers: { Authorization: `Bearer ${session.access_token}` } }
        }
      )
      const { data, error } = await wm_with_token.from('equipment').select('id').limit(1)
      results.wm_with_session_token = error ? `ERRO: ${error.message}` : `OK (${data?.length} rows)`
    } else {
      results.wm_with_session_token = 'Sem token de sessão'
    }
  } catch (e: any) {
    results.wm_with_session_token = `EXCEPTION: ${e.message}`
  }

  return NextResponse.json(results, { status: 200 })
}
