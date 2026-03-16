'use client'

import { createClient } from '@supabase/supabase-js'

export default function LoginButton() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const handleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        queryParams: {
          access_type: 'offline',
          prompt: 'consent', // Força a tela de permissão do Google
        },
        // Agenda + Gmail Readonly
        scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly'
      }
    })
  }

  return (
    <button 
      onClick={handleLogin}
      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded transition-all shadow-lg shadow-blue-900/20 uppercase tracking-widest"
    >
      Atualizar Acesso Google
    </button>
  )
}