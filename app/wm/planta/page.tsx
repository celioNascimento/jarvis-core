'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import { X, AlertTriangle, Lock, Package, RotateCcw, ChevronRight } from 'lucide-react'

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'white_martins' }, auth: { storageKey: 'wm-auth' } }
  )
}

// ── Tipos ─────────────────────────────────────────────────────
type Equip = {
  id: string
  asset_number: string
  model: string
  brand: string
  status: string
  is_backup: boolean
  is_blocked: boolean
  block_reason?: string
  seal_number?: string
  entry_date?: string
  location?: { code: string }
  equipment_model?: { nickname: string; model: string }
}

type Cell = {
  code: string        // ex: SL-A1-N0
  estante: string     // A / B / C / D
  col: number
  nivel: number
  zone: 'estoque' | 'backup'
  height: number      // metros
}

// ── Layout da sala ────────────────────────────────────────────
const LEVELS = [
  { n: 4, label: '4º', h: 1.82 },
  { n: 3, label: '3º', h: 1.54 },
  { n: 2, label: '2º', h: 1.26 },
  { n: 1, label: '1º', h: 0.67 },
  { n: 0, label: 'Chão', h: 0.00 },
]

const ESTANTES = [
  { id: 'A', cols: 4, zone: 'estoque' as const, label: 'Estante A', width: '5m' },
  { id: 'B', cols: 2, zone: 'estoque' as const, label: 'Estante B', width: '3,53m' },
  { id: 'C', cols: 2, zone: 'backup'  as const, label: 'Estante C — Backup', width: '3,53m' },
]

function parseCode(code: string) {
  const m = code.match(/SL-([A-Z])(\d)-N(\d)/)
  if (!m) return null
  return { estante: m[1], col: Number(m[2]), nivel: Number(m[3]) }
}

function modelColor(model: string): string {
  if (model?.includes('EVERFLO') || model?.includes('EverFlo')) return '#3b82f6' // Azul
  if (model?.includes('7F-10W') || model?.includes('10L'))       return '#f59e0b' // Laranja
  if (model?.includes('8F-5AW') || model?.includes('5L'))        return '#10b981' // Verde
  if (model?.includes('COVIDIEN') || model?.includes('Oxí'))     return '#a855f7' // Roxo claro
  return '#64748b' // Slate 500
}

function modelLabel(model: string): string {
  if (model?.includes('EVERFLO')) return 'EVF'
  if (model?.includes('7F-10W'))  return 'Y10'
  if (model?.includes('8F-5AW'))  return 'Y5'
  if (model?.includes('COVIDIEN'))return 'OXI'
  return '—'
}

const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('pt-BR') : '—'

// ── Célula da planta (Refatorada para o Dark Mode) ────────────
function PlantaCell({
  code, zone, equips, selected, onClick
}: {
  code: string
  zone: 'estoque' | 'backup'
  equips: Equip[]
  selected: boolean
  onClick: () => void
}) {
  const total = equips.length
  const bloqueados = equips.filter(e => e.is_blocked).length
  const dominantModel = equips.length > 0
    ? (equips[0].equipment_model?.nickname || equips[0].model || '')
    : ''

  const baseColor = modelColor(dominantModel)

  // Cores adaptadas para fundo escuro. 
  // O final '1A' e '33' representam níveis de transparência (alfa) em código Hexadecimal.
  const bgColor = total === 0
    ? 'transparent' // Vazio fica da cor do fundo
    : baseColor + '1A' // 10% de opacidade da cor do modelo

  const borderColor = selected
    ? '#3b82f6' // Azul de seleção
    : total === 0
    ? (zone === 'backup' ? '#4c1d95' : '#1e293b') // Roxo escuro para backup, Cinza escuro para estoque
    : baseColor + '66' // 40% de opacidade da cor

  return (
    <button
      onClick={onClick}
      title={code}
      style={{
        background: bgColor,
        borderColor: borderColor,
        borderWidth: selected ? 2 : 1,
        boxShadow: selected ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : undefined,
      }}
      className={`relative rounded-md border transition-all duration-150 cursor-pointer flex flex-col items-center justify-center p-1 min-h-[44px] ${
        selected ? 'scale-105 z-10' : 'hover:scale-105 hover:z-10 active:scale-95'
      }`}
    >
      {/* Quando há itens, focamos no modelo e na contagem limpa */}
      {total > 0 ? (
        <>
          <span 
            className="text-[9px] font-black uppercase tracking-wider mb-0.5"
            style={{ color: baseColor }}
          >
            {modelLabel(dominantModel)}
          </span>
          <span className="text-sm font-black text-slate-100 leading-none">
            {total}
          </span>
        </>
      ) : (
        /* Quando vazio na zona backup, mostramos apenas uma textura pontilhada sutil */
        zone === 'backup' && (
          <div className="absolute inset-0 rounded-md border-dashed border border-purple-900/40" />
        )
      )}

      {/* Bloqueado */}
      {bloqueados > 0 && (
        <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center shadow shadow-red-900">
          <Lock size={8} className="text-white" />
        </div>
      )}
    </button>
  )
}

// ── Drawer de equipamentos ────────────────────────────────────
function Drawer({ code, equips, zone, onClose }: {
  code: string
  equips: Equip[]
  zone: 'estoque' | 'backup'
  onClose: () => void
}) {
  const parsed = parseCode(code)
  const nivelLabel = ['Chão', '1º Nível', '2º Nível', '3º Nível', '4º Nível'][parsed?.nivel ?? 0]
  const nivelH = [0.00, 0.67, 1.26, 1.54, 1.82][parsed?.nivel ?? 0]

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      {/* Oculta os itens do drawer... */}
      <div
        className="bg-slate-900 w-full max-w-sm h-full overflow-y-auto shadow-2xl border-l border-slate-800"
        onClick={e => e.stopPropagation()}
        style={{ fontFamily: "'DM Mono', 'JetBrains Mono', monospace" }}
      >
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-5 py-4 flex items-start justify-between z-10">
          <div>
            <p className="text-xl font-black text-slate-100 tracking-tight">{code}</p>
            <p className="text-xs text-slate-400 mt-0.5">{nivelLabel} · {nivelH}m · Estante {parsed?.estante} Col {parsed?.col}</p>
            <span className={`inline-flex items-center gap-1 mt-1.5 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${zone === 'backup' ? 'bg-purple-900/30 text-purple-400 border-purple-800' : 'bg-blue-900/30 text-blue-400 border-blue-800'}`}>
              {zone === 'backup' ? <RotateCcw size={8} /> : <Package size={8} />}
              {zone === 'backup' ? 'BACKUP' : 'ESTOQUE'}
            </span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 hover:bg-slate-700 hover:text-white transition-all">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {equips.length === 0 ? (
            <div className="text-center py-10">
              <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-3">
                <Package size={20} className="text-slate-600" />
              </div>
              <p className="text-sm text-slate-400 font-medium">Posição vazia</p>
              <p className="text-xs text-slate-500 mt-1">Nenhum equipamento alocado</p>
            </div>
          ) : (
            equips.map((eq, i) => {
              const nick = eq.equipment_model?.nickname || eq.model
              const mc = modelColor(eq.model)
              return (
                <div
                  key={eq.id}
                  style={{ borderColor: eq.is_blocked ? '#991b1b' : mc + '40', animationDelay: `${i * 40}ms` }}
                  className="border rounded-2xl p-3.5 space-y-2 animate-in fade-in slide-in-from-right-2 bg-slate-800/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        {eq.is_blocked && <Lock size={11} className="text-red-500 shrink-0" />}
                        <span className={`text-base font-black ${eq.is_blocked ? 'text-red-400' : 'text-slate-200'}`}>
                          {eq.asset_number}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{nick}</p>
                    </div>
                    <span
                      className="text-[9px] font-black px-2 py-1 rounded-lg shrink-0 border"
                      style={{ background: mc + '1A', color: mc, borderColor: mc + '40' }}
                    >
                      {modelLabel(eq.model)}
                    </span>
                  </div>

                  {eq.is_blocked && (
                    <div className="flex items-start gap-1.5 p-2 bg-red-950/30 rounded-xl border border-red-900/50">
                      <AlertTriangle size={11} className="text-red-500 mt-0.5 shrink-0" />
                      <p className="text-[10px] text-red-300 font-medium">{eq.block_reason}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      ['Lacre', eq.seal_number || '—'],
                      ['Entrada', fmtDate(eq.entry_date || '')],
                    ].map(([l, v]) => (
                      <div key={l} className="bg-slate-900/50 rounded-lg px-2 py-1.5 border border-slate-800">
                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">{l}</p>
                        <p className="text-xs font-bold text-slate-300 mt-0.5 truncate">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────
export default function PlantaLastro() {
  const [equipment, setEquipment] = useState<Equip[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    db().from('equipment')
      .select('id, asset_number, model, brand, status, is_backup, is_blocked, block_reason, seal_number, entry_date, location:locations(code), equipment_model:equipment_models(nickname,model)')
      .eq('status', 'lastro')
      .then(({ data }) => {
        setEquipment((data as unknown as Equip[]) || [])
        setLoading(false)
      })
  }, [])

  const byLocation = (code: string) =>
    equipment.filter(e => e.location?.code === code)

  const selectedEquips = selected ? byLocation(selected) : []
  const selectedZone = selected
    ? (ESTANTES.find(e => selected.startsWith(`SL-${e.id}`))?.zone ?? 'estoque')
    : 'estoque'

  const totalEquips  = equipment.length
  const bloqueados   = equipment.filter(e => e.is_blocked).length

  if (loading) return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="space-y-3 text-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs font-mono text-slate-500 uppercase tracking-widest">Carregando sala...</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-950 text-white" style={{ fontFamily: "'DM Mono', 'Courier New', monospace" }}>

      {/* Header */}
      <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-black uppercase tracking-widest text-slate-200">Sala de Lastro</h1>
          <p className="text-xs text-slate-500 mt-0.5">Planta Baixa Interativa · Londrina</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-black text-white leading-none">{totalEquips}</p>
            <p className="text-[9px] text-slate-500 uppercase tracking-widest">equipamentos</p>
          </div>
          {bloqueados > 0 && (
            <div className="text-right">
              <p className="text-2xl font-black text-red-400 leading-none">{bloqueados}</p>
              <p className="text-[9px] text-slate-500 uppercase tracking-widest">bloqueados</p>
            </div>
          )}
        </div>
      </div>

      {/* Legenda */}
      <div className="px-6 py-3 flex items-center gap-4 border-b border-slate-800 overflow-x-auto">
        <span className="text-[9px] text-slate-500 uppercase tracking-widest shrink-0">Legenda:</span>
        {[
          { color: '#3b82f6', label: 'EVERFLO 5L' },
          { color: '#f59e0b', label: 'Yuwell 10L' },
          { color: '#10b981', label: 'Yuwell 5L' },
          { color: '#a855f7', label: 'Oxímetro' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5 shrink-0">
            <div className="w-3 h-3 rounded" style={{ background: color }} />
            <span className="text-[9px] text-slate-400">{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-3 h-3 rounded border border-dashed border-purple-900/50 bg-transparent" />
          <span className="text-[9px] text-slate-400">Backup vazio</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-3 h-3 rounded bg-red-500 flex items-center justify-center">
            <Lock size={6} className="text-white" />
          </div>
          <span className="text-[9px] text-slate-400">Bloqueado</span>
        </div>
      </div>

      {/* Planta */}
      <div className="p-6 space-y-6 overflow-x-auto">
        {/* Estantes */}
        {ESTANTES.map(est => (
          <div key={est.id} className="space-y-2">
            <div className="flex items-center gap-3">
              <div className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${est.zone === 'backup' ? 'bg-purple-900/40 text-purple-400 border border-purple-800' : 'bg-slate-800 text-slate-300 border border-slate-700'}`}>
                {est.zone === 'backup' ? '⚠ ' : ''}{est.label}
              </div>
              <span className="text-[9px] text-slate-600">{est.width}</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-3 overflow-x-auto">
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `40px repeat(${est.cols}, minmax(48px, 1fr))` }}
              >
                <div />
                {Array.from({ length: est.cols }, (_, i) => (
                  <div key={i} className="text-center text-[9px] font-black text-slate-500 uppercase tracking-widest pb-1">
                    Col {i + 1}
                  </div>
                ))}

                {LEVELS.map(lv => (
                  <div className="contents" key={`row-${est.id}-${lv.n}`}>
                    <div className="flex flex-col items-end justify-center pr-2">
                      <span className="text-[9px] font-black text-slate-400">{lv.label}</span>
                      <span className="text-[7px] text-slate-600">{lv.h}m</span>
                    </div>

                    {Array.from({ length: est.cols }, (_, i) => {
                      const code = `SL-${est.id}${i + 1}-N${lv.n}`
                      const equips = byLocation(code)
                      return (
                        <PlantaCell
                          key={code}
                          code={code}
                          zone={est.zone}
                          equips={equips}
                          selected={selected === code}
                          onClick={() => setSelected(selected === code ? null : code)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Drawer */}
      {selected && (
        <Drawer
          code={selected}
          equips={selectedEquips}
          zone={selectedZone}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
