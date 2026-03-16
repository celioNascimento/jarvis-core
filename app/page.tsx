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
    <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2"><Zap size={11} />Estado das Peças — Bancada</p>
      <div className="space-y-4">
        {pecas.map(p => (
          <div key={p.id}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-gray-700">{p.name}</span>
                {p.compatible_model && <span className="text-[10px] text-blue-500">{p.compatible_model.nickname || p.compatible_model.brand}</span>}
                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${p.stock_current === 0 ? 'bg-red-100 text-red-600' : p.stock_current <= p.stock_minimum ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>
                  estoque: {p.stock_current}
                </span>
              </div>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {Object.entries(PART_STATUS).map(([k, v]) => (
                <button key={k} onClick={() => setEstados(e => ({...e, [p.id]: k}))}
                  style={estados[p.id] === k ? { background: v.bg, color: v.color } : {}}
                  className={`px-2.5 py-1.5 rounded-xl border text-[9px] font-black uppercase tracking-wider transition-all ${estados[p.id] === k ? 'border-current' : 'border-gray-200 text-gray-400'}`}>
                  {v.label}
                </button>
              ))}
            </div>
            {(estados[p.id] === 'sem_estoque' || estados[p.id] === 'meia_vida') && (
              <input value={notas[p.id] || ''} onChange={e => setNotas(n => ({...n, [p.id]: e.target.value}))}
                className="mt-2 w-full px-3 py-2 rounded-xl border border-gray-200 text-xs text-gray-600 outline-none focus:border-blue-400" placeholder="Observação..." />
            )}
          </div>
        ))}
      </div>
      <button onClick={salvar} disabled={salvando || saved}
        className={`w-full mt-4 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${saved ? 'bg-green-500 text-white' : 'bg-gray-900 text-white hover:bg-gray-800'}`}>
        {saved ? '✓ Salvo' : salvando ? 'Salvando...' : 'Salvar estado das peças'}
      </button>
    </div>
  )
}

// ── Aba Fluxo ─────────────────────────────────────────────
function AbaFluxo() {
  const [ativo, setAtivo] = useState('')
  const [equip, setEquip] = useState<any>(null)
  const [historico, setHistorico] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [novoStatus, setNovoStatus] = useState('')
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [notFound, setNotFound] = useState(false)

  const buscar = async () => {
    if (!ativo.trim()) return
    setLoading(true); setNotFound(false); setEquip(null); setHistorico([])
    const { data } = await db().from('equipment')
      .select('*, location:locations(code), equipment_model:equipment_models(brand,model,nickname,measure_unit)')
      .eq('asset_number', ativo.trim()).maybeSingle()
    if (data) {
      setEquip(data); setNovoStatus(S[data.status]?.next[0] || '')
      const { data: mov } = await db().from('movements').select('*').eq('equipment_id', data.id).order('moved_at', { ascending: false })
      setHistorico(mov || [])
    } else setNotFound(true)
    setLoading(false)
  }

  const mover = async () => {
    if (!novoStatus || !equip) return
    setSalvando(true)
    await Promise.all([
      db().from('equipment').update({ status: novoStatus }).eq('id', equip.id),
      db().from('movements').insert({ equipment_id: equip.id, from_status: equip.status, to_status: novoStatus, reason: motivo || null, performed_by: 'Celio' })
    ])
    const updatedEquip = { ...equip, status: novoStatus }
    setEquip(updatedEquip); setNovoStatus(S[novoStatus]?.next[0] || ''); setMotivo('')
    const { data: mov } = await db().from('movements').select('*').eq('equipment_id', equip.id).order('moved_at', { ascending: false })
    setHistorico(mov || []); setSalvando(false)
  }

  return (
    <div className="space-y-4">
      {/* Busca */}
      <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Número de patrimônio</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Scan size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={ativo} onChange={e => setAtivo(e.target.value)} onKeyDown={e => e.key === 'Enter' && buscar()}
              className="w-full pl-10 pr-4 py-3 rounded-2xl border border-gray-200 text-base font-black text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" placeholder="Digite ou escaneie" autoFocus />
          </div>
          <button onClick={buscar} disabled={loading} className="px-5 py-3 bg-blue-600 text-white rounded-2xl font-black text-sm hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60">
            {loading ? <Activity size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          </button>
        </div>
        {notFound && <p className="mt-3 text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertTriangle size={12} />Ativo não encontrado.</p>}
      </div>

      {equip && (
        <>
          {/* Card equip */}
          <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-2xl font-black text-gray-900">{equip.asset_number}</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {equip.equipment_model?.nickname || equip.equipment_type || '—'}
                  {(equip.equipment_model?.brand || equip.brand) && <span className="text-gray-400 ml-2 text-xs">{equip.equipment_model?.brand || equip.brand} {equip.equipment_model?.model || equip.model}</span>}
                </p>
              </div>
              <Badge status={equip.status} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[['Série', equip.serial_number || '—'], ['Cliente', equip.client_number || '—'], ['Local', equip.location?.code || '—']].map(([l, v]) => (
                <div key={l} className="bg-gray-50 rounded-2xl p-3 text-center">
                  <p className="text-[9px] font-black uppercase tracking-widest text-gray-400">{l}</p>
                  <p className="text-sm font-bold text-gray-700 mt-1">{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Peças na bancada */}
          {equip.status === 'avaliacao_bancada' && <PecasEquipamento equipId={equip.id} modelId={equip.model_id} />}

          {/* Próximo passo */}
          {S[equip.status]?.next.length > 0 && (
            <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm space-y-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Próximo passo</p>
              <div className="flex items-center gap-3 flex-wrap">
                <Badge status={equip.status} />
                <ArrowRight size={14} className="text-gray-300 shrink-0" />
                <div className="flex gap-2 flex-wrap">
                  {S[equip.status].next.map(s => {
                    const cfg = S[s]; const Icon = cfg.icon; const sel = novoStatus === s
                    return (
                      <button key={s} onClick={() => setNovoStatus(s)}
                        style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-bold transition-all ${sel ? '' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                        <Icon size={13} />{cfg.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <textarea value={motivo} onChange={e => setMotivo(e.target.value)}
                className={inp + ' resize-none'} rows={2} placeholder="Motivo / observação (opcional)..." />
              <button onClick={mover} disabled={salvando || !novoStatus}
                className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60">
                {salvando ? 'Movendo...' : 'Confirmar'}
              </button>
            </div>
          )}

          {/* Histórico */}
          {historico.length > 0 && (
            <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2"><History size={11} />Histórico</p>
              <div className="space-y-2">
                {historico.map(m => (
                  <div key={m.id} className="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0 flex-wrap">
                    <Badge status={m.from_status} size="sm" />
                    <ArrowRight size={10} className="text-gray-300 shrink-0" />
                    <Badge status={m.to_status} size="sm" />
                    {m.reason && <span className="text-xs text-gray-400 flex-1 min-w-0 truncate">{m.reason}</span>}
                    <span className="text-[10px] text-gray-300 shrink-0 ml-auto">{fmtDate(m.moved_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Aba Peças ─────────────────────────────────────────────
function AbaPecas() {
  const [pecas, setPecas] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showNova, setShowNova] = useState(false)
  const [nova, setNova] = useState({ name: '', reference: '', category: 'filtro', compatible_model_id: '', stock_current: 0, stock_minimum: 1, unit: 'un', location_code: '', notes: '' })
  const [salvando, setSalvando] = useState(false)
  const [semEstoque, setSemEstoque] = useState<any[]>([])

  const carregar = async () => {
    setLoading(true)
    const [pRes, mRes, seRes] = await Promise.all([
      db().from('spare_parts').select('*, compatible_model:equipment_models(brand,model,nickname)').order('category').order('name'),
      db().from('equipment_models').select('id,brand,model,nickname').order('nickname'),
      db().from('equipment_part_status').select('*, equipment:equipment(asset_number), spare_part:spare_parts(name,category)').in('status', ['sem_estoque','necessita_troca']).order('created_at', { ascending: false }),
    ])
    setPecas(pRes.data || []); setModels(mRes.data || []); setSemEstoque(seRes.data || [])
    setLoading(false)
  }

  useEffect(() => { carregar() }, [])

  const salvarPeca = async () => {
    if (!nova.name.trim()) return
    setSalvando(true)
    await db().from('spare_parts').insert({ ...nova, compatible_model_id: nova.compatible_model_id || null, stock_current: Number(nova.stock_current), stock_minimum: Number(nova.stock_minimum) })
    setSalvando(false); setShowNova(false)
    setNova({ name: '', reference: '', category: 'filtro', compatible_model_id: '', stock_current: 0, stock_minimum: 1, unit: 'un', location_code: '', notes: '' })
    carregar()
  }

  const ajustar = async (id: string, delta: number, atual: number) => {
    const novo = Math.max(0, atual + delta)
    await db().from('spare_parts').update({ stock_current: novo }).eq('id', id)
    setPecas(p => p.map(x => x.id === id ? {...x, stock_current: novo} : x))
  }

  const catLabel: Record<string,string> = { filtro:'Filtros', sensor:'Sensores', acessorio:'Acessórios', consumivel:'Consumíveis' }
  const criticos = pecas.filter(p => p.stock_current <= p.stock_minimum)

  return (
    <div className="space-y-4">
      {criticos.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2"><AlertTriangle size={14} className="text-red-500" /><p className="text-sm font-black text-red-700">{criticos.length} peça(s) abaixo do mínimo</p></div>
          {criticos.map(p => (
            <div key={p.id} className="flex justify-between text-xs py-1">
              <span className="text-red-600 font-medium">{p.name}</span>
              <span className="font-black text-red-700">{p.stock_current}/{p.stock_minimum} {p.unit}</span>
            </div>
          ))}
        </div>
      )}

      {semEstoque.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-3 flex items-center gap-2"><Clock size={11} />Equipamentos com peças pendentes</p>
          {semEstoque.map(s => (
            <div key={s.id} className="flex items-center gap-3 py-1.5 border-b border-amber-100 last:border-0">
              <span className="font-black text-amber-800 text-xs w-16 shrink-0">{s.equipment?.asset_number}</span>
              <span className="text-xs text-amber-700 flex-1">{s.spare_part?.name}</span>
              <span style={{ background: PART_STATUS[s.status]?.bg, color: PART_STATUS[s.status]?.color }} className="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase">{PART_STATUS[s.status]?.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Estoque</p>
        <button onClick={() => setShowNova(!showNova)} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700">
          <Plus size={12} />Nova Peça
        </button>
      </div>

      {showNova && (
        <div className="bg-white border border-blue-200 rounded-2xl p-5 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-blue-600">Cadastrar peça</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className={lbl}>Nome *</label><input autoFocus value={nova.name} onChange={e => setNova({...nova, name: e.target.value})} className={inp} placeholder="Ex: Filtro de cabeceira EverFlo" /></div>
            <div><label className={lbl}>Referência</label><input value={nova.reference} onChange={e => setNova({...nova, reference: e.target.value})} className={inp} /></div>
            <div><label className={lbl}>Categoria</label><select value={nova.category} onChange={e => setNova({...nova, category: e.target.value})} className={inp}>{Object.entries(catLabel).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="col-span-2"><label className={lbl}>Compatível com (vazio = genérico)</label><select value={nova.compatible_model_id} onChange={e => setNova({...nova, compatible_model_id: e.target.value})} className={inp}><option value="">— Genérico —</option>{models.map(m => <option key={m.id} value={m.id}>{m.nickname || ''} {m.brand} {m.model}</option>)}</select></div>
            <div><label className={lbl}>Estoque atual</label><input type="number" min={0} value={nova.stock_current} onChange={e => setNova({...nova, stock_current: Number(e.target.value)})} className={inp} /></div>
            <div><label className={lbl}>Mínimo</label><input type="number" min={1} value={nova.stock_minimum} onChange={e => setNova({...nova, stock_minimum: Number(e.target.value)})} className={inp} /></div>
            <div><label className={lbl}>Unidade</label><input value={nova.unit} onChange={e => setNova({...nova, unit: e.target.value})} className={inp} placeholder="un" /></div>
            <div><label className={lbl}>Local</label><input value={nova.location_code} onChange={e => setNova({...nova, location_code: e.target.value})} className={inp} placeholder="Ex: AP-A2" /></div>
          </div>
          <div className="flex gap-2">
            <button onClick={salvarPeca} disabled={salvando} className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-60">{salvando ? 'Salvando...' : 'Cadastrar'}</button>
            <button onClick={() => setShowNova(false)} className="px-4 py-3 rounded-xl border border-gray-200 text-xs font-black text-gray-500">Cancelar</button>
          </div>
        </div>
      )}

      {loading ? <div className="p-8 flex items-center justify-center bg-white rounded-2xl border border-gray-200"><Activity size={20} className="text-blue-500 animate-spin" /></div>
      : pecas.length === 0 ? <div className="p-8 text-center bg-white rounded-2xl border border-gray-200"><Zap size={24} className="text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">Nenhuma peça cadastrada.</p></div>
      : ['filtro','sensor','acessorio','consumivel'].map(cat => {
          const lista = pecas.filter(p => p.category === cat)
          if (!lista.length) return null
          return (
            <div key={cat} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100"><p className="text-[9px] font-black uppercase tracking-widest text-gray-400">{catLabel[cat]}</p></div>
              {lista.map(p => {
                const crit = p.stock_current <= p.stock_minimum; const zero = p.stock_current === 0
                return (
                  <div key={p.id} className="px-4 py-3.5 flex items-center gap-3 border-b border-gray-50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-800 truncate">{p.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {p.reference && <span className="text-[10px] text-gray-400 font-mono">{p.reference}</span>}
                        {p.compatible_model ? <span className="text-[10px] text-blue-500">{p.compatible_model.nickname || p.compatible_model.brand} {p.compatible_model.model}</span> : <span className="text-[10px] text-gray-300">genérico</span>}
                        {p.location_code && <span className="text-[10px] text-gray-400">{p.location_code}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => ajustar(p.id, -1, p.stock_current)} className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100 font-black text-base leading-none">−</button>
                      <div className={`text-center w-12 py-1 rounded-xl border ${zero ? 'bg-red-50 border-red-200' : crit ? 'bg-yellow-50 border-yellow-200' : 'bg-gray-50 border-gray-200'}`}>
                        <p className={`text-sm font-black ${zero ? 'text-red-600' : crit ? 'text-yellow-700' : 'text-gray-700'}`}>{p.stock_current}</p>
                        <p className="text-[8px] text-gray-400">/{p.stock_minimum}</p>
                      </div>
                      <button onClick={() => ajustar(p.id, 1, p.stock_current)} className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100 font-black text-base leading-none">+</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })
      }
    </div>
  )
}

// ── Aba Relatórios ────────────────────────────────────────
function AbaRelatorios() {
  const [tipo, setTipo] = useState<string | null>(null)
  const [dados, setDados] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [periodo, setPeriodo] = useState({ de: '', ate: '' })

  const rels = [
    { id: 'por_status',    icon: BarChart2,      label: 'Por Status',              desc: 'Todos os equipamentos por status' },
    { id: 'manutencao',    icon: Wrench,          label: 'Manutenção Pendente',     desc: 'Em manutenção ou bancada' },
    { id: 'ag_pecas',      icon: Clock,           label: 'Aguardando Peças',        desc: 'Parados por falta de peça' },
    { id: 'calibracao',    icon: AlertTriangle,   label: 'Calibração Vencendo',     desc: 'Padrões nos próximos 60 dias' },
    { id: 'movimentacoes', icon: Activity,        label: 'Movimentações',           desc: 'Por período' },
    { id: 'pecas_criticas',icon: Zap,             label: 'Peças Críticas',          desc: 'Abaixo do estoque mínimo' },
  ]

  const gerar = async (id: string) => {
    setTipo(id); setLoading(true); setDados([])
    let res: any[] = []
    if (id === 'por_status') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').order('status').order('asset_number'); res = data || [] }
    else if (id === 'manutencao') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').in('status', ['manutencao_externa','avaliacao_bancada']).order('entry_date'); res = data || [] }
    else if (id === 'ag_pecas') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').eq('status', 'aguardando_pecas').order('entry_date'); res = data || [] }
    else if (id === 'calibracao') { const em60 = new Date(Date.now() + 60*24*60*60*1000).toISOString().slice(0,10); const { data } = await db().from('standards').select('*').lte('next_calibration', em60).order('next_calibration'); res = data || [] }
    else if (id === 'movimentacoes') { let q = db().from('movements').select('*, equipment:equipment(asset_number,brand,model)'); if (periodo.de) q = q.gte('moved_at', periodo.de); if (periodo.ate) q = q.lte('moved_at', periodo.ate + 'T23:59:59'); const { data } = await q.order('moved_at', { ascending: false }).limit(200); res = data || [] }
    else if (id === 'pecas_criticas') { const { data } = await db().from('spare_parts').select('*, compatible_model:equipment_models(brand,model,nickname)').order('stock_current'); res = (data || []).filter((p: any) => p.stock_current <= p.stock_minimum) }
    setDados(res); setLoading(false)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {rels.map(r => { const Icon = r.icon; return (
          <button key={r.id} onClick={() => gerar(r.id)}
            className={`text-left p-4 rounded-2xl border-2 transition-all hover:shadow-sm active:scale-[0.98] ${tipo === r.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
            <Icon size={16} className={tipo === r.id ? 'text-blue-600' : 'text-gray-400'} />
            <p className={`text-xs font-black mt-2 leading-tight ${tipo === r.id ? 'text-blue-700' : 'text-gray-700'}`}>{r.label}</p>
            <p className="text-[10px] text-gray-400 mt-1">{r.desc}</p>
          </button>
        )})}
      </div>

      {tipo === 'movimentacoes' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[140px]"><label className={lbl}>De</label><input type="date" value={periodo.de} onChange={e => setPeriodo({...periodo, de: e.target.value})} className={inp} /></div>
          <div className="flex-1 min-w-[140px]"><label className={lbl}>Até</label><input type="date" value={periodo.ate} onChange={e => setPeriodo({...periodo, ate: e.target.value})} className={inp} /></div>
          <button onClick={() => gerar('movimentacoes')} className="px-4 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">Filtrar</button>
        </div>
      )}

      {loading && <div className="bg-white rounded-2xl border border-gray-200 p-8 flex items-center justify-center"><Activity size={20} className="text-blue-500 animate-spin" /></div>}

      {!loading && dados.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">{dados.length} registro(s)</p>
            <button onClick={() => window.print()} className="flex items-center gap-1.5 text-xs font-bold text-blue-600"><Download size={13} />PDF</button>
          </div>
          <div className="divide-y divide-gray-50">
            {(tipo === 'por_status' || tipo === 'manutencao' || tipo === 'ag_pecas') && dados.map(eq => (
              <div key={eq.id} className="px-4 py-3 flex items-center gap-3">
                <span className="font-black text-gray-900 text-sm w-20 shrink-0">{eq.asset_number}</span>
                <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-700 truncate">{eq.equipment_model?.nickname || eq.equipment_type || '—'}<span className="text-gray-400 font-normal ml-1 text-xs">{eq.equipment_model?.brand} {eq.equipment_model?.model}</span></p></div>
                <Badge status={eq.status} size="sm" />
                <span className="text-xs text-gray-400 shrink-0">{eq.location?.code || '—'}</span>
              </div>
            ))}
            {tipo === 'calibracao' && dados.map(s => { const dias = Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000); return (
              <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                <span className="font-black text-gray-900 text-sm w-24 shrink-0">{s.code}</span>
                <p className="text-sm font-semibold text-gray-700 flex-1">{s.brand} {s.model}</p>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${dias < 0 ? 'bg-red-100 text-red-600' : dias <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-yellow-50 text-yellow-700'}`}>{dias < 0 ? `${Math.abs(dias)}d vencido` : `${dias}d`}</span>
                <span className="text-xs text-gray-400 shrink-0">{fmtDate(s.next_calibration)}</span>
              </div>
            )})}
            {tipo === 'movimentacoes' && dados.map(m => (
              <div key={m.id} className="px-4 py-3 flex items-center gap-2 flex-wrap">
                <span className="font-black text-gray-700 text-xs w-16 shrink-0">{m.equipment?.asset_number}</span>
                <Badge status={m.from_status} size="sm" /><ArrowRight size={10} className="text-gray-300" /><Badge status={m.to_status} size="sm" />
                {m.reason && <span className="text-xs text-gray-400 flex-1 truncate">{m.reason}</span>}
                <span className="text-[10px] text-gray-300 ml-auto">{fmtDate(m.moved_at)}</span>
              </div>
            ))}
            {tipo === 'pecas_criticas' && dados.map(p => (
              <div key={p.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0"><p className="text-sm font-bold text-gray-800">{p.name}</p><p className="text-xs text-gray-400">{p.compatible_model ? `${p.compatible_model.nickname || p.compatible_model.brand} ${p.compatible_model.model}` : 'genérico'}</p></div>
                <span className={`text-sm font-black px-3 py-1 rounded-xl ${p.stock_current === 0 ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-700'}`}>{p.stock_current}/{p.stock_minimum} {p.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!loading && tipo && dados.length === 0 && <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center"><p className="text-gray-400 text-sm">Nenhum registro encontrado.</p></div>}
    </div>
  )
}

// ── Dashboard Principal ───────────────────────────────────
export default function WMDashboard() {
  const [aba, setAba] = useState<'equipamentos' | 'fluxo' | 'pecas' | 'relatorios'>('equipamentos')
  const [equipment, setEquipment] = useState<any[]>([])
  const [standards, setStandards] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('todos')
  const [showEntrada, setShowEntrada] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const carregar = useCallback(async () => {
    const { data: { session } } = await authClient().auth.getSession()
    if (!session) { window.location.href = '/wm/login'; return }
    setLoading(true)
    const [eqRes, stRes] = await Promise.all([
      db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').order('created_at', { ascending: false }),
      db().from('standards').select('*').order('next_calibration', { ascending: true })
    ])
    setEquipment(eqRes.data || []); setStandards(stRes.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const stats = {
    total:      equipment.length,
    fluxo:      equipment.filter(e => ['entrada','avaliacao_bancada','aguardando_pecas','limpeza'].includes(e.status)).length,
    ag_pecas:   equipment.filter(e => e.status === 'aguardando_pecas').length,
    lastro:     equipment.filter(e => e.status === 'lastro').length,
    backup:     equipment.filter(e => e.status === 'backup').length,
    aplicado:   equipment.filter(e => e.status === 'aplicado').length,
    manutencao: equipment.filter(e => e.status === 'manutencao_externa').length,
    descarte:   equipment.filter(e => e.status === 'descarte').length,
  }

  const calVencendo = standards.filter(s => s.next_calibration && Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000) <= 30)

  const equipFiltrado = equipment.filter(e => {
    const q = search.toLowerCase()
    const matchSearch = !search || [e.asset_number, e.serial_number, e.brand, e.model, e.equipment_type, e.client_number, e.equipment_model?.nickname].some(v => v?.toLowerCase().includes(q))
    const matchStatus = filterStatus === 'todos' || e.status === filterStatus
    return matchSearch && matchStatus
  })

  const ABAS = [
    { id: 'equipamentos', label: 'Equipamentos', icon: Package },
    { id: 'fluxo',        label: 'Fluxo',        icon: ArrowRight },
    { id: 'pecas',        label: 'Peças',        icon: Zap },
    { id: 'relatorios',   label: 'Relatórios',   icon: FileText },
  ] as const

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-4 py-3">
          {/* Logo */}
          <img src="/logo_wm.png" alt="White Martins" className="h-8 w-auto object-contain shrink-0" />

          {/* Abas — no desktop ficam no centro do header */}
          <nav className="hidden sm:flex items-center gap-1 flex-1">
            {ABAS.map(a => {
              const Icon = a.icon
              return (
                <button key={a.id} onClick={() => setAba(a.id)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${aba === a.id ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
                  <Icon size={13} />{a.label}
                </button>
              )
            })}
          </nav>

          {/* Ações */}
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShowEntrada(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all shadow-sm">
              <Plus size={14} /><span className="hidden sm:inline">Nova </span>Entrada
            </button>
            <button onClick={logout} title="Sair" className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400 hover:bg-gray-100 transition-all">
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {/* Abas mobile — linha separada com scroll */}
        <div className="sm:hidden flex border-t border-gray-100 overflow-x-auto scrollbar-hide px-2">
          {ABAS.map(a => {
            const Icon = a.icon
            return (
              <button key={a.id} onClick={() => setAba(a.id)}
                className={`flex items-center gap-1.5 px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap shrink-0 ${aba === a.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400'}`}>
                <Icon size={12} />{a.label}
              </button>
            )
          })}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-4">

        {/* ── EQUIPAMENTOS ── */}
        {aba === 'equipamentos' && (
          <>
            {/* Stats grid responsivo */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              <StatCard label="Total"          value={stats.total}      color="#111827" bg="#ffffff" active={filterStatus==='todos'}             onClick={() => setFilterStatus('todos')} />
              <StatCard label="Em Fluxo"       value={stats.fluxo}      color="#92400e" bg="#fffbeb" active={filterStatus==='entrada'}           onClick={() => setFilterStatus('entrada')} />
              <StatCard label="Ag. Peças"      value={stats.ag_pecas}   color="#713f12" bg="#fefce8" active={filterStatus==='aguardando_pecas'}  onClick={() => setFilterStatus('aguardando_pecas')} />
              <StatCard label="Lastro"         value={stats.lastro}     color="#1e3a8a" bg="#eff6ff" active={filterStatus==='lastro'}            onClick={() => setFilterStatus('lastro')} />
              <StatCard label="Backup"         value={stats.backup}     color="#4c1d95" bg="#f5f3ff" active={filterStatus==='backup'}            onClick={() => setFilterStatus('backup')} />
              <StatCard label="Aplicado"       value={stats.aplicado}   color="#14532d" bg="#f0fdf4" active={filterStatus==='aplicado'}          onClick={() => setFilterStatus('aplicado')} />
              <StatCard label="Manutenção"     value={stats.manutencao} color="#7f1d1d" bg="#fef2f2" active={filterStatus==='manutencao_externa'} onClick={() => setFilterStatus('manutencao_externa')} />
              <StatCard label="Descarte"       value={stats.descarte}   color="#374151" bg="#f9fafb" active={filterStatus==='descarte'}          onClick={() => setFilterStatus('descarte')} />
            </div>

            {/* Alertas */}
            {stats.ag_pecas > 0 && (
              <button onClick={() => setFilterStatus('aguardando_pecas')} className="w-full bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-center gap-3 hover:bg-amber-100 transition-all">
                <Clock size={14} className="text-amber-600 shrink-0" />
                <p className="text-sm font-bold text-amber-800 text-left flex-1">{stats.ag_pecas} equipamento(s) aguardando peças</p>
                <ChevronRight size={14} className="text-amber-400 shrink-0" />
              </button>
            )}
            {calVencendo.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
                <AlertTriangle size={14} className="text-red-500 shrink-0" />
                <p className="text-sm font-bold text-red-700">{calVencendo.length} padrão(ões) com calibração vencendo</p>
              </div>
            )}

            {/* Busca + filtros */}
            <div className="space-y-2">
              <div className="relative">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar ativo, apelido, marca, série..."
                  className="w-full pl-10 pr-4 py-3 rounded-2xl border border-gray-200 bg-white text-sm text-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" />
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
                {[['todos','Todos'], ...Object.entries(S).map(([k,v]) => [k, v.label])].map(([k, v]) => (
                  <button key={k} onClick={() => setFilterStatus(k)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${filterStatus === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Lista */}
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              {loading ? (
                <div className="p-12 flex items-center justify-center"><Activity size={22} className="text-blue-500 animate-spin" /></div>
              ) : equipFiltrado.length === 0 ? (
                <div className="p-8 sm:p-12">
                  {equipment.length === 0 ? (
                    <div className="max-w-sm mx-auto text-center space-y-6">
                      <div className="w-16 h-16 bg-blue-50 rounded-3xl flex items-center justify-center mx-auto">
                        <Package size={28} className="text-blue-400" />
                      </div>
                      <div>
                        <p className="text-gray-900 font-black text-base">Laboratório vazio</p>
                        <p className="text-gray-400 text-sm mt-1">Registre o primeiro equipamento para começar o controle.</p>
                      </div>
                      <div className="text-left space-y-3">
                        {[
                          { n: '1', t: 'Registre a entrada', d: 'Clique em "+ Entrada" e preencha o patrimônio' },
                          { n: '2', t: 'Avalie na bancada', d: 'Use a aba Fluxo para acompanhar o equipamento' },
                          { n: '3', t: 'Mova para o lastro', d: 'Após limpeza, o equipamento fica disponível' },
                        ].map(s => (
                          <div key={s.n} className="flex items-start gap-3 p-3 bg-gray-50 rounded-2xl">
                            <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-black flex items-center justify-center shrink-0 mt-0.5">{s.n}</span>
                            <div><p className="text-sm font-bold text-gray-700">{s.t}</p><p className="text-xs text-gray-400 mt-0.5">{s.d}</p></div>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => setShowEntrada(true)} className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all shadow-lg shadow-blue-100">
                        + Registrar primeiro equipamento
                      </button>
                    </div>
                  ) : (
                    <div className="text-center space-y-2">
                      <Search size={24} className="text-gray-300 mx-auto" />
                      <p className="text-gray-400 text-sm">Nenhum resultado para a busca.</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="hidden sm:grid grid-cols-[80px_1fr_90px_120px_70px_32px] gap-3 px-5 py-2.5 bg-gray-50 border-b border-gray-100">
                    {['Ativo','Equipamento','Série','Status','Local',''].map(h => <span key={h} className="text-[9px] font-black uppercase tracking-widest text-gray-400">{h}</span>)}
                  </div>
                  {equipFiltrado.map((eq, i) => {
                    const nome = eq.equipment_model?.nickname || eq.equipment_type
                    const detalhe = [eq.equipment_model?.brand || eq.brand, eq.equipment_model?.model || eq.model].filter(Boolean).join(' ')
                    return (
                      <div key={eq.id} onClick={() => setAba('fluxo')}
                        className={`grid grid-cols-[80px_1fr_auto] sm:grid-cols-[80px_1fr_90px_120px_70px_32px] gap-2 sm:gap-3 px-4 sm:px-5 py-3.5 items-center border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors ${i%2!==0?'bg-gray-50/30':''}`}>
                        <span className="font-black text-gray-900 text-sm">{eq.asset_number}</span>
                        <div className="min-w-0">
                          {nome && <p className="text-sm font-bold text-gray-700 truncate">{nome}</p>}
                          {detalhe && <p className="text-[11px] text-gray-400 truncate">{detalhe}</p>}
                        </div>
                        <Badge status={eq.status} size="sm" />
                        <span className="hidden sm:block text-xs text-gray-400 font-mono">{eq.serial_number || '—'}</span>
                        <div className="hidden sm:flex items-center gap-1"><MapPin size={9} className="text-gray-300 shrink-0" /><span className="text-[11px] font-bold text-gray-500">{eq.location?.code || '—'}</span></div>
                        <ChevronRight size={13} className="text-gray-300" />
                      </div>
                    )
                  })}
                </>
              )}
            </div>
            <p className="text-center text-[10px] text-gray-400">{equipment.length} equipamento(s) · Londrina</p>
          </>
        )}

        {aba === 'fluxo' && <AbaFluxo />}
        {aba === 'pecas' && <AbaPecas />}
        {aba === 'relatorios' && <AbaRelatorios />}
      </main>

      {showEntrada && <ModalEntrada onClose={() => setShowEntrada(false)} onSaved={carregar} />}
    </div>
  )
}
