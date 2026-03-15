'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Package, MapPin, Wrench, AlertTriangle, CheckCircle,
  Clock, Plus, Search, ChevronRight, Activity,
  Archive, RotateCcw, Trash2, X, Zap, BookOpen,
  ArrowRight, Droplets, ChevronDown
} from 'lucide-react'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'white_martins' } }
  )
}

function getSupabaseAuth() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

async function logout() {
  await getSupabaseAuth().auth.signOut()
  window.location.href = '/wm/login'
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any; next?: string[] }> = {
  entrada:            { label: 'Entrada',      color: '#d97706', bg: '#fef3c7', icon: Package,      next: ['limpeza','manutencao_externa','aguardando'] },
  limpeza:            { label: 'Limpeza',       color: '#0891b2', bg: '#cffafe', icon: Droplets,     next: ['lastro','manutencao_externa','descarte'] },
  aguardando:         { label: 'Aguardando',    color: '#92400e', bg: '#fef3c7', icon: Clock,        next: ['limpeza','manutencao_externa','descarte'] },
  manutencao_externa: { label: 'Manutenção',    color: '#dc2626', bg: '#fee2e2', icon: Wrench,       next: ['lastro','descarte'] },
  lastro:             { label: 'Lastro',        color: '#2563eb', bg: '#dbeafe', icon: Archive,      next: ['backup','aplicado','descarte'] },
  backup:             { label: 'Backup',        color: '#7c3aed', bg: '#ede9fe', icon: RotateCcw,    next: ['lastro','aplicado','descarte'] },
  aplicado:           { label: 'Aplicado',      color: '#059669', bg: '#d1fae5', icon: CheckCircle,  next: ['limpeza','manutencao_externa','descarte'] },
  descarte:           { label: 'Descarte',      color: '#6b7280', bg: '#f3f4f6', icon: Trash2,       next: [] },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#6b7280', bg: '#f3f4f6', icon: Package }
  const Icon = cfg.icon
  return (
    <span style={{ background: cfg.bg, color: cfg.color }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide">
      <Icon size={10} />{cfg.label}
    </span>
  )
}

// ============================================================
// MODAL — CADASTRO DE MODELO
// ============================================================
function ModalModelo({ onClose, onSaved }: { onClose: () => void; onSaved: (m: any) => void }) {
  const [form, setForm] = useState({ brand: '', model: '', nickname: '', equipment_type: '', measure_unit: '', notes: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const salvar = async () => {
    if (!form.brand.trim() || !form.model.trim()) { setError('Marca e modelo são obrigatórios'); return }
    setLoading(true)
    const { data, error: err } = await getSupabase().from('equipment_models').insert({
      brand: form.brand.trim(), model: form.model.trim(),
      nickname: form.nickname || null, equipment_type: form.equipment_type || null,
      measure_unit: form.measure_unit || null, notes: form.notes || null,
    }).select().single()
    setLoading(false)
    if (err) { setError(err.code === '23505' ? 'Marca/modelo já cadastrado.' : err.message); return }
    onSaved(data)
    onClose()
  }

  const input = "w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
  const label = "block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1"

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-slate-900">Novo Modelo</h2>
            <p className="text-xs text-slate-500">Cadastra marca, modelo e apelido</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
            <X size={14} className="text-slate-600" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Marca *</label>
              <input autoFocus value={form.brand} onChange={e => setForm({...form, brand: e.target.value})} className={input} placeholder="Ex: Philips" />
            </div>
            <div>
              <label className={label}>Modelo *</label>
              <input value={form.model} onChange={e => setForm({...form, model: e.target.value})} className={input} placeholder="Ex: EverFlo" />
            </div>
            <div className="col-span-2">
              <label className={label}>Apelido (nome popular)</label>
              <input value={form.nickname} onChange={e => setForm({...form, nickname: e.target.value})} className={input} placeholder="Ex: concentrador, oxímetro, regulador" />
            </div>
            <div className="col-span-2">
              <label className={label}>Tipo de Equipamento</label>
              <input value={form.equipment_type} onChange={e => setForm({...form, equipment_type: e.target.value})} className={input} placeholder="Ex: Concentrador de Oxigênio" />
            </div>
            <div>
              <label className={label}>Unidade de Medida</label>
              <input value={form.measure_unit} onChange={e => setForm({...form, measure_unit: e.target.value})} className={input} placeholder="Ex: L/min" />
            </div>
          </div>
          <div>
            <label className={label}>Observações</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
              className={input + ' resize-none'} rows={2} />
          </div>
          {error && <p className="text-xs text-red-500 font-medium">{error}</p>}
          <button onClick={salvar} disabled={loading}
            className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60">
            {loading ? 'Salvando...' : 'Cadastrar Modelo'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// MODAL — CADASTRO DE EQUIPAMENTO
// ============================================================
function ModalEquipamento({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    asset_number: '', serial_number: '', client_number: '',
    model_id: '', status: 'entrada', location_code: '',
    is_backup: false, backup_for: '', notes: '',
    entry_date: new Date().toISOString().slice(0, 10)
  })
  const [models, setModels] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showNovoModelo, setShowNovoModelo] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  useEffect(() => {
    Promise.all([
      getSupabase().from('equipment_models').select('*').order('nickname').order('brand'),
      getSupabase().from('locations').select('id, code, area, description').eq('active', true).order('code')
    ]).then(([mRes, lRes]) => {
      setModels(mRes.data || [])
      setLocations(lRes.data || [])
    })
  }, [])

  const modelsFiltrados = models.filter(m => {
    if (!modelSearch) return true
    const s = modelSearch.toLowerCase()
    return m.brand?.toLowerCase().includes(s) || m.model?.toLowerCase().includes(s) || m.nickname?.toLowerCase().includes(s)
  })

  const modelSelecionado = models.find(m => m.id === form.model_id)

  const salvar = async () => {
    if (!form.asset_number.trim()) { setError('Número de patrimônio é obrigatório'); return }
    setLoading(true)
    setError('')

    let location_id = null
    if (form.location_code) {
      const loc = locations.find(l => l.code === form.location_code)
      location_id = loc?.id || null
    }

    const modelo = models.find(m => m.id === form.model_id)

    const { error: err } = await getSupabase().from('equipment').insert({
      asset_number: form.asset_number.trim(),
      serial_number: form.serial_number || null,
      client_number: form.client_number || null,
      model_id: form.model_id || null,
      brand: modelo?.brand || null,
      model: modelo?.model || null,
      equipment_type: modelo?.equipment_type || null,
      measure_unit: modelo?.measure_unit || null,
      status: form.status,
      location_id,
      is_backup: form.is_backup,
      backup_for: form.backup_for || null,
      notes: form.notes || null,
      entry_date: form.entry_date,
    })

    setLoading(false)
    if (err) { setError(err.code === '23505' ? 'Já existe um equipamento com esse patrimônio.' : err.message); return }
    onSaved()
    onClose()
  }

  const input = "w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
  const label = "block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1"

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white rounded-t-3xl border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-black text-slate-900">Entrada de Equipamento</h2>
            <p className="text-xs text-slate-500 mt-0.5">Registra chegada ao laboratório</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-all">
            <X size={16} className="text-slate-600" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Identificação obrigatória */}
          <div className="bg-blue-50 rounded-2xl p-4 space-y-3 border border-blue-100">
            <p className="text-xs font-black uppercase tracking-widest text-blue-600">1. Identificação</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={label}>Ativo (Patrimônio) *</label>
                <input autoFocus value={form.asset_number} onChange={e => setForm({...form, asset_number: e.target.value})} className={input} placeholder="Ex: 001234" />
              </div>
              <div>
                <label className={label}>Número de Série</label>
                <input value={form.serial_number} onChange={e => setForm({...form, serial_number: e.target.value})} className={input} placeholder="S/N" />
              </div>
              <div>
                <label className={label}>Nº do Cliente</label>
                <input value={form.client_number} onChange={e => setForm({...form, client_number: e.target.value})} className={input} />
              </div>
            </div>
          </div>

          {/* Modelo */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500">2. Modelo</p>
              <button onClick={() => setShowNovoModelo(true)}
                className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700">
                <Plus size={12} /> Novo modelo
              </button>
            </div>

            {/* Busca de modelo */}
            <div className="relative mb-2">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={modelSearch} onChange={e => setModelSearch(e.target.value)}
                className={input + ' pl-8'} placeholder="Busca por apelido, marca ou modelo..." />
            </div>

            {modelSelecionado && (
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-green-50 border border-green-200 mb-2">
                <CheckCircle size={14} className="text-green-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-green-800">{modelSelecionado.nickname || modelSelecionado.equipment_type}</p>
                  <p className="text-[10px] text-green-600">{modelSelecionado.brand} {modelSelecionado.model}</p>
                </div>
                <button onClick={() => setForm({...form, model_id: ''})} className="text-green-500 hover:text-green-700">
                  <X size={12} />
                </button>
              </div>
            )}

            {!modelSelecionado && (
              <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                {modelsFiltrados.length === 0 ? (
                  <div className="p-3 text-center text-xs text-slate-400">
                    {models.length === 0 ? 'Nenhum modelo cadastrado.' : 'Nenhum resultado.'}
                  </div>
                ) : modelsFiltrados.slice(0, 20).map(m => (
                  <button key={m.id} onClick={() => { setForm({...form, model_id: m.id}); setModelSearch('') }}
                    className="w-full px-3 py-2.5 text-left hover:bg-blue-50 transition-colors flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-slate-800 truncate">
                        {m.nickname ? <span className="text-blue-600">{m.nickname}</span> : m.equipment_type || '—'}
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">{m.brand} {m.model}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status e destino */}
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3">3. Destino Inicial</p>
            <div className="grid grid-cols-3 gap-2">
              {(['entrada','limpeza','aguardando','manutencao_externa'] as const).map(s => {
                const cfg = STATUS_CONFIG[s]
                const Icon = cfg.icon
                return (
                  <button key={s} onClick={() => setForm({...form, status: s})}
                    style={form.status === s ? { background: cfg.bg, borderColor: cfg.color, color: cfg.color } : {}}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 transition-all text-center ${
                      form.status === s ? 'border-current' : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}>
                    <Icon size={18} />
                    <span className="text-[10px] font-bold uppercase tracking-wide leading-tight">{cfg.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Localização */}
          <div>
            <label className={label}>Endereço (opcional)</label>
            <select value={form.location_code} onChange={e => setForm({...form, location_code: e.target.value})} className={input}>
              <option value="">— Sem endereço definido —</option>
              {['sala_lastro','container','armario','externo'].map(area => (
                <optgroup key={area} label={area.replace('_',' ').toUpperCase()}>
                  {locations.filter(l => l.area === area).map(l => (
                    <option key={l.id} value={l.code}>{l.code} — {l.description}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Data */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Data de Entrada</label>
              <input type="date" value={form.entry_date} onChange={e => setForm({...form, entry_date: e.target.value})} className={input} />
            </div>
          </div>

          {/* Backup */}
          <div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 border border-slate-200">
            <input type="checkbox" id="is_backup" checked={form.is_backup}
              onChange={e => setForm({...form, is_backup: e.target.checked})} className="w-4 h-4 accent-blue-600" />
            <label htmlFor="is_backup" className="text-sm font-semibold text-slate-700 cursor-pointer">
              Equipamento de backup
            </label>
          </div>
          {form.is_backup && (
            <div>
              <label className={label}>Substitui o ativo</label>
              <input value={form.backup_for} onChange={e => setForm({...form, backup_for: e.target.value})} className={input} placeholder="Número de patrimônio" />
            </div>
          )}

          {/* Observações */}
          <div>
            <label className={label}>Observações / Estado na chegada</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
              className={input + ' resize-none'} rows={3}
              placeholder="Descreva o estado do equipamento, problemas identificados, itens faltando..." />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
              <AlertTriangle size={14} className="text-red-500 shrink-0" />
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <button onClick={salvar} disabled={loading}
            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60 shadow-lg shadow-blue-200">
            {loading ? 'Registrando...' : 'Registrar Entrada'}
          </button>
        </div>
      </div>
    </div>

    {showNovoModelo && (
      <ModalModelo
        onClose={() => setShowNovoModelo(false)}
        onSaved={(m) => {
          setModels(prev => [...prev, m])
          setForm(f => ({...f, model_id: m.id}))
          setModelSearch('')
        }}
      />
    )}
    </>
  )
}

// ============================================================
// MODAL — MOVIMENTAR EQUIPAMENTO
// ============================================================
function ModalMovimentar({ equip, onClose, onSaved }: { equip: any; onClose: () => void; onSaved: () => void }) {
  const nextStatuses = STATUS_CONFIG[equip.status]?.next || []
  const [novoStatus, setNovoStatus] = useState(nextStatuses[0] || '')
  const [motivo, setMotivo] = useState('')
  const [loading, setLoading] = useState(false)

  const mover = async () => {
    if (!novoStatus) return
    setLoading(true)

    await Promise.all([
      getSupabase().from('equipment').update({ status: novoStatus }).eq('id', equip.id),
      getSupabase().from('movements').insert({
        equipment_id: equip.id,
        from_status: equip.status,
        to_status: novoStatus,
        reason: motivo || null,
        performed_by: 'Celio',
      })
    ])

    setLoading(false)
    onSaved()
    onClose()
  }

  const input = "w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-slate-900">Movimentar</h2>
            <p className="text-xs text-slate-500">Ativo {equip.asset_number}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
            <X size={14} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {/* Status atual → próximo */}
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl">
            <StatusBadge status={equip.status} />
            <ArrowRight size={16} className="text-slate-400 shrink-0" />
            <div className="flex-1">
              <select value={novoStatus} onChange={e => setNovoStatus(e.target.value)} className={input}>
                {nextStatuses.map(s => (
                  <option key={s} value={s}>{STATUS_CONFIG[s]?.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Motivo / Observação</label>
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)}
              className={input + ' resize-none'} rows={3}
              placeholder="Ex: limpeza concluída, filtro trocado, encaminhado para manutenção..." />
          </div>

          <button onClick={mover} disabled={loading || !novoStatus}
            className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60">
            {loading ? 'Movendo...' : 'Confirmar Movimentação'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// DASHBOARD PRINCIPAL
// ============================================================
export default function WhiteMartinsDashboard() {
  const [equipment, setEquipment] = useState<any[]>([])
  const [standards, setStandards] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('todos')
  const [showModal, setShowModal] = useState(false)
  const [equipMovimentar, setEquipMovimentar] = useState<any>(null)

  const carregar = useCallback(async () => {
    const { data: { session } } = await getSupabaseAuth().auth.getSession()
    if (!session) { window.location.href = '/wm/login'; return }

    setLoading(true)
    const [eqRes, stRes] = await Promise.all([
      getSupabase().from('equipment')
        .select('*, location:locations(code, area), equipment_model:equipment_models(brand, model, nickname)')
        .order('created_at', { ascending: false }),
      getSupabase().from('standards').select('*').order('next_calibration', { ascending: true })
    ])
    setEquipment(eqRes.data || [])
    setStandards(stRes.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const stats = {
    total:      equipment.length,
    lastro:     equipment.filter(e => e.status === 'lastro').length,
    backup:     equipment.filter(e => e.status === 'backup').length,
    aplicado:   equipment.filter(e => e.status === 'aplicado').length,
    manutencao: equipment.filter(e => e.status === 'manutencao_externa').length,
    descarte:   equipment.filter(e => e.status === 'descarte').length,
    entrada:    equipment.filter(e => e.status === 'entrada' || e.status === 'limpeza' || e.status === 'aguardando').length,
  }

  const calVencendo = standards.filter(s => {
    if (!s.next_calibration) return false
    return Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000) <= 30
  })

  const equipFiltrado = equipment.filter(e => {
    const matchSearch = !search || [e.asset_number, e.serial_number, e.brand, e.model,
      e.equipment_type, e.client_number, e.equipment_model?.nickname]
      .some(v => v?.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = filterStatus === 'todos' || e.status === filterStatus
    return matchSearch && matchStatus
  })

  return (
    <div className="min-h-screen bg-[#f0f4f8] font-sans">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="h-9 flex items-center">
            <img src="/logo_wm.png" alt="White Martins" className="h-full w-auto object-contain" />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 active:scale-95 transition-all shadow-md shadow-blue-200">
              <Plus size={16} /><span className="hidden sm:inline">Entrada</span>
            </button>
            <button onClick={logout}
              className="px-3 py-2.5 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 transition-all border border-slate-200">
              Sair
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 space-y-5">

        {/* Stats */}
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
          {[
            { label: 'Total',    value: stats.total,      color: 'text-slate-700', bg: 'bg-white' },
            { label: 'Em fluxo', value: stats.entrada,    color: 'text-amber-600', bg: 'bg-amber-50' },
            { label: 'Lastro',   value: stats.lastro,     color: 'text-blue-600',  bg: 'bg-blue-50' },
            { label: 'Backup',   value: stats.backup,     color: 'text-purple-600',bg: 'bg-purple-50' },
            { label: 'Aplicado', value: stats.aplicado,   color: 'text-green-600', bg: 'bg-green-50' },
            { label: 'Manut.',   value: stats.manutencao, color: 'text-red-600',   bg: 'bg-red-50' },
            { label: 'Descarte', value: stats.descarte,   color: 'text-slate-500', bg: 'bg-slate-100' },
          ].map(s => (
            <div key={s.label} className={`${s.bg} rounded-2xl p-3 border border-slate-100 cursor-pointer hover:shadow-sm transition-all`}
              onClick={() => setFilterStatus(s.label === 'Total' ? 'todos' : s.label === 'Em fluxo' ? 'entrada' : s.label === 'Manut.' ? 'manutencao_externa' : s.label.toLowerCase())}>
              <p className={`text-2xl font-black ${s.color} leading-none`}>{s.value}</p>
              <p className="text-[9px] font-bold uppercase text-slate-500 mt-1 tracking-wide leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Alerta calibração */}
        {calVencendo.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-center gap-3">
            <AlertTriangle size={16} className="text-amber-600 shrink-0" />
            <p className="text-sm font-bold text-amber-800">
              {calVencendo.length} padrão(ões) com calibração vencendo em 30 dias: {calVencendo.map(s => s.code).join(', ')}
            </p>
          </div>
        )}

        {/* Busca e filtros */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por ativo, apelido, marca, modelo, série..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {[['todos','Todos'], ...Object.entries(STATUS_CONFIG).map(([k,v]) => [k, v.label])].map(([k, v]) => (
              <button key={k} onClick={() => setFilterStatus(k)}
                className={`px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
                  filterStatus === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'
                }`}>{v}</button>
            ))}
          </div>
        </div>

        {/* Lista */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="p-12 flex items-center justify-center">
              <Activity size={24} className="text-blue-500 animate-spin" />
            </div>
          ) : equipFiltrado.length === 0 ? (
            <div className="p-12 text-center">
              <Package size={32} className="text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">
                {equipment.length === 0 ? 'Nenhum equipamento cadastrado.' : 'Nenhum resultado.'}
              </p>
              {equipment.length === 0 && (
                <button onClick={() => setShowModal(true)}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold">
                  Registrar primeiro equipamento
                </button>
              )}
            </div>
          ) : (
            <div>
              <div className="hidden sm:grid grid-cols-[90px_1fr_110px_100px_80px_40px] gap-3 px-5 py-3 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-500">
                <span>Ativo</span><span>Equipamento</span><span>Série</span><span>Status</span><span>Local</span><span></span>
              </div>
              {equipFiltrado.map((eq, i) => {
                const nome = eq.equipment_model?.nickname || eq.equipment_model?.equipment_type || eq.equipment_type
                const marcaModelo = [eq.equipment_model?.brand || eq.brand, eq.equipment_model?.model || eq.model].filter(Boolean).join(' ')
                return (
                  <div key={eq.id}
                    className={`grid grid-cols-1 sm:grid-cols-[90px_1fr_110px_100px_80px_40px] gap-2 sm:gap-3 px-5 py-3.5 items-center border-b border-slate-100 hover:bg-slate-50 transition-colors ${i % 2 !== 0 ? 'bg-slate-50/40' : ''}`}>
                    <span className="font-black text-slate-900 text-sm">{eq.asset_number}</span>
                    <div>
                      {nome && <p className="font-bold text-slate-800 text-sm leading-tight">{nome}</p>}
                      {marcaModelo && <p className="text-xs text-slate-500 mt-0.5">{marcaModelo}</p>}
                      {!nome && !marcaModelo && <p className="text-sm text-slate-400">—</p>}
                    </div>
                    <span className="text-xs text-slate-500 font-mono">{eq.serial_number || '—'}</span>
                    <StatusBadge status={eq.status} />
                    <div className="flex items-center gap-1">
                      <MapPin size={10} className="text-slate-400 shrink-0" />
                      <span className="text-xs font-bold text-slate-600">{eq.location?.code || '—'}</span>
                    </div>
                    <button onClick={() => setEquipMovimentar(eq)}
                      className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center hover:bg-blue-100 hover:text-blue-600 transition-all ml-auto"
                      title="Movimentar">
                      <ArrowRight size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-400">
          {equipment.length} equipamento(s) · White Martins Lab — Londrina
        </p>
      </div>

      {showModal && <ModalEquipamento onClose={() => setShowModal(false)} onSaved={carregar} />}
      {equipMovimentar && <ModalMovimentar equip={equipMovimentar} onClose={() => setEquipMovimentar(null)} onSaved={carregar} />}
    </div>
  )
}