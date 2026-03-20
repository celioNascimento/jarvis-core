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
// Mapa visual: cada estante com suas colunas
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
  if (model?.includes('EVERFLO') || model?.includes('EverFlo')) return '#3b82f6'
  if (model?.includes('7F-10W') || model?.includes('10L'))       return '#f59e0b'
  if (model?.includes('8F-5AW') || model?.includes('5L'))        return '#10b981'
  if (model?.includes('COVIDIEN') || model?.includes('Oxí'))     return '#8b5cf6'
  return '#6b7280'
}

function modelLabel(model: string): string {
  if (model?.includes('EVERFLO')) return 'EVF'
  if (model?.includes('7F-10W'))  return 'Y10'
  if (model?.includes('8F-5AW'))  return 'Y5'
  if (model?.includes('COVIDIEN'))return 'OXI'
  return '—'
}

const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('pt-BR') : '—'

// ── Célula da planta ──────────────────────────────────────────
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
  const models = [...new Set(equips.map(e => e.equipment_model?.nickname || e.model).filter(Boolean))]
  const dominantModel = equips.length > 0
    ? (equips[0].equipment_model?.nickname || equips[0].model || '')
    : ''

  // Cor de fundo por ocupação
  const bgColor = total === 0
    ? zone === 'backup' ? '#fdf4ff' : '#f8fafc'
    : zone === 'backup' ? '#ede9fe' : modelColor(dominantModel) + '22'

  const borderColor = selected
    ? '#1d4ed8'
    : total === 0
    ? zone === 'backup' ? '#e9d5ff' : '#e2e8f0'
    : modelColor(dominantModel) + '88'

  const parsed = parseCode(code)

  return (
    <button
      onClick={onClick}
      title={code}
      style={{
        background: bgColor,
        borderColor: borderColor,
        borderWidth: selected ? 2 : 1.5,
        boxShadow: selected ? '0 0 0 3px #bfdbfe' : undefined,
      }}
      className="relative rounded-lg border transition-all duration-150 hover:scale-105 active:scale-95 cursor-pointer flex flex-col items-center justify-center gap-0.5 p-1 min-w-0"
    >
      {/* Nível */}
      <span className="text-[8px] font-black text-gray-400 leading-none">
        N{parsed?.nivel}
      </span>

      {/* Modelo dominante */}
      {total > 0 && (
        <span
          className="text-[9px] font-black leading-none px-1 py-0.5 rounded"
          style={{ color: modelColor(dominantModel), background: modelColor(dominantModel) + '22' }}
        >
          {modelLabel(dominantModel)}
        </span>
      )}

      {/* Contagem */}
      <span className={`text-[10px] font-black leading-none ${total === 0 ? 'text-gray-300' : 'text-gray-700'}`}>
        {total === 0 ? '—' : total}
      </span>

      {/* Bloqueado */}
      {bloqueados > 0 && (
        <div className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center">
          <Lock size={7} className="text-white" />
        </div>
      )}

      {/* Vazio na zona backup */}
      {total === 0 && zone === 'backup' && (
        <div className="absolute inset-0 rounded-lg border-dashed border border-purple-200" />
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white w-full max-w-sm h-full overflow-y-auto shadow-2xl border-l border-gray-100"
        onClick={e => e.stopPropagation()}
        style={{ fontFamily: "'DM Mono', 'JetBrains Mono', monospace" }}
      >
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between z-10">
          <div>
            <p className="text-xl font-black text-gray-900 tracking-tight">{code}</p>
            <p className="text-xs text-gray-400 mt-0.5">{nivelLabel} · {nivelH}m · Estante {parsed?.estante} Col {parsed?.col}</p>
            <span className={`inline-flex items-center gap-1 mt-1.5 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${zone === 'backup' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
              {zone === 'backup' ? <RotateCcw size={8} /> : <Package size={8} />}
              {zone === 'backup' ? 'BACKUP' : 'ESTOQUE'}
            </span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-all">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {equips.length === 0 ? (
            <div className="text-center py-10">
              <div className="w-12 h-12 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-3">
                <Package size={20} className="text-gray-300" />
              </div>
              <p className="text-sm text-gray-400 font-medium">Posição vazia</p>
              <p className="text-xs text-gray-300 mt-1">Nenhum equipamento alocado</p>
            </div>
          ) : (
            equips.map((eq, i) => {
              const nick = eq.equipment_model?.nickname || eq.model
              const mc = modelColor(eq.model)
              return (
                <div
                  key={eq.id}
                  style={{ borderColor: eq.is_blocked ? '#fca5a5' : mc + '44', animationDelay: `${i * 40}ms` }}
                  className="border rounded-2xl p-3.5 space-y-2 animate-in fade-in slide-in-from-right-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        {eq.is_blocked && <Lock size={11} className="text-red-500 shrink-0" />}
                        <span className={`text-base font-black ${eq.is_blocked ? 'text-red-700' : 'text-gray-900'}`}>
                          {eq.asset_number}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{nick}</p>
                    </div>
                    <span
                      className="text-[9px] font-black px-2 py-1 rounded-lg shrink-0"
                      style={{ background: mc + '22', color: mc }}
                    >
                      {modelLabel(eq.model)}
                    </span>
                  </div>

                  {eq.is_blocked && (
                    <div className="flex items-start gap-1.5 p-2 bg-red-50 rounded-xl border border-red-100">
                      <AlertTriangle size={11} className="text-red-500 mt-0.5 shrink-0" />
                      <p className="text-[10px] text-red-600 font-medium">{eq.block_reason}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      ['Lacre', eq.seal_number || '—'],
                      ['Entrada', fmtDate(eq.entry_date || '')],
                    ].map(([l, v]) => (
                      <div key={l} className="bg-gray-50 rounded-lg px-2 py-1.5">
                        <p className="text-[8px] font-black uppercase tracking-widest text-gray-400">{l}</p>
                        <p className="text-xs font-bold text-gray-700 mt-0.5 truncate">{v}</p>
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
  const [viewMode, setViewMode] = useState<'ocupacao' | 'modelo' | 'zona'>('ocupacao')

  useEffect(() => {
    db().from('equipment')
      .select('id, asset_number, model, brand, status, is_backup, is_blocked, block_reason, seal_number, entry_date, location:locations(code), equipment_model:equipment_models(nickname,model)')
      .eq('status', 'lastro')
      .then(({ data }) => {
        // CORREÇÃO AQUI: Avisamos o TypeScript que podemos confiar nesse formato de dados.
        // O `as unknown as Equip[]` resolve a reclamação do compilador.
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

  // Estatísticas
  const totalEquips  = equipment.length
  const totalVazios  = ESTANTES.reduce((s, est) =>
    s + est.cols * LEVELS.length - LEVELS.reduce((ls, lv) =>
      ls + (byLocation(`SL-${est.id}1-N${lv.n}`).length > 0 ? 1 : 0) +
           (est.cols >= 2 && byLocation(`SL-${est.id}2-N${lv.n}`).length > 0 ? 1 : 0) +
           (est.cols >= 3 && byLocation(`SL-${est.id}3-N${lv.n}`).length > 0 ? 1 : 0) +
           (est.cols >= 4 && byLocation(`SL-${est.id}4-N${lv.n}`).length > 0 ? 1 : 0)
    , 0), 0)
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
          { color: '#8b5cf6', label: 'Oxímetro' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5 shrink-0">
            <div className="w-3 h-3 rounded" style={{ background: color }} />
            <span className="text-[9px] text-slate-400">{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-3 h-3 rounded border border-dashed border-purple-400 bg-purple-950" />
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

        {/* Porta */}
        <div className="flex items-center gap-2 mb-2">
          <div className="h-px flex-1 bg-slate-800" />
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-full">
            <div className="w-4 h-4 rounded border-2 border-slate-500 bg-slate-700" />
            <span className="text-[9px] text-slate-400 uppercase tracking-widest">Porta de Entrada</span>
          </div>
          <div className="h-px flex-1 bg-slate-800" />
        </div>

        {/* Estantes */}
        {ESTANTES.map(est => (
          <div key={est.id} className="space-y-2">
            {/* Label da estante */}
            <div className="flex items-center gap-3">
              <div className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${est.zone === 'backup' ? 'bg-purple-900 text-purple-300 border border-purple-700' : 'bg-blue-900 text-blue-300 border border-blue-700'}`}>
                {est.zone === 'backup' ? '⚠ ' : ''}{est.label}
              </div>
              <span className="text-[9px] text-slate-600">{est.width}</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            {/* Grid de células */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-3 overflow-x-auto">
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `40px repeat(${est.cols}, minmax(60px, 1fr))` }}
              >
                {/* Header colunas */}
                <div />
                {Array.from({ length: est.cols }, (_, i) => (
                  <div key={i} className="text-center text-[9px] font-black text-slate-500 uppercase tracking-widest pb-1">
                    Col {i + 1}
                    {i + 1 === est.cols && <span className="text-slate-600 ml-1">(porta)</span>}
                  </div>
                ))}

                {/* Linhas por nível */}
                {LEVELS.map(lv => (
                  <>
                    {/* Label nível */}
                    <div key={`lbl-${lv.n}`} className="flex flex-col items-end justify-center pr-2">
                      <span className="text-[8px] font-black text-slate-500">{lv.label}</span>
                      <span className="text-[7px] text-slate-700">{lv.h}m</span>
                    </div>

                    {/* Células */}
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
                  </>
                ))}
              </div>
            </div>
          </div>
        ))}

        {/* Ilha D */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest bg-slate-800 text-slate-400 border border-slate-700">
              Ilha — Parede D
            </div>
            <span className="text-[9px] text-slate-600">1,83m × 1,64m · uso misto</span>
            <div className="h-px flex-1 bg-slate-800" />
          </div>
          <div className="bg-slate-900 rounded-2xl border border-slate-800 p-3">
            <div className="grid gap-1.5" style={{ gridTemplateColumns: '40px 1fr' }}>
              <div />
              <div className="text-center text-[9px] font-black text-slate-500 uppercase tracking-widest pb-1">Chão</div>
              <div className="flex flex-col items-end justify-center pr-2">
                <span className="text-[8px] font-black text-slate-500">Chão</span>
                <span className="text-[7px] text-slate-700">0,00m</span>
              </div>
              <PlantaCell
                code="SL-D1-N0"
                zone="estoque"
                equips={byLocation('SL-D1-N0')}
                selected={selected === 'SL-D1-N0'}
                onClick={() => setSelected(selected === 'SL-D1-N0' ? null : 'SL-D1-N0')}
              />
            </div>
          </div>
        </div>

        {/* Rodapé */}
        <p className="text-center text-[9px] text-slate-700 pt-2">
          Clique em qualquer posição para ver os equipamentos · Sala de Lastro · White Martins Londrina
        </p>
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
