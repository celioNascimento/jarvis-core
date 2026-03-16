'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Package, MapPin, Wrench, AlertTriangle, CheckCircle,
  Clock, Plus, Search, Activity, Archive, RotateCcw,
  Trash2, X, Zap, ArrowRight, Droplets, ChevronRight,
  FileText, Download, LogOut, Scan, History, BarChart2,
  Menu, ChevronDown
} from 'lucide-react'

// Um único cliente compartilhado — mantém sessão entre chamadas
let _client: any = null
let _dbClient: any = null

function authClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return _client
}

function db() {
  if (!_dbClient) {
    _dbClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { db: { schema: 'white_martins' } }
    )
  }
  return _dbClient
}
async function logout() {
  await authClient().auth.signOut()
  window.location.href = '/wm/login'
}

// ── Status ────────────────────────────────────────────────
const S: Record<string, { label: string; short: string; color: string; bg: string; border: string; dot: string; icon: any; next: string[] }> = {
  entrada:            { label: 'Entrada',       short: 'ENT',  color: '#92400e', bg: '#fffbeb', border: '#fde68a', dot: '#f59e0b', icon: Package,      next: ['avaliacao_bancada'] },
  avaliacao_bancada:  { label: 'Bancada',        short: 'BAN',  color: '#9a3412', bg: '#fff7ed', border: '#fed7aa', dot: '#f97316', icon: Activity,     next: ['limpeza','aguardando_pecas','manutencao_externa','descarte'] },
  aguardando_pecas:   { label: 'Ag. Peças',      short: 'PEÇ',  color: '#713f12', bg: '#fefce8', border: '#fef08a', dot: '#eab308', icon: Clock,        next: ['limpeza','manutencao_externa','descarte'] },
  limpeza:            { label: 'Limpeza',         short: 'LIM',  color: '#155e75', bg: '#ecfeff', border: '#a5f3fc', dot: '#06b6d4', icon: Droplets,     next: ['lastro','backup','descarte'] },
  manutencao_externa: { label: 'Manutenção',      short: 'MAN',  color: '#7f1d1d', bg: '#fef2f2', border: '#fecaca', dot: '#ef4444', icon: Wrench,       next: ['limpeza','lastro','descarte'] },
  lastro:             { label: 'Lastro',          short: 'LAS',  color: '#1e3a8a', bg: '#eff6ff', border: '#bfdbfe', dot: '#3b82f6', icon: Archive,      next: ['backup','aplicado','descarte'] },
  backup:             { label: 'Backup',          short: 'BAK',  color: '#4c1d95', bg: '#f5f3ff', border: '#ddd6fe', dot: '#8b5cf6', icon: RotateCcw,    next: ['lastro','aplicado','descarte'] },
  aplicado:           { label: 'Aplicado',        short: 'APL',  color: '#14532d', bg: '#f0fdf4', border: '#bbf7d0', dot: '#22c55e', icon: CheckCircle,  next: ['limpeza','manutencao_externa','descarte'] },
  descarte:           { label: 'Descarte',        short: 'DESC', color: '#374151', bg: '#f9fafb', border: '#e5e7eb', dot: '#9ca3af', icon: Trash2,       next: [] },
}

const PART_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  novo:            { label: 'Novo',            color: '#14532d', bg: '#f0fdf4' },
  ok:              { label: 'OK',              color: '#1e3a8a', bg: '#eff6ff' },
  meia_vida:       { label: 'Meia Vida',       color: '#713f12', bg: '#fefce8' },
  necessita_troca: { label: 'Necessita Troca', color: '#7f1d1d', bg: '#fef2f2' },
  sem_estoque:     { label: 'Sem Estoque',     color: '#374151', bg: '#f3f4f6' },
}

function Badge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const cfg = S[status]; if (!cfg) return null
  const Icon = cfg.icon
  return (
    <span style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border }}
      className={`inline-flex items-center gap-1 border rounded-full font-bold uppercase tracking-wider whitespace-nowrap ${size === 'sm' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'}`}>
      <Icon size={size === 'sm' ? 8 : 9} />{cfg.label}
    </span>
  )
}

function StatCard({ label, value, color, bg, active, onClick }: any) {
  return (
    <button onClick={onClick}
      className={`rounded-2xl p-3 sm:p-4 text-left transition-all hover:shadow-md border-2 w-full ${active ? 'border-gray-900 shadow-md' : 'border-transparent'}`}
      style={{ background: bg }}>
      <p className="text-2xl sm:text-3xl font-black leading-none" style={{ color }}>{value}</p>
      <p className="text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-gray-400 mt-1">{label}</p>
    </button>
  )
}

const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('pt-BR') : '—'
const inp = "w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none transition-all font-medium"
const lbl = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5"

// ── Modal Nova Entrada ────────────────────────────────────
function ModalEntrada({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ asset_number: '', serial_number: '', client_number: '', model_id: '', status: 'entrada', location_code: '', is_backup: false, backup_for: '', notes: '', entry_date: new Date().toISOString().slice(0, 10) })
  const [models, setModels] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showNovoMod, setShowNovoMod] = useState(false)
  const [novoMod, setNovoMod] = useState({ brand: '', model: '', nickname: '', equipment_type: '', measure_unit: '' })

  useEffect(() => {
    Promise.all([
      db().from('equipment_models').select('*').order('nickname').order('brand'),
      db().from('locations').select('id,code,area,description').eq('active', true).order('code')
    ]).then(([m, l]) => { setModels(m.data || []); setLocations(l.data || []) })
  }, [])

  const modelSel = models.find(m => m.id === form.model_id)
  const modelsFilt = models.filter(m => !modelSearch || [m.brand, m.model, m.nickname, m.equipment_type].some(v => v?.toLowerCase().includes(modelSearch.toLowerCase())))

  const [salvandoMod, setSalvandoMod] = useState(false)
  const [modSalvo, setModSalvo] = useState(false)

  const salvarMod = async () => {
    if (!novoMod.brand || !novoMod.model) return
    setSalvandoMod(true)
    const { data, error } = await db().from('equipment_models').insert(novoMod).select().single()
    setSalvandoMod(false)
    if (error) { alert(error.message); return }
    if (data) {
      setModels(p => [...p, data])
      setForm(f => ({...f, model_id: data.id}))
      setModSalvo(true)
      setTimeout(() => { setModSalvo(false); setShowNovoMod(false) }, 1000)
    }
  }

  const salvar = async () => {
    if (!form.asset_number.trim()) { setError('Número de patrimônio obrigatório'); return }
    setLoading(true)
    const loc = locations.find(l => l.code === form.location_code)
    const mod = models.find(m => m.id === form.model_id)
    const { error: err } = await db().from('equipment').insert({
      asset_number: form.asset_number.trim(), serial_number: form.serial_number || null,
      client_number: form.client_number || null, model_id: form.model_id || null,
      brand: mod?.brand || null, model: mod?.model || null,
      equipment_type: mod?.equipment_type || null, measure_unit: mod?.measure_unit || null,
      status: form.status, location_id: loc?.id || null,
      is_backup: form.is_backup, backup_for: form.backup_for || null,
      notes: form.notes || null, entry_date: form.entry_date,
    })
    setLoading(false)
    if (err) { setError(err.code === '23505' ? 'Patrimônio já cadastrado.' : err.message); return }
    onSaved(); onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center justify-between rounded-t-3xl z-10">
          <div>
            <h2 className="text-base font-black text-gray-900">Nova Entrada</h2>
            <p className="text-xs text-gray-400">Registro de chegada ao laboratório</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center"><X size={14} /></button>
        </div>
        <div className="px-5 py-5 space-y-5">
          {/* 1. ID */}
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400">
              <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">1</span>
              Identificação
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={lbl}>Nº Patrimônio *</label>
                <input autoFocus value={form.asset_number} onChange={e => setForm({...form, asset_number: e.target.value})} className={inp + ' font-black text-base'} placeholder="Ex: 001234" />
              </div>
              <div><label className={lbl}>Série</label><input value={form.serial_number} onChange={e => setForm({...form, serial_number: e.target.value})} className={inp} placeholder="S/N" /></div>
              <div><label className={lbl}>Nº Cliente</label><input value={form.client_number} onChange={e => setForm({...form, client_number: e.target.value})} className={inp} /></div>
            </div>
          </div>

          {/* 2. Modelo */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400">
                <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">2</span>
                Modelo
              </p>
              <button onClick={() => setShowNovoMod(!showNovoMod)} className="text-[10px] font-black text-blue-600 flex items-center gap-1"><Plus size={10} />Novo</button>
            </div>
            {showNovoMod && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input value={novoMod.brand} onChange={e => setNovoMod({...novoMod, brand: e.target.value})} className={inp} placeholder="Marca *" />
                  <input value={novoMod.model} onChange={e => setNovoMod({...novoMod, model: e.target.value})} className={inp} placeholder="Modelo *" />
                  <input value={novoMod.nickname} onChange={e => setNovoMod({...novoMod, nickname: e.target.value})} className={inp + ' col-span-2'} placeholder="Apelido (ex: concentrador)" />
                  <input value={novoMod.equipment_type} onChange={e => setNovoMod({...novoMod, equipment_type: e.target.value})} className={inp} placeholder="Tipo" />
                  <input value={novoMod.measure_unit} onChange={e => setNovoMod({...novoMod, measure_unit: e.target.value})} className={inp} placeholder="Unidade" />
                </div>
                <button onClick={salvarMod} disabled={salvandoMod || modSalvo}
                  className={`w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${modSalvo ? 'bg-green-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60'}`}>
                  {modSalvo ? '✓ Modelo salvo!' : salvandoMod ? 'Salvando...' : 'Salvar modelo'}
                </button>
              </div>
            )}
            {modelSel ? (
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-2xl">
                <CheckCircle size={14} className="text-green-600 shrink-0" />
                <div className="flex-1"><p className="text-sm font-black text-green-800">{modelSel.nickname || modelSel.equipment_type}</p><p className="text-[11px] text-green-600">{modelSel.brand} {modelSel.model}{modelSel.measure_unit ? ` · ${modelSel.measure_unit}` : ''}</p></div>
                <button onClick={() => setForm({...form, model_id: ''})}><X size={12} className="text-green-400" /></button>
              </div>
            ) : (
              <div className="border border-gray-200 rounded-2xl overflow-hidden">
                <div className="relative border-b border-gray-100">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} className="w-full pl-9 pr-4 py-2.5 text-sm outline-none" placeholder="Buscar apelido, marca..." />
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {modelsFilt.length === 0 ? <p className="p-3 text-xs text-gray-400 text-center">{models.length === 0 ? 'Nenhum modelo.' : 'Sem resultados.'}</p>
                  : modelsFilt.slice(0,12).map(m => (
                    <button key={m.id} onClick={() => { setForm({...form, model_id: m.id}); setModelSearch('') }}
                      className="w-full px-4 py-2.5 text-left hover:bg-gray-50 flex items-center gap-2 border-b border-gray-50 last:border-0">
                      <span className="text-sm font-bold text-gray-800">{m.nickname || m.equipment_type || '—'}</span>
                      <span className="text-xs text-gray-400">{m.brand} {m.model}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3. Destino */}
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400">
              <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">3</span>
              Destino Inicial
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {(['entrada','avaliacao_bancada','aguardando_pecas','limpeza','manutencao_externa'] as const).map(s => {
                const cfg = S[s]; const Icon = cfg.icon; const sel = form.status === s
                return (
                  <button key={s} onClick={() => setForm({...form, status: s})}
                    style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 transition-all ${sel ? '' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                    <Icon size={16} /><span className="text-[9px] font-black uppercase leading-tight text-center">{cfg.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 4. Detalhes */}
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-300">
              <span className="w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[9px] flex items-center justify-center font-black">4</span>
              Detalhes opcionais
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className={lbl}>Endereço</label>
                <select value={form.location_code} onChange={e => setForm({...form, location_code: e.target.value})} className={inp}>
                  <option value="">— Sem endereço —</option>
                  {['sala_lastro','container','armario','externo'].map(area => (
                    <optgroup key={area} label={area.replace('_',' ').toUpperCase()}>
                      {locations.filter(l => l.area === area).map(l => <option key={l.id} value={l.code}>{l.code} — {l.description}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className={lbl}>Data de entrada</label>
                <input type="date" value={form.entry_date} onChange={e => setForm({...form, entry_date: e.target.value})} className={inp} />
              </div>
            </div>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
              className={inp + ' resize-none'} rows={2} placeholder="Estado do equipamento, itens faltando..." />
            <label className="flex items-center gap-3 p-3 rounded-2xl bg-gray-50 border border-gray-200 cursor-pointer">
              <input type="checkbox" checked={form.is_backup} onChange={e => setForm({...form, is_backup: e.target.checked})} className="w-4 h-4 accent-blue-600" />
              <span className="text-sm font-semibold text-gray-700">Equipamento de backup</span>
            </label>
            {form.is_backup && <input value={form.backup_for} onChange={e => setForm({...form, backup_for: e.target.value})} className={inp} placeholder="Substitui o ativo nº..." />}
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200"><AlertTriangle size={13} className="text-red-500" /><p className="text-xs text-red-600">{error}</p></div>}

          <button onClick={salvar} disabled={loading} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60 shadow-lg shadow-blue-100">
            {loading ? 'Registrando...' : 'Registrar Entrada'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Peças por Equipamento ─────────────────────────────────
function PecasEquipamento({ equipId, modelId }: { equipId: string; modelId?: string }) {
  const [pecas, setPecas] = useState<any[]>([])
  const [estados, setEstados] = useState<Record<string, string>>({})
  const [notas, setNotas] = useState<Record<string, string>>({})
  const [salvando, setSalvando] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    db().from('spare_parts')
      .select('*, compatible_model:equipment_models(brand,model,nickname)')
      .or(`compatible_model_id.is.null${modelId ? `,compatible_model_id.eq.${modelId}` : ''}`)
      .order('category').order('name')
      .then(({ data }) => {
        setPecas(data || [])
        db().from('equipment_part_status').select('spare_part_id,status,notes').eq('equipment_id', equipId)
          .then(({ data: est }) => {
            const m: Record<string,string> = {}; const n: Record<string,string> = {}
            ;(est || []).forEach(e => { m[e.spare_part_id] = e.status; n[e.spare_part_id] = e.notes || '' })
            setEstados(m); setNotas(n)
          })
      })
  }, [equipId, modelId])

  const salvar = async () => {
    if (Object.keys(estados).length === 0) return
    setSalvando(true)
    for (const [partId, status] of Object.entries(estados)) {
      await db().from('equipment_part_status').upsert({ equipment_id: equipId, spare_part_id: partId, status, notes: notas[partId] || null }, { onConflict: 'equipment_id,spare_part_id' })
      if (status === 'novo' || status === 'sem_estoque') {
        const p = pecas.find(x => x.id === partId)
        if (p && p.stock_current > 0) await db().from('spare_parts').update({ stock_current: p.stock_current - 1 }).eq('id', partId)
      }
    }
    setSalvando(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  if (pecas.length === 0) return null
  return (
    <di
