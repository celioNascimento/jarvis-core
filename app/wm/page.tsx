'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Package, MapPin, Wrench, AlertTriangle, CheckCircle,
  Clock, Plus, Search, Activity, Archive, RotateCcw,
  Trash2, X, Zap, ArrowRight, Droplets, ChevronRight,
  FileText, Download, LogOut, Scan, History, BarChart2,
  Menu, ChevronDown, Truck, Lock, Unlock
} from 'lucide-react'

// ── Clientes Supabase ────────────────────────────────────
let _auth: any = null
let _wm: any = null

function authClient() {
  if (typeof window === 'undefined') return null as any
  if (!_auth) _auth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { storageKey: 'wm-auth' } }
  )
  return _auth
}

function db() {
  if (typeof window === 'undefined') return null as any
  if (!_wm) _wm = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'white_martins' },
      auth: { storageKey: 'wm-auth' }
    }
  )
  return _wm
}
async function logout() {
  await authClient().auth.signOut()
  window.location.href = '/wm/login'
}

// ── Status ────────────────────────────────────────────────
const S: Record<string, { label: string; short: string; color: string; bg: string; border: string; dot: string; icon: any; next: string[] }> = {
  entrada:             { label: 'Entrada',        short: 'ENT',  color: '#92400e', bg: '#fffbeb', border: '#fde68a', dot: '#f59e0b', icon: Package,      next: ['avaliacao_bancada'] },
  avaliacao_bancada:   { label: 'Bancada',        short: 'BAN',  color: '#9a3412', bg: '#fff7ed', border: '#fed7aa', dot: '#f97316', icon: Activity,     next: ['limpeza','aguardando_pecas','aguardando_envio','manutencao_externa','descarte'] },
  aguardando_pecas:    { label: 'Ag. Peças',      short: 'PEÇ',  color: '#713f12', bg: '#fefce8', border: '#fef08a', dot: '#eab308', icon: Clock,        next: ['limpeza','aguardando_envio','manutencao_externa','descarte'] },
  aguardando_envio:    { label: 'Ag. Envio Ext.', short: 'ENV',  color: '#831843', bg: '#fdf2f8', border: '#fbcfe8', dot: '#ec4899', icon: Truck,        next: ['manutencao_externa','descarte'] },
  limpeza:             { label: 'Limpeza',        short: 'LIM',  color: '#155e75', bg: '#ecfeff', border: '#a5f3fc', dot: '#06b6d4', icon: Droplets,     next: ['lastro','backup','descarte'] },
  manutencao_externa:  { label: 'Manut. Externa', short: 'MAN',  color: '#7f1d1d', bg: '#fef2f2', border: '#fecaca', dot: '#ef4444', icon: Wrench,       next: ['limpeza','lastro','descarte'] },
  lastro:              { label: 'Lastro',         short: 'LAS',  color: '#1e3a8a', bg: '#eff6ff', border: '#bfdbfe', dot: '#3b82f6', icon: Archive,      next: ['backup','aplicado','descarte'] },
  backup:              { label: 'Backup',         short: 'BAK',  color: '#4c1d95', bg: '#f5f3ff', border: '#ddd6fe', dot: '#8b5cf6', icon: RotateCcw,    next: ['lastro','aplicado','descarte'] },
  aplicado:            { label: 'Aplicado',       short: 'APL',  color: '#14532d', bg: '#f0fdf4', border: '#bbf7d0', dot: '#22c55e', icon: CheckCircle,  next: ['limpeza','manutencao_externa','descarte'] },
  descarte:            { label: 'Descarte',       short: 'DESC', color: '#374151', bg: '#f9fafb', border: '#e5e7eb', dot: '#9ca3af', icon: Trash2,       next: [] },
}

const PART_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  novo:            { label: 'Novo',             color: '#14532d', bg: '#f0fdf4' },
  ok:              { label: 'OK',               color: '#1e3a8a', bg: '#eff6ff' },
  meia_vida:       { label: 'Meia Vida',        color: '#713f12', bg: '#fefce8' },
  necessita_troca: { label: 'Necessita Troca', color: '#7f1d1d', bg: '#fef2f2' },
  sem_estoque:     { label: 'Sem Estoque',      color: '#374151', bg: '#f3f4f6' },
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

// ── Modal de Verificação (Pré-Cadastro) ───────────────────
function ModalVerificaEntrada({ onClose, onCadastrar }: { onClose: () => void; onCadastrar: (ativo: string) => void }) {
  const [ativo, setAtivo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const verificar = async () => {
    if (!ativo.trim()) { setError('Digite o patrimônio'); return }
    setLoading(true); setError('')
    const { data } = await db().from('equipment').select('id').eq('asset_number', ativo.trim()).maybeSingle()
    setLoading(false)
    if (data) {
      window.location.href = `/wm/editar/${data.id}`
    } else {
      onCadastrar(ativo.trim())
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-sm rounded-3xl p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-black text-gray-900">Novo Cadastro</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center"><X size={14} /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Escaneie ou digite o patrimônio para iniciar. Se já existir, iremos para a edição.</p>
        
        <div className="relative mb-4">
          <Scan size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input 
            autoFocus
            value={ativo} 
            onChange={e => setAtivo(e.target.value)} 
            onKeyDown={e => e.key === 'Enter' && verificar()}
            className="w-full pl-10 pr-4 py-3 rounded-2xl border border-gray-200 text-base font-black text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" 
            placeholder="Nº Patrimônio" 
          />
        </div>
        {error && <p className="text-xs text-red-500 font-medium mb-4 text-center">{error}</p>}
        <button onClick={verificar} disabled={loading}
          className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60 flex items-center justify-center gap-2">
          {loading ? <Activity size={16} className="animate-spin" /> : <ArrowRight size={16} />} Continuar
        </button>
      </div>
    </div>
  )
}

// ── Modal Nova Entrada ────────────────────────────────────
const SENSOR_STATUS: Record<string, string> = { presente: 'Presente', saiu_com_paciente: 'Saiu c/ Paciente', em_outro_cliente: 'Em outro cliente', danificado: 'Danificado', ausente: 'Ausente' }
const FILTER_STATUS: Record<string, {label: string; color: string}> = { ok: { label: 'OK', color: 'text-green-600' }, meia_vida: { label: 'Meia Vida', color: 'text-yellow-600' }, necessita_troca: { label: 'Necessita Troca', color: 'text-red-600' }, novo: { label: 'Trocado', color: 'text-blue-600' }, sem_estoque: { label: 'Sem Estoque', color: 'text-gray-500' } }

function ModalEntrada({ initialAtivo, onClose, onSaved, onToast }: { initialAtivo?: string, onClose: () => void; onSaved: () => void; onToast: (msg: string) => void }) {
  const [tipo, setTipo] = useState<'concentrador'|'oximetro'>('concentrador')
  const [form, setForm] = useState<any>({
    asset_number: initialAtivo || '', serial_number: '', client_number: '',
    model_id: '', status: 'entrada', location_code: '',
    notes: '', entry_date: new Date().toISOString().slice(0, 10),
    flow_measurement: '', o2_concentration: '',
    filter_status: 'ok', filter_last_change: '', filter_next_change: '',
    cannula_status: 'ok', has_humidifier: false, opi_indicator: false,
    alarm_status: 'ok',
    sensor_adult_status: 'presente', sensor_pediatric_status: 'presente',
    sensor_adult_client: '', sensor_pediatric_client: '',
    battery_status: 'ok', display_status: 'ok',
    spo2_reading: '', hr_reading: '',
  })
  const [models, setModels] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [brands, setBrands] = useState<any[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  
  const [showNovoMod, setShowNovoMod] = useState(false)
  const [novoMod, setNovoMod] = useState({ brand_id: '', model: '', nickname: '', equipment_type: '', measure_unit: '', capacity: '' })
  
  const [showNovaMarca, setShowNovaMarca] = useState(false)
  const [novaMarcaNome, setNovaMarcaNome] = useState('')
  const [salvandoMod, setSalvandoMod] = useState(false)
  const [modSalvo, setModSalvo] = useState(false)

  useEffect(() => {
    Promise.all([
      db().from('equipment_models').select('*, equipment_brands(name)').order('nickname').order('model'),
      db().from('locations').select('id,code,area,description').eq('active', true).order('code'),
      db().from('equipment_brands').select('*').order('name')
    ]).then(([m, l, b]) => { 
      const formattedModels = (m.data || []).map((mod: any) => ({ ...mod, brand: mod.equipment_brands?.name || mod.brand }))
      setModels(formattedModels); setLocations(l.data || []); setBrands(b.data || [])
    })
  }, [])

  const modelSel = models.find(m => m.id === form.model_id)
  const modelsFilt = models.filter(m => {
    if (m.equipment_category && m.equipment_category !== tipo) return false
    if (!modelSearch) return true
    const s = modelSearch.toLowerCase()
    return [m.brand, m.model, m.nickname, m.equipment_type].some(v => v?.toLowerCase().includes(s))
  })

  const salvarMarca = async () => {
    if (!novaMarcaNome.trim()) return null
    const { data } = await db().from('equipment_brands').insert({ name: novaMarcaNome.trim() }).select().single()
    if (data) { setBrands(p => [...p, data].sort((a,b) => a.name.localeCompare(b.name))); setShowNovaMarca(false); setNovaMarcaNome(''); return data.id }
    return null
  }

  const salvarMod = async () => {
    if (!novoMod.model) return
    let brandId = novoMod.brand_id
    if (showNovaMarca && novaMarcaNome) { const newBrandId = await salvarMarca(); if (newBrandId) brandId = newBrandId }
    if (!brandId) { alert("Selecione ou crie uma marca."); return }

    setSalvandoMod(true)
    const { data, error } = await db().from('equipment_models').insert({
      brand_id: brandId, model: novoMod.model, nickname: novoMod.nickname || (tipo === 'concentrador' ? 'Concentrador' : 'Oxímetro'),
      equipment_type: novoMod.equipment_type || (tipo === 'concentrador' ? 'Concentrador de Oxigênio' : 'Oxímetro de Pulso'),
      capacity: novoMod.capacity, measure_unit: novoMod.measure_unit, equipment_category: tipo
    }).select('*, equipment_brands(name)').single()
    setSalvandoMod(false)
    if (error) { alert(error.message); return }
    if (data) {
      const formatMod = { ...data, brand: data.equipment_brands?.name }
      setModels(p => [...p, formatMod]); setForm((f: any) => ({...f, model_id: data.id})); setModSalvo(true)
      setTimeout(() => { setModSalvo(false); setShowNovoMod(false); setNovoMod({ brand_id: '', model: '', nickname: '', equipment_type: '', measure_unit: '', capacity: '' }) }, 1000)
    }
  }

  // GATILHO DE ABERTURA DE ATENDIMENTO (OS)
  const salvar = async () => {
    if (!form.asset_number.trim()) { setError('Número de patrimônio obrigatório'); return }
    setLoading(true); setError('')
    const loc = locations.find(l => l.code === form.location_code)
    const mod = models.find(m => m.id === form.model_id)
    
    const payload: any = {
      asset_number: form.asset_number.trim(), serial_number: form.serial_number || null, client_number: form.client_number || null,
      model_id: form.model_id || null, brand: mod?.brand || null, model: mod?.model || null,
      equipment_type: mod?.equipment_type || (tipo === 'concentrador' ? 'Concentrador de Oxigênio' : 'Oxímetro de Pulso'),
      measure_unit: mod?.measure_unit || null, equipment_category: tipo, status: form.status, location_id: loc?.id || null,
      notes: form.notes || null, entry_date: form.entry_date,
    }
    
    if (tipo === 'concentrador') {
      payload.flow_measurement = form.flow_measurement ? Number(form.flow_measurement) : null
      payload.o2_concentration = form.o2_concentration ? Number(form.o2_concentration) : null
      payload.filter_status = form.filter_status; payload.filter_last_change = form.filter_last_change || null; payload.filter_next_change = form.filter_next_change || null
      payload.cannula_status = form.cannula_status; payload.has_humidifier = form.has_humidifier; payload.opi_indicator = form.opi_indicator; payload.alarm_status = form.alarm_status
    } else {
      payload.sensor_adult_status = form.sensor_adult_status; payload.sensor_pediatric_status = form.sensor_pediatric_status
      payload.sensor_adult_client = form.sensor_adult_client || null; payload.sensor_pediatric_client = form.sensor_pediatric_client || null
      payload.battery_status = form.battery_status; payload.display_status = form.display_status
      payload.spo2_reading = form.spo2_reading ? Number(form.spo2_reading) : null; payload.hr_reading = form.hr_reading ? Number(form.hr_reading) : null
    }
    
    const { data: equipData, error: err } = await db().from('equipment').insert(payload).select().single()
    
    if (err) { 
      setLoading(false)
      setError(err.code === '23505' ? 'Patrimônio já cadastrado.' : err.message)
      return 
    }

    // Cria a OS mestra para este ciclo de atendimento
    const { data: osData } = await db().from('service_orders').insert({
      equipment_id: equipData.id,
      client_number: form.client_number || null,
      status: 'aberta'
    }).select().single()

    if (osData) {
      await db().from('movements').insert({
        equipment_id: equipData.id,
        from_status: 'entrada',
        to_status: form.status,
        performed_by: 'Celio',
        service_order_id: osData.id,
        client_number: form.client_number || null
      })
    }

    setLoading(false)
    onToast('Equipamento e Atendimento iniciados!')
    onSaved(); onClose()
  }

  const f = (field: string, val: any) => setForm((p: any) => ({...p, [field]: val}))

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[94vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 rounded-t-3xl z-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-black text-gray-900">Completar Cadastro</h2>
            <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center"><X size={14} /></button>
          </div>
          <div className="flex gap-2">
            {([['concentrador','Concentrador O₂'],['oximetro','Oxímetro']] as const).map(([t, label]) => (
              <button key={t} onClick={() => { setTipo(t); setForm((prev: any) => ({ ...prev, model_id: '' })) }}
                className={`flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${tipo === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-5 space-y-5">
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400"><span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">1</span> Identificação</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={lbl}>Nº Patrimônio *</label><input value={form.asset_number} onChange={e => f('asset_number', e.target.value)} className={inp + ' font-black text-base'} placeholder="Ex: 001234" /></div>
              <div><label className={lbl}>Série</label><input value={form.serial_number} onChange={e => f('serial_number', e.target.value)} className={inp} placeholder="S/N" /></div>
              <div><label className={lbl}>Nº Cliente</label><input value={form.client_number} onChange={e => f('client_number', e.target.value)} className={inp} /></div>
              <div><label className={lbl}>Nº Lacre</label><input value={form.seal_number || ''} onChange={e => f('seal_number', e.target.value)} className={inp} placeholder="Ex: LC-0012" /></div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400"><span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">2</span> Modelo</p>
              <button onClick={() => setShowNovoMod(!showNovoMod)} className="text-[10px] font-black text-blue-600 flex items-center gap-1"><Plus size={10} />Novo</button>
            </div>
            {showNovoMod && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <div className="flex justify-between items-end mb-1"><label className={lbl + " !mb-0"}>Marca *</label>{!showNovaMarca && <button onClick={() => setShowNovaMarca(true)} className="text-[9px] text-blue-600 font-bold">+ Cadastrar nova marca</button>}</div>
                    {showNovaMarca ? (
                      <div className="flex gap-2"><input autoFocus value={novaMarcaNome} onChange={e => setNovaMarcaNome(e.target.value)} className={inp} placeholder="Nome da nova marca..." /><button onClick={() => {setShowNovaMarca(false); setNovaMarcaNome('')}} className="px-3 rounded-xl border border-blue-200 text-blue-500 bg-white"><X size={14}/></button></div>
                    ) : (
                      <select value={novoMod.brand_id} onChange={e => setNovoMod({...novoMod, brand_id: e.target.value})} className={inp}><option value="">Selecione a marca...</option>{brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                    )}
                  </div>
                  <div className="col-span-2"><label className={lbl}>Modelo *</label><input value={novoMod.model} onChange={e => setNovoMod({...novoMod, model: e.target.value})} className={inp} placeholder="Ex: EverFlo" /></div>
                  <div className="col-span-2"><label className={lbl}>Apelido</label><input value={novoMod.nickname} onChange={e => setNovoMod({...novoMod, nickname: e.target.value})} className={inp} placeholder="Ex: Concentrador Philips 5L" /></div>
                  {tipo === 'concentrador' && (<div><label className={lbl}>Capacidade</label><input value={novoMod.capacity} onChange={e => setNovoMod({...novoMod, capacity: e.target.value})} className={inp} placeholder="Ex: 5L" /></div>)}
                  <div><label className={lbl}>Unidade</label><input value={novoMod.measure_unit} onChange={e => setNovoMod({...novoMod, measure_unit: e.target.value})} className={inp} placeholder="Ex: L/min" /></div>
                </div>
                <button onClick={salvarMod} disabled={salvandoMod || modSalvo} className={`w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${modSalvo ? 'bg-green-500 text-white' : 'bg-blue-600 text-white disabled:opacity-60'}`}>{modSalvo ? '✓ Modelo salvo!' : salvandoMod ? 'Salvando...' : 'Salvar modelo'}</button>
              </div>
            )}
            {modelSel ? (
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-2xl"><CheckCircle size={14} className="text-green-600 shrink-0" /><div className="flex-1"><p className="text-sm font-black text-green-800">{modelSel.nickname || modelSel.equipment_type}</p><p className="text-[11px] text-green-600">{modelSel.brand} {modelSel.model}{modelSel.capacity ? ` · ${modelSel.capacity}` : ''}{modelSel.measure_unit ? ` · ${modelSel.measure_unit}` : ''}</p></div><button onClick={() => f('model_id', '')}><X size={12} className="text-green-400" /></button></div>
            ) : (
              <div className="border border-gray-200 rounded-2xl overflow-hidden"><div className="relative border-b border-gray-100"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" /><input value={modelSearch} onChange={e => setModelSearch(e.target.value)} className="w-full pl-9 pr-4 py-2.5 text-sm outline-none" placeholder="Buscar apelido, marca..." /></div><div className="max-h-32 overflow-y-auto">{modelsFilt.length === 0 ? <p className="p-3 text-xs text-gray-400 text-center">{models.length === 0 ? 'Nenhum modelo.' : 'Sem resultados.'}</p> : modelsFilt.slice(0,12).map(m => (<button key={m.id} onClick={() => { f('model_id', m.id); setModelSearch('') }} className="w-full px-4 py-2.5 text-left hover:bg-gray-50 flex items-center gap-2 border-b border-gray-50 last:border-0"><span className="text-sm font-bold text-gray-800">{m.nickname || m.equipment_type || '—'}</span><span className="text-xs text-gray-400">{m.brand} {m.model}{m.capacity ? ` ${m.capacity}` : ''}</span></button>))}</div></div>
            )}
          </div>

          {tipo === 'concentrador' ? (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400"><span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">3</span> Avaliação — Concentrador</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={lbl}>Fluxo medido (L/min)</label><input type="number" step="0.1" value={form.flow_measurement} onChange={e => f('flow_measurement', e.target.value)} className={inp} placeholder="Ex: 4.8" /></div>
                <div><label className={lbl}>Concentração O₂ (%)</label><input type="number" step="0.1" min="0" max="100" value={form.o2_concentration} onChange={e => f('o2_concentration', e.target.value)} className={inp} placeholder="Ex: 93" /></div>
              </div>
              <div><label className={lbl}>Filtro de Ar</label><div className="flex gap-2 flex-wrap mb-2">{Object.entries(FILTER_STATUS).map(([k, v]) => (<button key={k} onClick={() => f('filter_status', k)} className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.filter_status === k ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>{v.label}</button>))}</div><div className="grid grid-cols-2 gap-3"><div><label className={lbl}>Última troca</label><input type="date" value={form.filter_last_change} onChange={e => f('filter_last_change', e.target.value)} className={inp} /></div><div><label className={lbl}>Próxima troca</label><input type="date" value={form.filter_next_change} onChange={e => f('filter_next_change', e.target.value)} className={inp} /></div></div></div>
              <div><label className={lbl}>Cânula / Cateter</label><div className="flex gap-2 flex-wrap">{Object.entries(FILTER_STATUS).filter(([k]) => k !== 'sem_estoque').map(([k, v]) => (<button key={k} onClick={() => f('cannula_status', k)} className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.cannula_status === k ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>{v.label}</button>))}</div></div>
              <div className="grid grid-cols-2 gap-3"><div><label className={lbl}>Alarme</label><select value={form.alarm_status} onChange={e => f('alarm_status', e.target.value)} className={inp}><option value="ok">OK</option><option value="falha">Falha</option><option value="nao_testado">Não testado</option></select></div></div>
              <div className="flex gap-4"><label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.has_humidifier} onChange={e => f('has_humidifier', e.target.checked)} className="w-4 h-4 accent-blue-600" /><span className="text-sm font-semibold text-gray-700">Tem umidificador</span></label><label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.opi_indicator} onChange={e => f('opi_indicator', e.target.checked)} className="w-4 h-4 accent-blue-600" /><span className="text-sm font-semibold text-gray-700">Tem OPI</span></label></div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400"><span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-black">3</span> Avaliação — Oxímetro</p>
              <div className="grid grid-cols-2 gap-3"><div><label className={lbl}>SpO₂ medido (%)</label><input type="number" step="0.1" min="0" max="100" value={form.spo2_reading} onChange={e => f('spo2_reading', e.target.value)} className={inp} placeholder="Ex: 98" /></div><div><label className={lbl}>Freq. Cardíaca (bpm)</label><input type="number" value={form.hr_reading} onChange={e => f('hr_reading', e.target.value)} className={inp} placeholder="Ex: 72" /></div></div>
              <div className="space-y-3">
                <label className={lbl}>Sensor Adulto</label><div className="flex gap-2 flex-wrap">{Object.entries(SENSOR_STATUS).map(([k, v]) => (<button key={k} onClick={() => f('sensor_adult_status', k)} className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.sensor_adult_status === k ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>{v}</button>))}</div>{(form.sensor_adult_status === 'saiu_com_paciente' || form.sensor_adult_status === 'em_outro_cliente') && (<input value={form.sensor_adult_client} onChange={e => f('sensor_adult_client', e.target.value)} className={inp} placeholder="Nº do cliente com o sensor" />)}
                <label className={lbl}>Sensor Pediátrico</label><div className="flex gap-2 flex-wrap">{Object.entries(SENSOR_STATUS).map(([k, v]) => (<button key={k} onClick={() => f('sensor_pediatric_status', k)} className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.sensor_pediatric_status === k ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>{v}</button>))}</div>{(form.sensor_pediatric_status === 'saiu_com_paciente' || form.sensor_pediatric_status === 'em_outro_cliente') && (<input value={form.sensor_pediatric_client} onChange={e => f('sensor_pediatric_client', e.target.value)} className={inp} placeholder="Nº do cliente com o sensor" />)}
              </div>
              <div className="grid grid-cols-2 gap-3"><div><label className={lbl}>Bateria</label><select value={form.battery_status} onChange={e => f('battery_status', e.target.value)} className={inp}><option value="ok">OK</option><option value="fraca">Fraca</option><option value="necessita_troca">Necessita troca</option></select></div><div><label className={lbl}>Display</label><select value={form.display_status} onChange={e => f('display_status', e.target.value)} className={inp}><option value="ok">OK</option><option value="danificado">Danificado</option></select></div></div>
            </div>
          )}

          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-300"><span className="w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[9px] flex items-center justify-center font-black">4</span> Destino e localização</p>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {(['entrada','avaliacao_bancada','aguardando_pecas','limpeza','manutencao_externa'] as const).map(s => {
                const cfg = S[s]; const Icon = cfg.icon; const sel = form.status === s
                return (<button key={s} onClick={() => f('status', s)} style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}} className={`flex flex-col items-center gap-1 p-2.5 rounded-2xl border-2 transition-all ${sel ? '' : 'border-gray-200 text-gray-400'}`}><Icon size={15} /><span className="text-[9px] font-black uppercase leading-tight text-center">{cfg.label}</span></button>)
              })}
            </div>
            <select value={form.location_code} onChange={e => f('location_code', e.target.value)} className={inp}><option value="">— Sem endereço —</option>{['sala_lastro','container','armario','externo'].map(area => (<optgroup key={area} label={area.replace('_',' ').toUpperCase()}>{locations.filter(l => l.area === area).map(l => <option key={l.id} value={l.code}>{l.code} — {l.description}</option>)}</optgroup>))}</select>
            <div className="grid grid-cols-2 gap-3"><div><label className={lbl}>Data entrada</label><input type="date" value={form.entry_date} onChange={e => f('entry_date', e.target.value)} className={inp} /></div></div>
            <textarea value={form.notes} onChange={e => f('notes', e.target.value)} className={inp + ' resize-none'} rows={2} placeholder="Observações adicionais..." />
          </div>
          {error && <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200"><AlertTriangle size={13} className="text-red-500" /><p className="text-xs text-red-600">{error}</p></div>}
          <button onClick={salvar} disabled={loading} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60 shadow-lg shadow-blue-100">{loading ? 'Registrando...' : `Registrar ${tipo === 'concentrador' ? 'Concentrador' : 'Oxímetro'}`}</button>
        </div>
      </div>
    </div>
  )
}

function PecasEquipamento({ equipId, modelId, onToast }: { equipId: string; modelId?: string; onToast: (msg:string)=>void }) {
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
      .then(({ data }: { data: any[] | null }) => {
        setPecas(data || [])
        db().from('equipment_part_status').select('spare_part_id,status,notes').eq('equipment_id', equipId)
          .then(({ data: est }: { data: any[] | null }) => {
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
      
      // INTELIGÊNCIA DE ESTOQUE: Só dá baixa se for marcado como 'novo'
      if (status === 'novo') {
        const p = pecas.find(x => x.id === partId)
        if (p && p.stock_current > 0) await db().from('spare_parts').update({ stock_current: p.stock_current - 1 }).eq('id', partId)
      }
    }
    setSalvando(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
    onToast('Estado das peças atualizado!')
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
                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${p.stock_current === 0 ? 'bg-red-100 text-red-600' : p.stock_current <= p.stock_minimum ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>estoque: {p.stock_current}</span>
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
              <input value={notas[p.id] || ''} onChange={e => setNotas(n => ({...n, [p.id]: e.target.value}))} className="mt-2 w-full px-3 py-2 rounded-xl border border-gray-200 text-xs text-gray-600 outline-none focus:border-blue-400" placeholder="Observação..." />
            )}
          </div>
        ))}
      </div>
      <button onClick={salvar} disabled={salvando || saved} className={`w-full mt-4 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${saved ? 'bg-green-500 text-white' : 'bg-gray-900 text-white hover:bg-gray-800'}`}>{saved ? '✓ Salvo' : salvando ? 'Salvando...' : 'Salvar estado das peças'}</button>
    </div>
  )
}

function AbaFluxo({ initialAtivo = '', onMoved, onToast }: { initialAtivo?: string; onMoved?: () => void; onToast: (msg:string, type?:'success'|'error')=>void }) {
  const [ativo, setAtivo] = useState(initialAtivo)
  const [equip, setEquip] = useState<any>(null)
  const [historico, setHistorico] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [novoStatus, setNovoStatus] = useState('')
  const [motivo, setMotivo] = useState('')
  
  const [osNumber, setOsNumber] = useState('')
  const [clientNumber, setClientNumber] = useState('')
  
  const [isBlocking, setIsBlocking] = useState(false)
  const [blockReason, setBlockReason] = useState('')

  const [salvando, setSalvando] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => { if (initialAtivo) buscar() }, [initialAtivo])

  // LÓGICA DE BUSCA: Recupera a OS aberta existente
  const buscar = async () => {
    if (!ativo.trim()) return
    setLoading(true); setNotFound(false); setEquip(null); setHistorico([]); setIsBlocking(false); setBlockReason('')
    
    const { data } = await db().from('equipment')
      .select('*, location:locations(code), equipment_model:equipment_models(brand,model,nickname,measure_unit)')
      .eq('asset_number', ativo.trim()).maybeSingle()
    
    if (data) {
      setEquip(data); 
      setNovoStatus(S[data.status]?.next[0] || '')
      
      // INTELIGÊNCIA: Busca OS ativa para preencher os campos automaticamente
      const { data: activeOS } = await db().from('service_orders')
        .select('os_number, client_number')
        .eq('equipment_id', data.id)
        .eq('status', 'aberta')
        .maybeSingle()
      
      if (activeOS) {
        setOsNumber(activeOS.os_number || '')
        setClientNumber(activeOS.client_number || data.client_number || '')
      }

      const { data: mov } = await db().from('movements').select('*').eq('equipment_id', data.id).order('moved_at', { ascending: false })
      setHistorico(mov || [])
    } else setNotFound(true)
    setLoading(false)
  }

  // LÓGICA DE MOVIMENTAÇÃO: Incorpora número de OS e gerencia ciclo de vida
  const mover = async () => {
    if (!novoStatus || !equip) return
    setSalvando(true)
    
    const { data: activeOS } = await db().from('service_orders')
      .select('id')
      .eq('equipment_id', equip.id)
      .eq('status', 'aberta')
      .maybeSingle()
    
    // INTELIGÊNCIA: Incorporação dinâmica da OS antes de mover
    if (activeOS && osNumber) {
      await db().from('service_orders')
        .update({ os_number: osNumber, client_number: clientNumber || null })
        .eq('id', activeOS.id)
    }

    // Registra a movimentação vinculada
    await db().from('movements').insert({ 
      equipment_id: equip.id, 
      from_status: equip.status, 
      to_status: novoStatus, 
      reason: motivo || null, 
      performed_by: 'Celio',
      os_number: osNumber || null,
      client_number: clientNumber || null,
      service_order_id: activeOS?.id || null
    })

    const payloadUpdate: any = { status: novoStatus }
    if (clientNumber) payloadUpdate.client_number = clientNumber
    await db().from('equipment').update(payloadUpdate).eq('id', equip.id)
    
    // GATILHO DE FECHAMENTO: Encerra o atendimento nos estados de saída
    if (activeOS && ['lastro', 'backup', 'descarte'].includes(novoStatus)) {
      await db().from('service_orders')
        .update({ status: 'fechada', closed_at: new Date().toISOString() })
        .eq('id', activeOS.id)
    }
    
    const updatedEquip = { ...equip, ...payloadUpdate }
    setEquip(updatedEquip); setNovoStatus(S[novoStatus]?.next[0] || ''); setMotivo(''); setOsNumber(''); setClientNumber('')
    
    const { data: mov } = await db().from('movements').select('*').eq('equipment_id', equip.id).order('moved_at', { ascending: false })
    setHistorico(mov || []); setSalvando(false); onMoved?.()
    onToast(`Movido para ${S[novoStatus]?.label}`)
  }

  const toggleBloqueio = async () => {
    if (!isBlocking && !equip.is_blocked) { setIsBlocking(true); return }
    if (isBlocking && !blockReason.trim()) { onToast('Informe o motivo do bloqueio', 'error'); return }

    setSalvando(true)
    const newBlockedState = !equip.is_blocked
    await db().from('equipment').update({ 
      is_blocked: newBlockedState, 
      block_reason: newBlockedState ? blockReason : null 
    }).eq('id', equip.id)

    setEquip({ ...equip, is_blocked: newBlockedState, block_reason: newBlockedState ? blockReason : null })
    setIsBlocking(false); setBlockReason(''); setSalvando(false); onMoved?.()
    onToast(newBlockedState ? 'Equipamento Bloqueado' : 'Equipamento Desbloqueado')
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Número de patrimônio</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Scan size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={ativo} onChange={e => setAtivo(e.target.value)} onKeyDown={e => e.key === 'Enter' && buscar()} className="w-full pl-10 pr-4 py-3 rounded-2xl border border-gray-200 text-base font-black text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" placeholder="Digite ou escaneie" />
          </div>
          <button onClick={buscar} disabled={loading} className="px-5 py-3 bg-blue-600 text-white rounded-2xl font-black text-sm hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60">{loading ? <Activity size={16} className="animate-spin" /> : <ArrowRight size={16} />}</button>
        </div>
        {notFound && <p className="mt-3 text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertTriangle size={12} />Ativo não encontrado.</p>}
      </div>

      {equip && (
        <>
          <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-2xl font-black text-gray-900">{equip.asset_number}</p>
                <p className="text-sm text-gray-500 mt-0.5">{equip.equipment_model?.nickname || equip.equipment_type || '—'}{(equip.equipment_model?.brand || equip.brand) && <span className="text-gray-400 ml-2 text-xs">{equip.equipment_model?.brand || equip.brand} {equip.equipment_model?.model || equip.model}</span>}</p>
              </div>
              <Badge status={equip.status} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[['Série', equip.serial_number || '—'], ['Cliente', equip.client_number || '—'], ['Local', equip.location?.code || '—']].map(([l, v]) => (
                <div key={l} className="bg-gray-50 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase tracking-widest text-gray-400">{l}</p><p className="text-sm font-bold text-gray-700 mt-1">{v}</p></div>
              ))}
            </div>
          </div>

          {equip.status === 'avaliacao_bancada' && <PecasEquipamento equipId={equip.id} modelId={equip.model_id} onToast={onToast} />}

          {equip.is_blocked ? (
            <div className="bg-red-50 border border-red-200 rounded-3xl p-5 shadow-sm space-y-4">
              <div className="flex items-center gap-2"><Lock size={18} className="text-red-600" /><h3 className="font-black text-red-800 text-sm uppercase tracking-widest">Equipamento Bloqueado</h3></div>
              <p className="text-sm text-red-700 bg-red-100 p-3 rounded-xl border border-red-200"><strong>Motivo:</strong> {equip.block_reason}</p>
              <button onClick={toggleBloqueio} disabled={salvando} className="w-full py-3.5 bg-red-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-red-700 transition-all flex items-center justify-center gap-2"><Unlock size={16}/> Liberar Equipamento</button>
            </div>
          ) : (
            <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm space-y-4">
              {S[equip.status]?.next.length > 0 && !isBlocking && (
                <>
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Próximo passo</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge status={equip.status} />
                    <ArrowRight size={14} className="text-gray-300 shrink-0" />
                    <div className="flex gap-2 flex-wrap">
                      {S[equip.status].next.map(s => {
                        const cfg = S[s]; const Icon = cfg.icon; const sel = novoStatus === s
                        return (<button key={s} onClick={() => setNovoStatus(s)} style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}} className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-bold transition-all ${sel ? '' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}><Icon size={13} />{cfg.label}</button>)
                      })}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div><label className={lbl}>Ordem de Serviço (OS)</label><input value={osNumber} onChange={e => setOsNumber(e.target.value)} className={inp} placeholder="Ex: OS-9988" /></div>
                    <div><label className={lbl}>Nº Cliente (Origem/Destino)</label><input value={clientNumber} onChange={e => setClientNumber(e.target.value)} className={inp} placeholder="Ex: 554433" /></div>
                  </div>

                  <textarea value={motivo} onChange={e => setMotivo(e.target.value)} className={inp + ' resize-none'} rows={2} placeholder="Motivo / observação (opcional)..." />
                  <button onClick={mover} disabled={salvando || !novoStatus} className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60">{salvando ? 'Movendo...' : 'Confirmar Movimentação'}</button>
                  <div className="w-full h-px bg-gray-100 my-2"></div>
                </>
              )}
              
              {!isBlocking ? (
                <button onClick={toggleBloqueio} className="w-full py-2 text-xs font-black text-red-500 hover:bg-red-50 rounded-xl transition-all flex items-center justify-center gap-1"><Lock size={12}/> Sinalizar Pendência / Bloquear</button>
              ) : (
                <div className="space-y-3 p-4 bg-red-50 rounded-2xl border border-red-200">
                  <p className="text-[10px] font-black uppercase tracking-widest text-red-600">Motivo do Bloqueio</p>
                  <textarea value={blockReason} onChange={e => setBlockReason(e.target.value)} className={inp + ' border-red-200 focus:border-red-500 focus:ring-red-100 resize-none'} rows={2} autoFocus placeholder="Descreva o motivo que impede este equipamento de avançar..." />
                  <div className="flex gap-2">
                    <button onClick={toggleBloqueio} disabled={salvando} className="flex-1 py-3 bg-red-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-red-700 transition-all">{salvando ? 'Bloqueando...' : 'Confirmar Bloqueio'}</button>
                    <button onClick={() => {setIsBlocking(false); setBlockReason('')}} className="px-4 py-3 bg-white border border-red-200 text-red-600 rounded-xl font-black text-xs">Cancelar</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {historico.length > 0 && (
            <div className="bg-white rounded-3xl border border-gray-200 p-5 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2"><History size={11} />Histórico</p>
              <div className="space-y-2">
                {historico.map(m => (
                  <div key={m.id} className="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0 flex-wrap">
                    <Badge status={m.from_status} size="sm" /><ArrowRight size={10} className="text-gray-300 shrink-0" /><Badge status={m.to_status} size="sm" />
                    {(m.os_number || m.client_number) && (
                      <span className="text-[10px] font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 flex items-center gap-1 shrink-0">
                        {m.os_number && <span>OS: {m.os_number}</span>}
                        {m.os_number && m.client_number && <span>|</span>}
                        {m.client_number && <span>CLI: {m.client_number}</span>}
                      </span>
                    )}
                    {m.reason && <span className="text-xs text-gray-400 flex-1 min-w-0 truncate">{m.reason}</span>}
                    <span className="text-[10px] text-gray-300 ml-auto">{fmtDate(m.moved_at)}</span>
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
            <div key={p.id} className="flex justify-between text-xs py-1"><span className="text-red-600 font-medium">{p.name}</span><span className="font-black text-red-700">{p.stock_current}/{p.stock_minimum} {p.unit}</span></div>
          ))}
        </div>
      )}
      {semEstoque.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-3 flex items-center gap-2"><Clock size={11} />Equipamentos com peças pendentes</p>
          {semEstoque.map(s => (
            <div key={s.id} className="flex items-center gap-3 py-1.5 border-b border-amber-100 last:border-0">
              <span className="font-black text-amber-800 text-xs w-16 shrink-0">{s.equipment?.asset_number}</span><span className="text-xs text-amber-700 flex-1">{s.spare_part?.name}</span><span style={{ background: PART_STATUS[s.status]?.bg, color: PART_STATUS[s.status]?.color }} className="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase">{PART_STATUS[s.status]?.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between"><p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Estoque</p><button onClick={() => setShowNova(!showNova)} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700"><Plus size={12} />Nova Peça</button></div>
      {showNova && (
        <div className="bg-white border border-blue-200 rounded-2xl p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3"><div className="col-span-2"><label className={lbl}>Nome *</label><input value={nova.name} onChange={e => setNova({...nova, name: e.target.value})} className={inp} placeholder="Ex: Filtro de cabeceira EverFlo" /></div><div><label className={lbl}>Referência</label><input value={nova.reference} onChange={e => setNova({...nova, reference: e.target.value})} className={inp} /></div><div><label className={lbl}>Categoria</label><select value={nova.category} onChange={e => setNova({...nova, category: e.target.value})} className={inp}>{Object.entries(catLabel).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="col-span-2"><label className={lbl}>Compatível com (vazio = genérico)</label><select value={nova.compatible_model_id} onChange={e => setNova({...nova, compatible_model_id: e.target.value})} className={inp}><option value="">— Genérico —</option>{models.map(m => <option key={m.id} value={m.id}>{m.nickname || ''} {m.brand} {m.model}</option>)}</select></div><div><label className={lbl}>Estoque atual</label><input type="number" min={0} value={nova.stock_current} onChange={e => setNova({...nova, stock_current: Number(e.target.value)})} className={inp} /></div><div><label className={lbl}>Mínimo</label><input type="number" min={1} value={nova.stock_minimum} onChange={e => setNova({...nova, stock_minimum: Number(e.target.value)})} className={inp} /></div><div><label className={lbl}>Unidade</label><input value={nova.unit} onChange={e => setNova({...nova, unit: e.target.value})} className={inp} placeholder="un" /></div><div><label className={lbl}>Local</label><input value={nova.location_code} onChange={e => setNova({...nova, location_code: e.target.value})} className={inp} placeholder="Ex: AP-A2" /></div></div>
          <div className="flex gap-2"><button onClick={salvarPeca} disabled={salvando} className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-60">{salvando ? 'Salvando...' : 'Cadastrar'}</button><button onClick={() => setShowNova(false)} className="px-4 py-3 rounded-xl border border-gray-200 text-xs font-black text-gray-500">Cancelar</button></div>
        </div>
      )}
      {loading ? <div className="p-8 flex items-center justify-center bg-white rounded-2xl border border-gray-200"><Activity size={20} className="text-blue-500 animate-spin" /></div>
      : pecas.length === 0 ? <div className="p-8 text-center bg-white rounded-2xl border border-gray-200"><Zap size={24} className="text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">Nenhuma peça cadastrada.</p></div>
      : ['filtro','sensor','acessorio','consumivel'].map(cat => {
          const lista = pecas.filter(p => p.category === cat)
          if (!lista.length) return null
          return (
            <div key={cat} className="bg-white rounded-2xl border border-gray-200 overflow-hidden"><div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100"><p className="text-[9px] font-black uppercase tracking-widest text-gray-400">{catLabel[cat]}</p></div>{lista.map(p => { const crit = p.stock_current <= p.stock_minimum; const zero = p.stock_current === 0; return (<div key={p.id} className="px-4 py-3.5 flex items-center gap-3 border-b border-gray-50 last:border-0"><div className="flex-1 min-w-0"><p className="text-sm font-bold text-gray-800 truncate">{p.name}</p><div className="flex items-center gap-2 mt-0.5 flex-wrap">{p.reference && <span className="text-[10px] text-gray-400 font-mono">{p.reference}</span>}{p.compatible_model ? <span className="text-[10px] text-blue-500">{p.compatible_model.nickname || p.compatible_model.brand} {p.compatible_model.model}</span> : <span className="text-[10px] text-gray-300">genérico</span>}{p.location_code && <span className="text-[10px] text-gray-400">{p.location_code}</span>}</div></div><div className="flex items-center gap-2 shrink-0"><button onClick={() => ajustar(p.id, -1, p.stock_current)} className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100 font-black text-base leading-none">−</button><div className={`text-center w-12 py-1 rounded-xl border ${zero ? 'bg-red-50 border-red-200' : crit ? 'bg-yellow-50 border-yellow-200' : 'bg-gray-50 border-gray-200'}`}><p className={`text-sm font-black ${zero ? 'text-red-600' : crit ? 'text-yellow-700' : 'text-gray-700'}`}>{p.stock_current}</p><p className="text-[8px] text-gray-400">/{p.stock_minimum}</p></div><button onClick={() => ajustar(p.id, 1, p.stock_current)} className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100 font-black text-base leading-none">+</button></div></div>) })}</div>
          )
        })
      }
    </div>
  )
}

function exportExcel(dados: any[], nome: string, titulo: string) {
  if (!dados.length) return
  const headers = Object.keys(dados[0]).filter(k => typeof dados[0][k] !== 'object')
  const rows = dados.map(d => headers.map(h => d[h] ?? '').join('\t')).join('\n')
  const csv = `${titulo}\n\n` + headers.join('\t') + '\n' + rows
  const blob = new Blob([csv], { type: 'text/tab-separated-values;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${nome}_${new Date().toISOString().slice(0,10)}.xls`
  a.click(); URL.revokeObjectURL(url)
}

function AbaRelatorios() {
  const [tipo, setTipo] = useState<string | null>(null)
  const [dados, setDados] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [periodo, setPeriodo] = useState({ de: '', ate: '' })

  const rels = [
    { id: 'por_status',    icon: BarChart2,     label: 'Por Status',              desc: 'Todos os equipamentos por status' },
    { id: 'manutencao',    icon: Wrench,        label: 'Manutenção Pendente',     desc: 'Em manutenção ou bancada' },
    { id: 'ag_pecas',      icon: Clock,         label: 'Aguardando Peças',        desc: 'Parados por falta de peça' },
    { id: 'ag_envio',      icon: Truck,         label: 'Ag. Envio Manutenção',    desc: 'Aguardando envio externo' },
    { id: 'calibracao',    icon: AlertTriangle, label: 'Calibração Vencendo',     desc: 'Padrões nos próximos 60 dias' },
    { id: 'movimentacoes', icon: Activity,      label: 'Movimentações',           desc: 'Por período' },
    { id: 'pecas_criticas',icon: Zap,           label: 'Peças Críticas',          desc: 'Abaixo do estoque mínimo' },
  ]

  const gerar = async (id: string) => {
    setTipo(id); setLoading(true); setDados([])
    let res: any[] = []
    if (id === 'por_status') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').order('status').order('asset_number'); res = data || [] }
    else if (id === 'manutencao') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').in('status', ['manutencao_externa','avaliacao_bancada']).order('entry_date'); res = data || [] }
    else if (id === 'ag_pecas') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').eq('status', 'aguardando_pecas').order('entry_date'); res = data || [] }
    else if (id === 'ag_envio') { const { data } = await db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)').eq('status', 'aguardando_envio').order('entry_date'); res = data || [] }
    else if (id === 'calibracao') { const em60 = new Date(Date.now() + 60*24*60*60*1000).toISOString().slice(0,10); const { data } = await db().from('standards').select('*').lte('next_calibration', em60).order('next_calibration'); res = data || [] }
    else if (id === 'movimentacoes') { let q = db().from('movements').select('*, equipment:equipment(asset_number,brand,model)'); if (periodo.de) q = q.gte('moved_at', periodo.de); if (periodo.ate) q = q.lte('moved_at', periodo.ate + 'T23:59:59'); const { data } = await q.order('moved_at', { ascending: false }).limit(200); res = data || [] }
    else if (id === 'pecas_criticas') { const { data } = await db().from('spare_parts').select('*, compatible_model:equipment_models(brand,model,nickname)').order('stock_current'); res = (data || []).filter((p: any) => p.stock_current <= p.stock_minimum) }
    setDados(res); setLoading(false)
  }

  const relAtual = rels.find(r => r.id === tipo)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {rels.map(r => { const Icon = r.icon; return (
          <button key={r.id} onClick={() => gerar(r.id)} className={`text-left p-4 rounded-2xl border-2 transition-all hover:shadow-sm active:scale-[0.98] ${tipo === r.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}><Icon size={16} className={tipo === r.id ? 'text-blue-600' : 'text-gray-400'} /><p className={`text-xs font-black mt-2 leading-tight ${tipo === r.id ? 'text-blue-700' : 'text-gray-700'}`}>{r.label}</p><p className="text-[10px] text-gray-400 mt-1">{r.desc}</p></button>
        )})}
      </div>
      {tipo === 'movimentacoes' && (<div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap gap-3 items-end"><div className="flex-1 min-w-[140px]"><label className={lbl}>De</label><input type="date" value={periodo.de} onChange={e => setPeriodo({...periodo, de: e.target.value})} className={inp} /></div><div className="flex-1 min-w-[140px]"><label className={lbl}>Até</label><input type="date" value={periodo.ate} onChange={e => setPeriodo({...periodo, ate: e.target.value})} className={inp} /></div><button onClick={() => gerar('movimentacoes')} className="px-4 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">Filtrar</button></div>)}
      {loading && <div className="bg-white rounded-2xl border border-gray-200 p-8 flex items-center justify-center"><Activity size={20} className="text-blue-500 animate-spin" /></div>}
      {!loading && dados.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
            <div><h3 className="text-sm font-black text-gray-800 uppercase">{relAtual?.label}</h3><p className="text-[10px] font-black uppercase tracking-widest text-gray-500 mt-0.5">{dados.length} registro(s) encontrados</p></div>
            <div className="flex items-center gap-3"><button onClick={() => window.print()} className="flex items-center gap-1.5 text-xs font-bold text-blue-600"><Download size={13} />PDF</button><button onClick={() => exportExcel(dados, tipo || 'relatorio', relAtual?.label || 'Relatório')} className="flex items-center gap-1.5 text-xs font-bold text-green-600"><Download size={13} />Excel</button></div>
          </div>
          <div className="divide-y divide-gray-50">
            {(tipo === 'por_status' || tipo === 'manutencao' || tipo === 'ag_pecas' || tipo === 'ag_envio') && dados.map(eq => (
              <div key={eq.id} className="px-4 py-3 flex items-center gap-3">
                <span className="font-black text-gray-900 text-sm w-20 shrink-0">{eq.asset_number}</span><div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-700 truncate">{eq.equipment_model?.nickname || eq.equipment_type || '—'}<span className="text-gray-400 font-normal ml-1 text-xs">{eq.equipment_model?.brand} {eq.equipment_model?.model}</span></p></div><Badge status={eq.status} size="sm" /><span className="text-xs text-gray-400 shrink-0">{eq.location?.code || '—'}</span>
              </div>
            ))}
            {tipo === 'calibracao' && dados.map(s => { const dias = Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000); return (
              <div key={s.id} className="px-4 py-3 flex items-center gap-3"><span className="font-black text-gray-900 text-sm w-24 shrink-0">{s.code}</span><p className="text-sm font-semibold text-gray-700 flex-1">{s.brand} {s.model}</p><span className={`text-xs font-bold px-2 py-0.5 rounded-full ${dias < 0 ? 'bg-red-100 text-red-600' : dias <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-yellow-50 text-yellow-700'}`}>{dias < 0 ? `${Math.abs(dias)}d vencido` : `${dias}d`}</span><span className="text-xs text-gray-400 shrink-0">{fmtDate(s.next_calibration)}</span></div>
            )})}
            {tipo === 'movimentacoes' && dados.map(m => (
              <div key={m.id} className="px-4 py-3 flex items-center gap-2 flex-wrap">
                <span className="font-black text-gray-700 text-xs w-16 shrink-0">{m.equipment?.asset_number}</span><Badge status={m.from_status} size="sm" /><ArrowRight size={10} className="text-gray-300" /><Badge status={m.to_status} size="sm" />
                {(m.os_number || m.client_number) && (<span className="text-[10px] font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 flex items-center gap-1 shrink-0">{m.os_number && <span>OS: {m.os_number}</span>}{m.os_number && m.client_number && <span>|</span>}{m.client_number && <span>CLI: {m.client_number}</span>}</span>)}
                {m.reason && <span className="text-xs text-gray-400 flex-1 truncate">{m.reason}</span>}<span className="text-[10px] text-gray-300 ml-auto">{fmtDate(m.moved_at)}</span>
              </div>
            ))}
            {tipo === 'pecas_criticas' && dados.map(p => (
              <div key={p.id} className="px-4 py-3 flex items-center gap-3"><div className="flex-1 min-w-0"><p className="text-sm font-bold text-gray-800">{p.name}</p><p className="text-xs text-gray-400">{p.compatible_model ? `${p.compatible_model.nickname || p.compatible_model.brand} ${p.compatible_model.model}` : 'genérico'}</p></div><span className={`text-sm font-black px-3 py-1 rounded-xl ${p.stock_current === 0 ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-700'}`}>{p.stock_current}/{p.stock_minimum} {p.unit}</span></div>
            ))}
          </div>
        </div>
      )}
      {!loading && tipo && dados.length === 0 && <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center"><p className="text-gray-400 text-sm">Nenhum registro encontrado.</p></div>}
    </div>
  )
}

function DrawerEquipamento({ equip, onClose, onUpdated, onGoFluxo }: { equip: any; onClose: () => void; onUpdated: () => void; onGoFluxo: (ativo: string) => void }) {
  const [historico, setHistorico] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    db().from('movements').select('*').eq('equipment_id', equip.id).order('moved_at', { ascending: false })
      .then(({ data }: { data: any[] | null }) => { setHistorico(data || []); setLoading(false) })
  }, [equip.id])

  const isConcentrador = equip.equipment_category === 'concentrador' || equip.equipment_type?.toLowerCase().includes('concentrador')
  const isOximetro = equip.equipment_category === 'oximetro' || equip.equipment_type?.toLowerCase().includes('oxímetro') || equip.equipment_type?.toLowerCase().includes('oximetro')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full max-w-md h-full overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between z-10">
          <div><p className="text-2xl font-black text-gray-900">{equip.asset_number}</p><p className="text-sm text-gray-500">{equip.equipment_model?.nickname || equip.equipment_type || '—'}</p><p className="text-xs text-gray-400">{equip.brand || equip.equipment_model?.brand} {equip.model || equip.equipment_model?.model}</p></div>
          <div className="flex items-center gap-2"><Badge status={equip.status} /><button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center ml-2"><X size={14} /></button></div>
        </div>

        <div className="px-5 py-5 space-y-5">
          {equip.is_blocked && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-2"><Lock size={14} className="text-red-600"/><p className="text-xs font-black uppercase text-red-800 tracking-widest">Equipamento Bloqueado</p></div>
              <p className="text-sm text-red-700">{equip.block_reason}</p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {[['Série', equip.serial_number || '—'],['Cliente', equip.client_number || '—'],['Local', equip.location?.code || '—'],].map(([l, v]) => (<div key={l as string} className="bg-gray-50 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase tracking-widest text-gray-400">{l}</p><p className="text-sm font-bold text-gray-700 mt-1 truncate">{v}</p></div>))}
          </div>

          {(equip.flow_measurement || equip.o2_concentration || equip.spo2_reading || equip.hr_reading) && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Medições</p>
              <div className="grid grid-cols-2 gap-2">
                {equip.flow_measurement && (<div className="bg-blue-50 border border-blue-100 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase text-blue-400">Fluxo</p><p className="text-xl font-black text-blue-700">{equip.flow_measurement} <span className="text-xs">L/min</span></p></div>)}
                {equip.o2_concentration && (<div className="bg-green-50 border border-green-100 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase text-green-400">O₂</p><p className="text-xl font-black text-green-700">{equip.o2_concentration}<span className="text-xs">%</span></p></div>)}
                {equip.spo2_reading && (<div className="bg-blue-50 border border-blue-100 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase text-blue-400">SpO₂</p><p className="text-xl font-black text-blue-700">{equip.spo2_reading}<span className="text-xs">%</span></p></div>)}
                {equip.hr_reading && (<div className="bg-red-50 border border-red-100 rounded-2xl p-3 text-center"><p className="text-[9px] font-black uppercase text-red-400">FC</p><p className="text-xl font-black text-red-700">{equip.hr_reading}<span className="text-xs">bpm</span></p></div>)}
              </div>
            </div>
          )}

          {!loading && historico.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2"><History size={11} />Histórico</p>
              <div className="space-y-1.5">
                {historico.map(m => (
                  <div key={m.id} className="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0 flex-wrap">
                    <Badge status={m.from_status} size="sm" /><ArrowRight size={10} className="text-gray-300 shrink-0" /><Badge status={m.to_status} size="sm" />
                    {(m.os_number || m.client_number) && (<span className="text-[10px] font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 flex items-center gap-1 shrink-0">{m.os_number && <span>OS: {m.os_number}</span>}{m.os_number && m.client_number && <span>|</span>}{m.client_number && <span>CLI: {m.client_number}</span>}</span>)}
                    {m.reason && <span className="text-xs text-gray-400 flex-1 min-w-0 truncate">{m.reason}</span>}
                    <span className="text-[10px] text-gray-300 ml-auto shrink-0">{fmtDate(m.moved_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => window.location.href = `/wm/editar/${equip.id}`} className="py-3 border-2 border-gray-300 text-gray-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-gray-50 transition-all">✏️ Editar</button>
            <button onClick={() => onGoFluxo(equip.asset_number)} className="py-3 border-2 border-blue-600 text-blue-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-blue-50 transition-all flex items-center justify-center gap-1"><ArrowRight size={13} />Fluxo</button>
          </div>
        </div>
      </div>
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
  
  const [toast, setToast] = useState<{msg: string, type: 'success'|'error'} | null>(null)
  
  const [filterBrand, setFilterBrand] = useState('')
  const [filterModel, setFilterModel] = useState('')
  const [filterDate, setFilterDate] = useState({ de: '', ate: '' })

  const [showVerificaEntrada, setShowVerificaEntrada] = useState(false)
  const [showEntrada, setShowEntrada] = useState(false)
  const [novoAtivo, setNovoAtivo] = useState('')
  
  const [equipDetalhe, setEquipDetalhe] = useState<any>(null)
  const [fluxoAtivo, setFluxoAtivo] = useState('')

  const showToast = useCallback((msg: string, type: 'success'|'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 4000)
  }, [])

  const carregar = useCallback(async () => {
    const { data: { session } } = await authClient().auth.getSession()
    if (!session) { window.location.href = '/wm/login'; return }
    setLoading(true)
    const [eqRes, stRes] = await Promise.all([
      db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model,equipment_brands(name))').order('created_at', { ascending: false }),
      db().from('standards').select('*').order('next_calibration', { ascending: true })
    ])
    const formattedEquipment = (eqRes.data || []).map((eq: any) => ({ ...eq, brand: eq.equipment_model?.equipment_brands?.name || eq.equipment_model?.brand || eq.brand }))
    setEquipment(formattedEquipment); setStandards(stRes.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const handleIniciaCadastro = (ativo: string) => { setNovoAtivo(ativo); setShowVerificaEntrada(false); setShowEntrada(true) }

  const stats = {
    total:      equipment.length,
    fluxo:      equipment.filter(e => ['entrada','avaliacao_bancada','aguardando_pecas','aguardando_envio','limpeza'].includes(e.status)).length,
    ag_pecas:   equipment.filter(e => e.status === 'aguardando_pecas').length,
    lastro:     equipment.filter(e => e.status === 'lastro').length,
    backup:     equipment.filter(e => e.status === 'backup').length,
    aplicado:   equipment.filter(e => e.status === 'aplicado').length,
    manutencao: equipment.filter(e => e.status === 'manutencao_externa').length,
    descarte:   equipment.filter(e => e.status === 'descarte').length,
  }

  const calVencendo = standards.filter(s => s.next_calibration && Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000) <= 30)

  const brands = Array.from(new Set(equipment.map(e => e.brand).filter(Boolean))).sort()
  const models = Array.from(new Set(equipment.filter(e => !filterBrand || e.brand === filterBrand).map(e => e.equipment_model?.nickname || e.equipment_model?.model || e.model).filter(Boolean))).sort()

  const equipFiltrado = equipment.filter(e => {
    const q = search.toLowerCase()
    const matchSearch = !search || [e.asset_number, e.serial_number, e.brand, e.model, e.equipment_type, e.client_number, e.equipment_model?.nickname].some(v => v?.toLowerCase().includes(q))
    const matchStatus = filterStatus === 'todos' ? true : filterStatus === 'em_fluxo' ? ['entrada','avaliacao_bancada','aguardando_pecas','aguardando_envio','limpeza'].includes(e.status) : e.status === filterStatus
    const matchBrand = !filterBrand || e.brand === filterBrand
    const matchModel = !filterModel || (e.equipment_model?.nickname || e.equipment_model?.model || e.model) === filterModel
    const matchDate = (!filterDate.de || (e.entry_date && e.entry_date >= filterDate.de)) && (!filterDate.ate || (e.entry_date && e.entry_date <= filterDate.ate))
    return matchSearch && matchStatus && matchBrand && matchModel && matchDate
  })

  const ABAS = [
    { id: 'equipamentos', label: 'Equipamentos', icon: Package },
    { id: 'fluxo',        label: 'Fluxo',        icon: ArrowRight },
    { id: 'pecas',        label: 'Peças',        icon: Zap },
    { id: 'relatorios',   label: 'Relatórios',   icon: FileText },
  ] as const

  return (
    <div className="min-h-screen bg-gray-50">
      
      {toast && (
        <div className="fixed bottom-6 right-6 z-[100] px-5 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 bg-gray-900 border border-gray-800">
          {toast.type === 'success' ? <CheckCircle size={18} className="text-green-400" /> : <AlertTriangle size={18} className="text-red-400" />}
          <p className="text-sm font-bold text-white tracking-wide">{toast.msg}</p>
        </div>
      )}

      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-3 shrink-0"><img src="/logo_lev.png" alt="Lev" className="h-7 w-auto object-contain" /><div className="w-px h-6 bg-gray-200" /><img src="/logo_wm.png" alt="White Martins" className="h-6 w-auto object-contain opacity-70" /></div>
          <nav className="hidden sm:flex items-center gap-1 flex-1">{ABAS.map(a => { const Icon = a.icon; return (<button key={a.id} onClick={() => setAba(a.id)} className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${aba === a.id ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}><Icon size={13} />{a.label}</button>) })}</nav>
          <div className="flex items-center gap-2 shrink-0"><button onClick={() => setShowVerificaEntrada(true)} className="flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all shadow-sm"><Plus size={14} /><span className="hidden sm:inline">Novo </span>Cadastro</button><button onClick={logout} title="Sair" className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400 hover:bg-gray-100 transition-all"><LogOut size={15} /></button></div>
        </div>
        <div className="sm:hidden flex border-t border-gray-100 overflow-x-auto scrollbar-hide px-2">{ABAS.map(a => { const Icon = a.icon; return (<button key={a.id} onClick={() => setAba(a.id)} className={`flex items-center gap-1.5 px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap shrink-0 ${aba === a.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400'}`}><Icon size={12} />{a.label}</button>) })}</div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-4">

        {loading && equipment.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
            <Activity size={32} className="text-blue-500 animate-spin" />
            <p className="text-xs font-black uppercase tracking-widest text-gray-400">Carregando laboratório...</p>
          </div>
        ) : aba === 'equipamentos' && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              <StatCard label="Total"         value={stats.total}      color="#111827" bg="#ffffff" active={filterStatus==='todos'}              onClick={() => setFilterStatus('todos')} />
              <StatCard label="Em Fluxo"       value={stats.fluxo}      color="#92400e" bg="#fffbeb" active={filterStatus==='em_fluxo'}          onClick={() => setFilterStatus('em_fluxo')} />
              <StatCard label="Ag. Peças"      value={stats.ag_pecas}   color="#713f12" bg="#fefce8" active={filterStatus==='aguardando_pecas'}  onClick={() => setFilterStatus('aguardando_pecas')} />
              <StatCard label="Lastro"         value={stats.lastro}     color="#1e3a8a" bg="#eff6ff" active={filterStatus==='lastro'}            onClick={() => setFilterStatus('lastro')} />
              <StatCard label="Backup"         value={stats.backup}     color="#4c1d95" bg="#f5f3ff" active={filterStatus==='backup'}            onClick={() => setFilterStatus('backup')} />
              <StatCard label="Aplicado"       value={stats.aplicado}   color="#14532d" bg="#f0fdf4" active={filterStatus==='aplicado'}          onClick={() => setFilterStatus('aplicado')} />
              <StatCard label="Manut. Externa" value={stats.manutencao} color="#7f1d1d" bg="#fef2f2" active={filterStatus==='manutencao_externa'} onClick={() => setFilterStatus('manutencao_externa')} />
              <StatCard label="Descarte"       value={stats.descarte}   color="#374151" bg="#f9fafb" active={filterStatus==='descarte'}          onClick={() => setFilterStatus('descarte')} />
            </div>

            {stats.ag_pecas > 0 && (
              <button onClick={() => setFilterStatus('aguardando_pecas')} className="w-full bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-center gap-3 hover:bg-amber-100 transition-all">
                <Clock size={14} className="text-amber-600 shrink-0" /><p className="text-sm font-bold text-amber-800 text-left flex-1">{stats.ag_pecas} equipamento(s) aguardando peças</p><ChevronRight size={14} className="text-amber-400 shrink-0" />
              </button>
            )}

            {equipment.length === 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { icon: Package, color: 'blue', title: 'Registrar entrada', desc: 'Primeiro passo — dê entrada no equipamento ao chegar', action: () => setShowVerificaEntrada(true), btn: '+ Novo Cadastro' },
                  { icon: Activity, color: 'orange', title: 'Avaliar na bancada', desc: 'Registre fluxo, O₂, filtros e estado de cada peça', action: () => setAba('fluxo'), btn: 'Ir para o Fluxo' },
                  { icon: Archive, color: 'green', title: 'Enviar para lastro', desc: 'Após limpeza, o equipamento fica disponível para uso', action: () => setAba('fluxo'), btn: 'Movimentar' },
                ].map((c, i) => {
                  const Icon = c.icon
                  const colors: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', orange: 'bg-amber-50 text-amber-600', green: 'bg-green-50 text-green-600' }
                  const btnColors: Record<string, string> = { blue: 'bg-blue-600 hover:bg-blue-700', orange: 'bg-amber-500 hover:bg-amber-600', green: 'bg-green-600 hover:bg-green-700' }
                  return (
                    <div key={i} className="bg-white rounded-3xl border border-gray-200 p-5 space-y-3"><div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${colors[c.color]}`}><Icon size={20} /></div><div><p className="font-black text-gray-900 text-sm">{c.title}</p><p className="text-xs text-gray-400 mt-1 leading-relaxed">{c.desc}</p></div><button onClick={c.action} className={`w-full py-2.5 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${btnColors[c.color]}`}>{c.btn}</button></div>
                  )
                })}
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
                {[
                  stats.fluxo > 0 && { label: `${stats.fluxo} em fluxo`, sub: 'aguardando avaliação', color: 'bg-amber-50 border-amber-200 text-amber-700', action: () => setFilterStatus('em_fluxo') },
                  stats.ag_pecas > 0 && { label: `${stats.ag_pecas} ag. peças`, sub: 'parados por falta de peça', color: 'bg-yellow-50 border-yellow-200 text-yellow-700', action: () => setFilterStatus('aguardando_pecas') },
                  stats.manutencao > 0 && { label: `${stats.manutencao} em manut. externa`, sub: 'manutenção externa', color: 'bg-red-50 border-red-200 text-red-700', action: () => setFilterStatus('manutencao_externa') },
                  calVencendo.length > 0 && { label: `${calVencendo.length} calibração`, sub: 'vencendo em 30 dias', color: 'bg-purple-50 border-purple-200 text-purple-700', action: () => setAba('relatorios') },
                ].filter(Boolean).map((c: any, i) => (
                  <button key={i} onClick={c.action} className={`shrink-0 px-4 py-3 rounded-2xl border text-left transition-all hover:shadow-sm active:scale-95 ${c.color}`}><p className="font-black text-sm">{c.label}</p><p className="text-[10px] mt-0.5 opacity-70">{c.sub}</p></button>
                ))}
              </div>
            )}

            <div className="flex flex-col md:flex-row gap-5 items-start mt-4">
              <div className="w-full md:w-56 shrink-0 space-y-4">
                {filterStatus === 'em_fluxo' && stats.fluxo > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-2">Detalhes do Fluxo</p>
                    {['entrada','avaliacao_bancada','aguardando_pecas','aguardando_envio','limpeza'].map(st => {
                      const count = equipment.filter(e => e.status === st).length
                      if (count === 0) return null
                      return (<div key={st} className="flex justify-between items-center text-xs py-1 border-b border-amber-100 last:border-0"><span className="text-amber-800 font-bold">{S[st].label}</span><span className="font-black text-amber-900 bg-amber-200 px-1.5 py-0.5 rounded-md">{count}</span></div>)
                    })}
                  </div>
                )}
                <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Filtros Avançados</p>
                  <div><label className={lbl}>Marca</label><select value={filterBrand} onChange={e => { setFilterBrand(e.target.value); setFilterModel('') }} className={inp}><option value="">Todas</option>{brands.map((b: any) => <option key={b} value={b}>{b}</option>)}</select></div>
                  <div><label className={lbl}>Modelo / Apelido</label><select value={filterModel} onChange={e => setFilterModel(e.target.value)} className={inp}><option value="">Todos</option>{models.map((m: any) => <option key={m} value={m}>{m}</option>)}</select></div>
                  <div><label className={lbl}>Data de Entrada</label><div className="grid grid-cols-2 gap-2"><input type="date" value={filterDate.de} onChange={e => setFilterDate({...filterDate, de: e.target.value})} className={inp + ' px-2 text-[11px]'} title="De" /><input type="date" value={filterDate.ate} onChange={e => setFilterDate({...filterDate, ate: e.target.value})} className={inp + ' px-2 text-[11px]'} title="Até" /></div></div>
                  {(filterBrand || filterModel || filterDate.de || filterDate.ate) && (<button onClick={() => { setFilterBrand(''); setFilterModel(''); setFilterDate({de:'', ate:''}) }} className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-red-500 transition-colors">Limpar Filtros</button>)}
                </div>
              </div>

              <div className="flex-1 min-w-0 space-y-3">
                <div className="relative"><Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar ativo, apelido, marca, série..." className="w-full pl-10 pr-4 py-3 rounded-2xl border border-gray-200 bg-white text-sm text-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" /></div>
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
                  {[['todos','Todos'], ['em_fluxo','Em Fluxo'], ...Object.entries(S).map(([k,v]) => [k, v.label])].map(([k, v]) => (<button key={k} onClick={() => setFilterStatus(k)} className={`px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border shrink-0 ${filterStatus === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>{v}</button>))}
                </div>
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  {equipFiltrado.length === 0 && !loading ? (
                    <div className="p-8 sm:p-12"><div className="text-center space-y-2"><Search size={24} className="text-gray-300 mx-auto" /><p className="text-gray-400 text-sm">Nenhum resultado para a busca.</p></div></div>
                  ) : (
                    <>
                      <div className="hidden sm:grid grid-cols-[80px_1fr_90px_120px_70px_32px] gap-3 px-5 py-2.5 bg-gray-50 border-b border-gray-100">{['Ativo','Equipamento','Série','Status','Local',''].map(h => <span key={h} className="text-[9px] font-black uppercase tracking-widest text-gray-400">{h}</span>)}</div>
                      {equipFiltrado.map((eq, i) => {
                        const nome = eq.equipment_model?.nickname || eq.equipment_type
                        const detalhe = [eq.brand, eq.equipment_model?.model || eq.model].filter(Boolean).join(' ')
                        return (
                          <div key={eq.id} className={`grid grid-cols-[80px_1fr_auto] sm:grid-cols-[80px_1fr_90px_120px_70px_32px] gap-2 sm:gap-3 px-4 sm:px-5 py-3.5 items-center border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors ${i%2!==0?'bg-gray-50/30':''}`} onClick={() => setEquipDetalhe(eq)}>
                            <div className="flex items-center gap-1.5">
                               {eq.is_blocked && <Lock size={12} className="text-red-500 shrink-0"/>}
                               <span className={`font-black text-sm ${eq.is_blocked ? 'text-red-700' : 'text-gray-900'}`}>{eq.asset_number}</span>
                            </div>
                            <div className="min-w-0">{nome && <p className="text-sm font-bold text-gray-700 truncate">{nome}</p>}{detalhe && <p className="text-[11px] text-gray-400 truncate">{detalhe}</p>}</div>
                            <Badge status={eq.status} size="sm" />
                            <span className="hidden sm:block text-xs text-gray-400 font-mono">{eq.serial_number || '—'}</span>
                            <div className="hidden sm:flex items-center gap-1"><MapPin size={9} className="text-gray-300 shrink-0" /><span className="text-[11px] font-bold text-gray-500">{eq.location?.code || '—'}</span></div>
                            <ChevronRight size={13} className="hidden sm:block text-gray-300" />
                          </div>
                        )
                      })}
                    </>
                  )}
                </div>
                <p className="text-center text-[10px] text-gray-400">{equipFiltrado.length} equipamento(s) · Londrina</p>
              </div>
            </div>
          </>
        )}

        {aba === 'fluxo' && <AbaFluxo initialAtivo={fluxoAtivo} onMoved={carregar} onToast={showToast} />}
        {aba === 'pecas' && <AbaPecas />}
        {aba === 'relatorios' && <AbaRelatorios />}
      </main>

      {showVerificaEntrada && <ModalVerificaEntrada onClose={() => setShowVerificaEntrada(false)} onCadastrar={handleIniciaCadastro} />}
      {showEntrada && <ModalEntrada initialAtivo={novoAtivo} onClose={() => setShowEntrada(false)} onSaved={carregar} onToast={showToast} />}
      {equipDetalhe && <DrawerEquipamento equip={equipDetalhe} onClose={() => setEquipDetalhe(null)} onUpdated={() => { carregar(); setEquipDetalhe(null) }} onGoFluxo={(ativo: string) => { setEquipDetalhe(null); setFluxoAtivo(ativo); setAba('fluxo') }} />}
    </div>
  )
}