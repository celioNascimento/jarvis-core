'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Package, MapPin, Wrench, AlertTriangle, CheckCircle,
  Clock, Plus, Search, ChevronRight, Activity,
  Archive, RotateCcw, Trash2, ExternalLink, X,
  BarChart3, Shield, Zap
} from 'lucide-react'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'white_martins' } }
  )
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  lastro:            { label: 'Lastro',       color: '#2563eb', bg: '#dbeafe', icon: Archive },
  backup:            { label: 'Backup',        color: '#7c3aed', bg: '#ede9fe', icon: RotateCcw },
  aplicado:          { label: 'Aplicado',      color: '#059669', bg: '#d1fae5', icon: CheckCircle },
  entrada:           { label: 'Entrada',       color: '#d97706', bg: '#fef3c7', icon: Package },
  limpeza:           { label: 'Limpeza',       color: '#0891b2', bg: '#cffafe', icon: Zap },
  manutencao_externa:{ label: 'Manutenção',    color: '#dc2626', bg: '#fee2e2', icon: Wrench },
  descarte:          { label: 'Descarte',      color: '#6b7280', bg: '#f3f4f6', icon: Trash2 },
  aguardando:        { label: 'Aguardando',    color: '#92400e', bg: '#fef3c7', icon: Clock },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#6b7280', bg: '#f3f4f6', icon: Package }
  const Icon = cfg.icon
  return (
    <span style={{ background: cfg.bg, color: cfg.color }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide">
      <Icon size={10} />
      {cfg.label}
    </span>
  )
}

// ============================================================
// MODAL — CADASTRO DE EQUIPAMENTO
// ============================================================
function ModalEquipamento({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    asset_number: '', serial_number: '', client_number: '',
    brand: '', model: '', equipment_type: '', measure_unit: '',
    status: 'entrada', location_code: '', is_backup: false,
    backup_for: '', notes: '', entry_date: new Date().toISOString().slice(0, 10)
  })
  const [locations, setLocations] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getSupabase().from('locations').select('id, code, area, description')
      .eq('active', true).order('code')
      .then(({ data }: { data: any[] | null }) => setLocations(data || []))
  }, [])

  const salvar = async () => {
    if (!form.asset_number.trim()) { setError('Número de patrimônio é obrigatório'); return }
    setLoading(true)
    setError('')

    let location_id = null
    if (form.location_code) {
      const loc = locations.find(l => l.code === form.location_code)
      location_id = loc?.id || null
    }

    const { error: err } = await getSupabase().from('equipment').insert({
      asset_number: form.asset_number.trim(),
      serial_number: form.serial_number || null,
      client_number: form.client_number || null,
      brand: form.brand || null,
      model: form.model || null,
      equipment_type: form.equipment_type || null,
      measure_unit: form.measure_unit || null,
      status: form.status,
      location_id,
      is_backup: form.is_backup,
      backup_for: form.backup_for || null,
      notes: form.notes || null,
      entry_date: form.entry_date,
    })

    setLoading(false)
    if (err) {
      if (err.code === '23505') setError('Já existe um equipamento com esse número de patrimônio.')
      else setError(err.message)
      return
    }
    onSaved()
    onClose()
  }

  const input = "w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
  const label = "block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-white rounded-t-3xl border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-black text-slate-900">Novo Equipamento</h2>
            <p className="text-xs text-slate-500 mt-0.5">Preencha os dados de entrada</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-all">
            <X size={16} className="text-slate-600" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Identificação */}
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-blue-600 mb-3">Identificação</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 md:col-span-1">
                <label className={label}>Ativo (Patrimônio) *</label>
                <input value={form.asset_number} onChange={e => setForm({...form, asset_number: e.target.value})} className={input} placeholder="Ex: 001234" />
              </div>
              <div>
                <label className={label}>Número de Série</label>
                <input value={form.serial_number} onChange={e => setForm({...form, serial_number: e.target.value})} className={input} placeholder="S/N" />
              </div>
              <div>
                <label className={label}>Número do Cliente</label>
                <input value={form.client_number} onChange={e => setForm({...form, client_number: e.target.value})} className={input} />
              </div>
              <div>
                <label className={label}>Marca</label>
                <input value={form.brand} onChange={e => setForm({...form, brand: e.target.value})} className={input} placeholder="Ex: Emerson" />
              </div>
              <div>
                <label className={label}>Modelo</label>
                <input value={form.model} onChange={e => setForm({...form, model: e.target.value})} className={input} />
              </div>
              <div>
                <label className={label}>Tipo de Equipamento</label>
                <input value={form.equipment_type} onChange={e => setForm({...form, equipment_type: e.target.value})} className={input} placeholder="Ex: Transmissor de pressão" />
              </div>
              <div>
                <label className={label}>Unidade de Medida</label>
                <input value={form.measure_unit} onChange={e => setForm({...form, measure_unit: e.target.value})} className={input} placeholder="Ex: bar, °C, m³/h" />
              </div>
            </div>
          </div>

          {/* Status e Localização */}
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-blue-600 mb-3">Status e Localização</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Status *</label>
                <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className={input}>
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Endereço</label>
                <select value={form.location_code} onChange={e => setForm({...form, location_code: e.target.value})} className={input}>
                  <option value="">— Sem endereço —</option>
                  {['sala_lastro','container','armario','externo'].map(area => (
                    <optgroup key={area} label={area.replace('_',' ').toUpperCase()}>
                      {locations.filter(l => l.area === area).map(l => (
                        <option key={l.id} value={l.code}>{l.code} — {l.description}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Data de Entrada</label>
                <input type="date" value={form.entry_date} onChange={e => setForm({...form, entry_date: e.target.value})} className={input} />
              </div>
            </div>
          </div>

          {/* Backup */}
          <div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 border border-slate-200">
            <input type="checkbox" id="is_backup" checked={form.is_backup}
              onChange={e => setForm({...form, is_backup: e.target.checked})}
              className="w-4 h-4 accent-blue-600" />
            <label htmlFor="is_backup" className="text-sm font-semibold text-slate-700 cursor-pointer">
              Este é um equipamento de backup
            </label>
          </div>
          {form.is_backup && (
            <div>
              <label className={label}>Substitui o ativo (Patrimônio)</label>
              <input value={form.backup_for} onChange={e => setForm({...form, backup_for: e.target.value})} className={input} placeholder="Número de patrimônio que substitui" />
            </div>
          )}

          {/* Observações */}
          <div>
            <label className={label}>Observações / Descrição da análise</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
              className={input + ' resize-none'} rows={3} placeholder="Condição do equipamento, motivo de entrada, etc." />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
              <AlertTriangle size={14} className="text-red-500 shrink-0" />
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <button onClick={salvar} disabled={loading}
            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60 shadow-lg shadow-blue-200">
            {loading ? 'Salvando...' : 'Registrar Equipamento'}
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

  const carregar = async () => {
    setLoading(true)
    const [eqRes, stRes] = await Promise.all([
      getSupabase().from('equipment')
        .select('*, location:locations(code, area)')
        .order('created_at', { ascending: false }),
      getSupabase().from('standards')
        .select('*')
        .order('next_calibration', { ascending: true })
    ])
    setEquipment(eqRes.data || [])
    setStandards(stRes.data || [])
    setLoading(false)
  }

  useEffect(() => { carregar() }, [])

  // Stats
  const stats = {
    total: equipment.length,
    lastro: equipment.filter(e => e.status === 'lastro').length,
    backup: equipment.filter(e => e.status === 'backup').length,
    aplicado: equipment.filter(e => e.status === 'aplicado').length,
    manutencao: equipment.filter(e => e.status === 'manutencao_externa').length,
    descarte: equipment.filter(e => e.status === 'descarte').length,
  }

  const calVencendo = standards.filter(s => {
    if (!s.next_calibration) return false
    const dias = Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000)
    return dias <= 30
  })

  // Filtros
  const equipFiltrado = equipment.filter(e => {
    const matchSearch = !search || [e.asset_number, e.serial_number, e.brand, e.model, e.equipment_type, e.client_number]
      .some(v => v?.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = filterStatus === 'todos' || e.status === filterStatus
    return matchSearch && matchStatus
  })

  return (
    <div className="min-h-screen bg-[#f0f4f8] font-sans">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
              <Shield size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-black text-slate-900 leading-none">White Martins</h1>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">Lab. de Instrumentação</p>
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 active:scale-95 transition-all shadow-md shadow-blue-200">
            <Plus size={16} />
            <span className="hidden sm:inline">Novo Equipamento</span>
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Stats */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {[
            { label: 'Total', value: stats.total, color: 'text-slate-700', bg: 'bg-white' },
            { label: 'Lastro', value: stats.lastro, color: 'text-blue-600', bg: 'bg-blue-50' },
            { label: 'Backup', value: stats.backup, color: 'text-purple-600', bg: 'bg-purple-50' },
            { label: 'Aplicado', value: stats.aplicado, color: 'text-green-600', bg: 'bg-green-50' },
            { label: 'Manutenção', value: stats.manutencao, color: 'text-red-600', bg: 'bg-red-50' },
            { label: 'Descarte', value: stats.descarte, color: 'text-slate-500', bg: 'bg-slate-100' },
          ].map(s => (
            <div key={s.label} className={`${s.bg} rounded-2xl p-4 border border-slate-100`}>
              <p className={`text-2xl font-black ${s.color} leading-none`}>{s.value}</p>
              <p className="text-[10px] font-bold uppercase text-slate-500 mt-1 tracking-wide">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Alerta calibração */}
        {calVencendo.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-800">
                {calVencendo.length} padrão(ões) com calibração vencendo em 30 dias
              </p>
              <p className="text-xs text-amber-600 mt-0.5">
                {calVencendo.map(s => s.code).join(', ')}
              </p>
            </div>
          </div>
        )}

        {/* Busca e filtros */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por ativo, série, marca, modelo..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[['todos','Todos'], ...Object.entries(STATUS_CONFIG).map(([k,v]) => [k, v.label])].map(([k, v]) => (
              <button key={k} onClick={() => setFilterStatus(k)}
                className={`px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
                  filterStatus === k
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                }`}>
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Lista de equipamentos */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="p-12 flex items-center justify-center">
              <Activity size={24} className="text-blue-500 animate-spin" />
            </div>
          ) : equipFiltrado.length === 0 ? (
            <div className="p-12 text-center">
              <Package size={32} className="text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">
                {equipment.length === 0
                  ? 'Nenhum equipamento cadastrado ainda.'
                  : 'Nenhum equipamento encontrado.'}
              </p>
              {equipment.length === 0 && (
                <button onClick={() => setShowModal(true)}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all">
                  Cadastrar primeiro equipamento
                </button>
              )}
            </div>
          ) : (
            <div>
              {/* Cabeçalho da tabela */}
              <div className="hidden sm:grid grid-cols-[100px_1fr_120px_100px_100px_40px] gap-3 px-5 py-3 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-500">
                <span>Ativo</span>
                <span>Equipamento</span>
                <span>Série</span>
                <span>Status</span>
                <span>Endereço</span>
                <span></span>
              </div>
              {equipFiltrado.map((eq, i) => (
                <div key={eq.id}
                  className={`grid grid-cols-1 sm:grid-cols-[100px_1fr_120px_100px_100px_40px] gap-2 sm:gap-3 px-5 py-4 items-center border-b border-slate-100 hover:bg-slate-50 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/50'}`}>
                  <span className="font-black text-slate-900 text-sm">{eq.asset_number}</span>
                  <div>
                    <p className="font-semibold text-slate-800 text-sm leading-tight">
                      {[eq.brand, eq.model].filter(Boolean).join(' ') || eq.equipment_type || '—'}
                    </p>
                    {eq.equipment_type && <p className="text-xs text-slate-500 mt-0.5">{eq.equipment_type}</p>}
                  </div>
                  <span className="text-xs text-slate-500 font-mono">{eq.serial_number || '—'}</span>
                  <StatusBadge status={eq.status} />
                  <div className="flex items-center gap-1">
                    <MapPin size={11} className="text-slate-400 shrink-0" />
                    <span className="text-xs font-bold text-slate-600">{eq.location?.code || '—'}</span>
                  </div>
                  <button className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center hover:bg-blue-100 hover:text-blue-600 transition-all ml-auto">
                    <ChevronRight size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Rodapé */}
        <p className="text-center text-xs text-slate-400">
          {equipment.length} equipamento(s) registrado(s) · White Martins Lab
        </p>
      </div>

      {showModal && (
        <ModalEquipamento
          onClose={() => setShowModal(false)}
          onSaved={carregar}
        />
      )}
    </div>
  )
}