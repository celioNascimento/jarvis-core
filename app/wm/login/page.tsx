'use client'
export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { useRouter } from 'next/navigation'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { storageKey: 'wm-auth' } }
  )
}

export default function WMLogin() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const login = async () => {
    if (!email || !password) { setError('Preencha email e senha.'); return }
    setLoading(true)
    setError('')

    const supabase = getSupabase()
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)
    if (err) {
      setError('Email ou senha incorretos.')
      return
    }

    // Redireciona para a página que tentou acessar, ou /wm
    const params = new URLSearchParams(window.location.search)
    const redirectTo = params.get('redirectTo') || '/wm'
    router.push(redirectTo)
    router.refresh()
  }

  const input = "w-full px-4 py-3.5 rounded-2xl border border-slate-200 text-sm font-medium text-slate-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="h-20 flex items-center justify-center mx-auto mb-2">
            <img src="/logo_wm.png" alt="White Martins" className="h-full w-auto object-contain" />
          </div>
          <p className="text-slate-400 text-xs uppercase tracking-widest">Lab. de Instrumentação</p>
        </div>

        {/* Card */}
        <div className="bg-slate-50 rounded-3xl p-6 shadow-sm border border-slate-200 space-y-4">
          <div>
            <h2 className="text-lg font-black text-slate-900">Acesso restrito</h2>
            <p className="text-xs text-slate-500 mt-0.5">Use suas credenciais corporativas</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && login()}
                className={input}
                placeholder="seu@email.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Senha</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && login()}
                  className={input + ' pr-12'}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <button
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
              <AlertTriangle size={13} className="text-red-500 shrink-0" />
              <p className="text-xs text-red-600 font-medium">{error}</p>
            </div>
          )}

          <button
            onClick={login}
            disabled={loading}
            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60 shadow-lg shadow-blue-200">
            {loading ? 'Entrando...' : 'Entrar'}
          </button>

          <p className="text-center text-[10px] text-slate-400">
            Acesso permitido apenas para usuários autorizados
          </p>
        </div>
      </div>
    </div>
  )
}