'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Package, MapPin, Wrench, AlertTriangle, CheckCircle,
  Clock, Plus, Search, Activity, Archive, RotateCcw,
  Trash2, X, Zap, ArrowRight, Droplets, ChevronRight,
  FileText, Download, Filter, Calendar, LogOut,
  Scan, History, BarChart2
} from 'lucide-react'

// ── Supabase ──────────────────────────────────────────────
function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'white_martins' } }
  )
}
function auth() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
async function logout() {
  await auth().auth.signOut()
  window.location.href = '/wm/login'
}

// ── Status ────────────────────────────────────────────────
const S: Record<string, { label: string; short: string; color: string; bg: string; border: string; icon: any; next: string[] }> = {
  entrada:            { label: 'Entrada',         short: 'ENT',  color: '#92400e', bg: '#fef3c7', border: '#fcd34d', icon: Package,       next: ['avaliacao_bancada'] },
  avaliacao_bancada:  { label: 'Bancada',          short: 'BAN',  color: '#c2410c', bg: '#ffedd5', border: '#fb923c', icon: Activity,      next: ['limpeza','aguardando_pecas','manutencao_externa','descarte'] },
  aguardando_pecas:   { label: 'Ag. Peças',        short: 'PEÇ',  color: '#854d0e', bg: '#fefce8', border: '#facc15', icon: Clock,         next: ['limpeza','manutencao_externa','descarte'] },
  limpeza:            { label: 'Limpeza',           short: 'LIM',  color: '#0e7490', bg: '#ecfeff', border: '#22d3ee', icon: Droplets,      next: ['lastro','backup','descarte'] },
  manutencao_externa: { label: 'Manutenção Ext.',   short: 'MAN',  color: '#991b1b', bg: '#fef2f2', border: '#fca5a5', icon: Wrench,        next: ['limpeza','lastro','descarte'] },
  lastro:             { label: 'Lastro',            short: 'LAS',  color: '#1d4ed8', bg: '#eff6ff', border: '#93c5fd', icon: Archive,       next: ['backup','aplicado','descarte'] },
  backup:             { label: 'Backup',            short: 'BAK',  color: '#6d28d9', bg: '#f5f3ff', border: '#c4b5fd', icon: RotateCcw,     next: ['lastro','aplicado','descarte'] },
  aplicado:           { label: 'Aplicado',          short: 'APL',  color: '#065f46', bg: '#f0fdf4', border: '#86efac', icon: CheckCircle,   next: ['limpeza','manutencao_externa','descarte'] },
  descarte:           { label: 'Descarte',          short: 'DESC', color: '#374151', bg: '#f9fafb', border: '#d1d5db', icon: Trash2,        next: [] },
}

function Badge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const cfg = S[status]
  if (!cfg) return null
  const Icon = cfg.icon
  const sm = size === 'sm'
  return (
    <span style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border }}
      className={`inline-flex items-center gap-1 border rounded-full font-bold uppercase tracking-wider ${sm ? 'px-1.5 py-0.5 text-[9px]' : 'px-2.5 py-1 text-[10px]'}`}>
      <Icon size={sm ? 8 : 10} />{cfg.label}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────
const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('pt-BR') : '—'

// ── Modal Nova Entrada ────────────────────────────────────
function ModalEntrada({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({
    asset_number: '', serial_number: '', client_number: '',
    model_id: '', status: 'entrada',
    location_code: '', is_backup: false, backup_for: '',
    notes: '', entry_date: new Date().toISOString().slice(0, 10)
  })
  const [models, setModels] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showNovoModelo, setShowNovoModelo] = useState(false)
  const [novoMod, setNovoMod] = useState({ brand: '', model: '', nickname: '', equipment_type: '', measure_unit: '' })

  useEffect(() => {
    Promise.all([
      db().from('equipment_models').select('*').order('nickname').order('brand'),
      db().from('locations').select('id,code,area,description').eq('active', true).order('code')
    ]).then(([m, l]) => { setModels(m.data || []); setLocations(l.data || []) })
  }, [])

  const modelSel = models.find(m => m.id === form.model_id)
  const modelsFilt = models.filter(m => {
    if (!modelSearch) return true
    const s = modelSearch.toLowerCase()
    return [m.brand, m.model, m.nickname, m.equipment_type].some(v => v?.toLowerCase().includes(s))
  })

  const salvarModelo = async () => {
    if (!novoMod.brand || !novoMod.model) return
    const { data } = await db().from('equipment_models').insert(novoMod).select().single()
    if (data) { setModels(p => [...p, data]); setForm(f => ({...f, model_id: data.id})); setShowNovoModelo(false) }
  }

  const salvar = async () => {
    if (!form.asset_number.trim()) { setError('Número de patrimônio obrigatório'); return }
    setLoading(true)
    const loc = locations.find(l => l.code === form.location_code)
    const mod = models.find(m => m.id === form.model_id)
    const { error: err } = await db().from('equipment').insert({
      asset_number: form.asset_number.trim(),
      serial_number: form.serial_number || null,
      client_number: form.client_number || null,
      model_id: form.model_id || null,
      brand: mod?.brand || null, model: mod?.model || null,
      equipment_type: mod?.equipment_type || null,
      measure_unit: mod?.measure_unit || null,
      status: form.status, location_id: loc?.id || null,
      is_backup: form.is_backup, backup_for: form.backup_for || null,
      notes: form.notes || null, entry_date: form.entry_date,
    })
    setLoading(false)
    if (err) { setError(err.code === '23505' ? 'Patrimônio já cadastrado.' : err.message); return }
    onSaved(); onClose()
  }

  const inp = "w-full px-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none transition-all font-medium"
  const lbl = "block text-[10px] font-black uppercase tracking-widest text-stone-400 mb-1.5"

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/60 backdrop-blur-sm p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[92vh] overflow-y-auto shadow-2xl">

        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-stone-100 px-6 py-4 flex items-center justify-between z-10 rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
              <Package size={15} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-black text-stone-900 tracking-tight">Nova Entrada</h2>
              <p className="text-[10px] text-stone-400 uppercase tracking-widest">Registro de chegada ao laboratório</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center hover:bg-stone-200 transition-all">
            <X size={14} className="text-stone-500" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">

          {/* 1. Identificação */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-black flex items-center justify-center">1</span>
              <p className="text-xs font-black uppercase tracking-widest text-stone-500">Identificação</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={lbl}>Nº Patrimônio (Ativo) *</label>
                <input autoFocus value={form.asset_number} onChange={e => setForm({...form, asset_number: e.target.value})}
                  className={inp + ' text-base font-black'} placeholder="Ex: 001234" />
              </div>
              <div>
                <label className={lbl}>Número de Série</label>
                <input value={form.serial_number} onChange={e => setForm({...form, serial_number: e.target.value})}
                  className={inp} placeholder="S/N" />
              </div>
              <div>
                <label className={lbl}>Nº do Cliente</label>
                <input value={form.client_number} onChange={e => setForm({...form, client_number: e.target.value})}
                  className={inp} />
              </div>
            </div>
          </div>

          {/* 2. Modelo */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-black flex items-center justify-center">2</span>
                <p className="text-xs font-black uppercase tracking-widest text-stone-500">Modelo</p>
              </div>
              <button onClick={() => setShowNovoModelo(!showNovoModelo)}
                className="text-[10px] font-black text-blue-600 uppercase tracking-widest hover:text-blue-700 flex items-center gap-1">
                <Plus size={11} /> Novo
              </button>
            </div>

            {showNovoModelo && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-3 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-blue-600">Cadastrar novo modelo</p>
                <div className="grid grid-cols-2 gap-2">
                  <input value={novoMod.brand} onChange={e => setNovoMod({...novoMod, brand: e.target.value})} className={inp} placeholder="Marca *" />
                  <input value={novoMod.model} onChange={e => setNovoMod({...novoMod, model: e.target.value})} className={inp} placeholder="Modelo *" />
                  <input value={novoMod.nickname} onChange={e => setNovoMod({...novoMod, nickname: e.target.value})} className={inp + ' col-span-2'} placeholder="Apelido (ex: concentrador, oxímetro)" />
                  <input value={novoMod.equipment_type} onChange={e => setNovoMod({...novoMod, equipment_type: e.target.value})} className={inp} placeholder="Tipo" />
                  <input value={novoMod.measure_unit} onChange={e => setNovoMod({...novoMod, measure_unit: e.target.value})} className={inp} placeholder="Unidade (ex: L/min)" />
                </div>
                <button onClick={salvarModelo} className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">
                  Salvar modelo
                </button>
              </div>
            )}

            {modelSel ? (
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-2xl">
                <CheckCircle size={16} className="text-green-600 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-black text-green-800">{modelSel.nickname || modelSel.equipment_type}</p>
                  <p className="text-[11px] text-green-600">{modelSel.brand} {modelSel.model} {modelSel.measure_unit ? `· ${modelSel.measure_unit}` : ''}</p>
                </div>
                <button onClick={() => setForm({...form, model_id: ''})} className="text-green-400 hover:text-green-600">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="border border-stone-200 rounded-2xl overflow-hidden">
                <div className="relative border-b border-stone-100">
                  <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input value={modelSearch} onChange={e => setModelSearch(e.target.value)}
                    className="w-full pl-9 pr-4 py-3 text-sm text-stone-700 outline-none" placeholder="Buscar apelido, marca ou modelo..." />
                </div>
                <div className="max-h-36 overflow-y-auto divide-y divide-stone-50">
                  {modelsFilt.length === 0 ? (
                    <p className="p-4 text-xs text-stone-400 text-center">
                      {models.length === 0 ? 'Nenhum modelo cadastrado.' : 'Sem resultados.'}
                    </p>
                  ) : modelsFilt.slice(0, 15).map(m => (
                    <button key={m.id} onClick={() => { setForm({...form, model_id: m.id}); setModelSearch('') }}
                      className="w-full px-4 py-2.5 text-left hover:bg-stone-50 transition-colors flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-bold text-stone-800">{m.nickname || m.equipment_type || '—'}</span>
                        <span className="text-xs text-stone-400 ml-2">{m.brand} {m.model}</span>
                      </div>
                      {m.measure_unit && <span className="text-[10px] text-stone-400 font-mono">{m.measure_unit}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3. Destino */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-black flex items-center justify-center">3</span>
              <p className="text-xs font-black uppercase tracking-widest text-stone-500">Destino Inicial</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(['entrada','avaliacao_bancada','aguardando_pecas','limpeza','manutencao_externa'] as const).map(s => {
                const cfg = S[s]; const Icon = cfg.icon; const sel = form.status === s
                return (
                  <button key={s} onClick={() => setForm({...form, status: s})}
                    style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}}
                    className={`flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all ${sel ? '' : 'border-stone-200 text-stone-400 hover:border-stone-300 hover:text-stone-600'}`}>
                    <Icon size={18} />
                    <span className="text-[9px] font-black uppercase tracking-wide leading-tight text-center">{cfg.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 4. Detalhes */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-stone-300 text-white text-[10px] font-black flex items-center justify-center">4</span>
              <p className="text-xs font-black uppercase tracking-widest text-stone-400">Detalhes (opcional)</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className={lbl}>Endereço</label>
                <select value={form.location_code} onChange={e => setForm({...form, location_code: e.target.value})} className={inp}>
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
                <label className={lbl}>Data de entrada</label>
                <input type="date" value={form.entry_date} onChange={e => setForm({...form, entry_date: e.target.value})} className={inp} />
              </div>
              <div>
                <label className={lbl}>Observações / Estado na chegada</label>
                <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
                  className={inp + ' resize-none'} rows={3}
                  placeholder="Estado do equipamento, itens faltando, problemas identificados..." />
              </div>
              <div className="flex items-center gap-3 p-3 rounded-2xl bg-stone-50 border border-stone-200">
                <input type="checkbox" id="bkp" checked={form.is_backup} onChange={e => setForm({...form, is_backup: e.target.checked})} className="w-4 h-4 accent-blue-600" />
                <label htmlFor="bkp" className="text-sm font-semibold text-stone-700 cursor-pointer">Equipamento de backup</label>
              </div>
              {form.is_backup && (
                <input value={form.backup_for} onChange={e => setForm({...form, backup_for: e.target.value})}
                  className={inp} placeholder="Substitui o ativo nº..." />
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
              <AlertTriangle size={13} className="text-red-500 shrink-0" />
              <p className="text-xs text-red-600 font-medium">{error}</p>
            </div>
          )}

          <button onClick={salvar} disabled={loading}
            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60 shadow-lg shadow-blue-200">
            {loading ? 'Registrando...' : 'Registrar Entrada'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Peças por Equipamento (bancada) ──────────────────────
function PecasEquipamento({ equipId, modelId }: { equipId: string; modelId?: string }) {
  const [pecas, setPecas] = useState<any[]>([])
  const [estados, setEstados] = useState<Record<string, string>>({})
  const [notas, setNotas] = useState<Record<string, string>>({})
  const [salvando, setSalvando] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // Busca peças compatíveis: genéricas + específicas do modelo
    db().from('spare_parts')
      .select('*, compatible_model:equipment_models(brand,model,nickname)')
      .or(`compatible_model_id.is.null${modelId ? `,compatible_model_id.eq.${modelId}` : ''}`)
      .order('category').order('name')
      .then(({ data }) => {
        setPecas(data || [])
        // Carrega estados já registrados
        db().from('equipment_part_status')
          .select('spare_part_id, status, notes')
          .eq('equipment_id', equipId)
          .then(({ data: est }) => {
            const map: Record<string,string> = {}
            const notMap: Record<string,string> = {}
            ;(est || []).forEach(e => { map[e.spare_part_id] = e.status; notMap[e.spare_part_id] = e.notes || '' })
            setEstados(map)
            setNotas(notMap)
          })
      })
  }, [equipId, modelId])

  const salvar = async () => {
    if (Object.keys(estados).length === 0) return
    setSalvando(true)
    for (const [partId, status] of Object.entries(estados)) {
      await db().from('equipment_part_status').upsert({
        equipment_id: equipId, spare_part_id: partId,
        status, notes: notas[partId] || null, recorded_by: 'Celio',
      }, { onConflict: 'equipment_id,spare_part_id' })
      // Se sem_estoque, decrementa estoque
      if (status === 'sem_estoque') {
        const peca = pecas.find(p => p.id === partId)
        if (peca && peca.stock_current > 0) {
          await db().from('spare_parts').update({ stock_current: peca.stock_current - 1 }).eq('id', partId)
        }
      }
      // Se novo, decrementa estoque
      if (status === 'novo') {
        const peca = pecas.find(p => p.id === partId)
        if (peca && peca.stock_current > 0) {
          await db().from('spare_parts').update({ stock_current: peca.stock_current - 1 }).eq('id', partId)
        }
      }
    }
    setSalvando(false); setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (pecas.length === 0) return null

  return (
    <div className="bg-white rounded-3xl border border-stone-200 p-5 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-4 flex items-center gap-2">
        <Zap size={11} /> Estado das Peças — Avaliação de Bancada
      </p>
      <div className="space-y-3">
        {pecas.map(p => (
          <div key={p.id} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-stone-700">{p.name}</span>
                {p.compatible_model && (
                  <span className="text-[10px] text-blue-500 ml-2">{p.compatible_model.nickname || p.compatible_model.brand}</span>
                )}
                <span className={`ml-2 text-[9px] font-black px-1.5 py-0.5 rounded-full ${
                  p.stock_current === 0 ? 'bg-red-100 text-red-600' :
                  p.stock_current <= p.stock_minimum ? 'bg-yellow-100 text-yellow-700' : 'bg-stone-100 text-stone-500'
                }`}>
                  estoque: {p.stock_current}
                </span>
              </div>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {Object.entries(PART_STATUS).map(([k, v]) => (
                <button key={k} onClick={() => setEstados(e => ({...e, [p.id]: k}))}
                  style={estados[p.id] === k ? { background: v.bg, color: v.color, borderColor: v.border } : {}}
                  className={`px-2.5 py-1 rounded-xl border text-[9px] font-black uppercase tracking-wider transition-all ${
                    estados[p.id] === k ? '' : 'border-stone-200 text-stone-400 hover:border-stone-300'
                  }`}>{v.label}</button>
              ))}
            </div>
            {(estados[p.id] === 'sem_estoque' || estados[p.id] === 'meia_vida') && (
              <input value={notas[p.id] || ''} onChange={e => setNotas(n => ({...n, [p.id]: e.target.value}))}
                className="w-full px-3 py-2 rounded-xl border border-stone-200 text-xs text-stone-600 outline-none focus:border-blue-400"
                placeholder="Observação (opcional)..." />
            )}
          </div>
        ))}
      </div>
      <button onClick={salvar} disabled={salvando || saved}
        className={`w-full mt-4 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${
          saved ? 'bg-green-500 text-white' : 'bg-stone-800 text-white hover:bg-stone-900 active:scale-[0.98]'
        }`}>
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
      setEquip(data)
      setNovoStatus(S[data.status]?.next[0] || '')
      const { data: mov } = await db().from('movements')
        .select('*').eq('equipment_id', data.id).order('moved_at', { ascending: false })
      setHistorico(mov || [])
    } else setNotFound(true)
    setLoading(false)
  }

  const mover = async () => {
    if (!novoStatus || !equip) return
    setSalvando(true)
    await Promise.all([
      db().from('equipment').update({ status: novoStatus }).eq('id', equip.id),
      db().from('movements').insert({
        equipment_id: equip.id, from_status: equip.status,
        to_status: novoStatus, reason: motivo || null, performed_by: 'Celio',
      })
    ])
    setEquip({ ...equip, status: novoStatus })
    setNovoStatus(S[novoStatus]?.next[0] || '')
    setMotivo('')
    const { data: mov } = await db().from('movements')
      .select('*').eq('equipment_id', equip.id).order('moved_at', { ascending: false })
    setHistorico(mov || [])
    setSalvando(false)
  }

  const inp = "w-full px-4 py-3 rounded-2xl border border-stone-200 text-sm text-stone-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none transition-all font-medium"

  return (
    <div className="space-y-4">
      {/* Busca por ativo */}
      <div className="bg-white rounded-3xl border border-stone-200 p-5 shadow-sm">
        <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-3">Digite o número de patrimônio</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Scan size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
            <input value={ativo} onChange={e => setAtivo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && buscar()}
              className={inp + ' pl-10 text-base font-black'} placeholder="Ex: 001234" autoFocus />
          </div>
          <button onClick={buscar} disabled={loading}
            className="px-5 py-3 bg-blue-600 text-white rounded-2xl font-black text-sm hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-60">
            {loading ? <Activity size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          </button>
        </div>
        {notFound && (
          <p className="mt-3 text-xs text-red-500 font-medium flex items-center gap-1.5">
            <AlertTriangle size={12} /> Ativo não encontrado. Verifique o número ou registre uma nova entrada.
          </p>
        )}
      </div>

      {equip && (
        <>
          {/* Card do equipamento */}
          <div className="bg-white rounded-3xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-2xl font-black text-stone-900 tracking-tight">{equip.asset_number}</p>
                <p className="text-sm text-stone-500 mt-0.5">
                  {equip.equipment_model?.nickname || equip.equipment_type || '—'}
                  {(equip.equipment_model?.brand || equip.brand) && (
                    <span className="ml-2 text-stone-400">
                      {equip.equipment_model?.brand || equip.brand} {equip.equipment_model?.model || equip.model}
                    </span>
                  )}
                </p>
              </div>
              <Badge status={equip.status} />
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'Série', value: equip.serial_number || '—' },
                { label: 'Cliente', value: equip.client_number || '—' },
                { label: 'Local', value: equip.location?.code || '—' },
              ].map(i => (
                <div key={i.label} className="bg-stone-50 rounded-2xl p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-stone-400">{i.label}</p>
                  <p className="text-sm font-bold text-stone-700 mt-1">{i.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Movimentação */}
          {S[equip.status]?.next.length > 0 && (
            <div className="bg-white rounded-3xl border border-stone-200 p-5 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-4">Próximo passo</p>
              <div className="flex items-center gap-3 mb-4">
                <Badge status={equip.status} />
                <ArrowRight size={14} className="text-stone-300 shrink-0" />
                <div className="flex-1 flex gap-2 flex-wrap">
                  {S[equip.status].next.map(s => {
                    const cfg = S[s]; const Icon = cfg.icon; const sel = novoStatus === s
                    return (
                      <button key={s} onClick={() => setNovoStatus(s)}
                        style={sel ? { background: cfg.bg, borderColor: cfg.border, color: cfg.color } : {}}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-bold transition-all ${sel ? '' : 'border-stone-200 text-stone-500 hover:border-stone-300'}`}>
                        <Icon size={13} />{cfg.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <textarea value={motivo} onChange={e => setMotivo(e.target.value)}
                className="w-full px-4 py-3 rounded-2xl border border-stone-200 text-sm text-stone-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-50 transition-all resize-none mb-3"
                rows={2} placeholder="Motivo / observação (opcional)..." />
              <button onClick={mover} disabled={salvando || !novoStatus}
                className="w-full py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-60">
                {salvando ? 'Movendo...' : 'Confirmar'}
              </button>
            </div>
          )}

          {/* Estado das Peças */}
          {equip.status === 'avaliacao_bancada' && (
            <PecasEquipamento equipId={equip.id} modelId={equip.model_id} />
          )}

          {/* Histórico */}
          {historico.length > 0 && (
            <div className="bg-white rounded-3xl border border-stone-200 p-5 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-4 flex items-center gap-2">
                <History size={12} /> Histórico de movimentações
              </p>
              <div className="space-y-2">
                {historico.map((m, i) => (
                  <div key={m.id} className="flex items-center gap-3 py-2 border-b border-stone-50 last:border-0">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                    <Badge status={m.from_status} size="sm" />
                    <ArrowRight size={11} className="text-stone-300 shrink-0" />
                    <Badge status={m.to_status} size="sm" />
                    {m.reason && <span className="text-xs text-stone-400 truncate flex-1">{m.reason}</span>}
                    <span className="text-[10px] text-stone-300 shrink-0">{fmtDate(m.moved_at)}</span>
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

// ── Aba Relatórios ────────────────────────────────────────
function AbaRelatorios() {
  const [tipo, setTipo] = useState<string | null>(null)
  const [dados, setDados] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [periodo, setPeriodo] = useState({ de: '', ate: '' })

  const relatorios = [
    { id: 'historico',    icon: History,    label: 'Histórico por Equipamento', desc: 'Linha do tempo completa de um ativo' },
    { id: 'por_status',   icon: BarChart2,  label: 'Por Status',                desc: 'Todos os equipamentos agrupados por status' },
    { id: 'manutencao',   icon: Wrench,     label: 'Manutenção Pendente',       desc: 'Equipamentos em manutenção ou bancada' },
    { id: 'ag_pecas',     icon: Clock,      label: 'Aguardando Peças',          desc: 'Equipamentos parados por falta de peça' },
    { id: 'calibracao',   icon: AlertTriangle, label: 'Calibração Vencendo',    desc: 'Padrões com prazo nos próximos 60 dias' },
    { id: 'movimentacoes',icon: Activity,   label: 'Movimentações por Período', desc: 'Todas as movimentações em um período' },
  ]

  const gerar = async (id: string) => {
    setTipo(id); setLoading(true); setDados([])
    let res: any[] = []

    if (id === 'por_status') {
      const { data } = await db().from('equipment')
        .select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)')
        .order('status').order('asset_number')
      res = data || []
    } else if (id === 'manutencao') {
      const { data } = await db().from('equipment')
        .select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)')
        .in('status', ['manutencao_externa','avaliacao_bancada'])
        .order('entry_date')
      res = data || []
    } else if (id === 'ag_pecas') {
      const { data } = await db().from('equipment')
        .select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)')
        .eq('status', 'aguardando_pecas').order('entry_date')
      res = data || []
    } else if (id === 'calibracao') {
      const em60 = new Date(Date.now() + 60*24*60*60*1000).toISOString().slice(0,10)
      const { data } = await db().from('standards')
        .select('*').lte('next_calibration', em60).order('next_calibration')
      res = data || []
    } else if (id === 'movimentacoes') {
      let q = db().from('movements').select('*, equipment:equipment(asset_number,brand,model)')
      if (periodo.de) q = q.gte('moved_at', periodo.de)
      if (periodo.ate) q = q.lte('moved_at', periodo.ate + 'T23:59:59')
      const { data } = await q.order('moved_at', { ascending: false }).limit(200)
      res = data || []
    }

    setDados(res); setLoading(false)
  }

  const imprimir = () => window.print()

  return (
    <div className="space-y-4">
      {/* Grid de relatórios */}
      <div className="grid grid-cols-2 gap-3">
        {relatorios.map(r => {
          const Icon = r.icon
          return (
            <button key={r.id} onClick={() => gerar(r.id)}
              className={`text-left p-4 rounded-2xl border-2 transition-all hover:shadow-sm active:scale-[0.98] ${
                tipo === r.id ? 'border-blue-500 bg-blue-50' : 'border-stone-200 bg-white hover:border-stone-300'
              }`}>
              <Icon size={18} className={tipo === r.id ? 'text-blue-600' : 'text-stone-400'} />
              <p className={`text-xs font-black mt-2 leading-tight ${tipo === r.id ? 'text-blue-700' : 'text-stone-700'}`}>{r.label}</p>
              <p className="text-[10px] text-stone-400 mt-1 leading-tight">{r.desc}</p>
            </button>
          )
        })}
      </div>

      {/* Filtro período para movimentações */}
      {tipo === 'movimentacoes' && (
        <div className="bg-white rounded-2xl border border-stone-200 p-4 flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-[10px] font-black uppercase tracking-widest text-stone-400 mb-1">De</label>
            <input type="date" value={periodo.de} onChange={e => setPeriodo({...periodo, de: e.target.value})}
              className="w-full px-3 py-2 rounded-xl border border-stone-200 text-sm outline-none focus:border-blue-500" />
          </div>
          <div className="flex-1">
            <label className="block text-[10px] font-black uppercase tracking-widest text-stone-400 mb-1">Até</label>
            <input type="date" value={periodo.ate} onChange={e => setPeriodo({...periodo, ate: e.target.value})}
              className="w-full px-3 py-2 rounded-xl border border-stone-200 text-sm outline-none focus:border-blue-500" />
          </div>
          <button onClick={() => gerar('movimentacoes')}
            className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">
            Filtrar
          </button>
        </div>
      )}

      {/* Resultados */}
      {loading && (
        <div className="bg-white rounded-2xl border border-stone-200 p-8 flex items-center justify-center">
          <Activity size={20} className="text-blue-500 animate-spin" />
        </div>
      )}

      {!loading && dados.length > 0 && (
        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-stone-100 bg-stone-50">
            <p className="text-xs font-black text-stone-600 uppercase tracking-widest">
              {dados.length} registro(s)
            </p>
            <button onClick={imprimir}
              className="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700">
              <Download size={13} /> Imprimir / PDF
            </button>
          </div>

          <div className="divide-y divide-stone-50">
            {(tipo === 'por_status' || tipo === 'manutencao' || tipo === 'ag_pecas') && dados.map(eq => (
              <div key={eq.id} className="px-5 py-3 flex items-center gap-4">
                <span className="font-black text-stone-900 text-sm w-20 shrink-0">{eq.asset_number}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-stone-700 truncate">
                    {eq.equipment_model?.nickname || eq.equipment_type || '—'}
                    <span className="text-stone-400 font-normal ml-1 text-xs">{eq.equipment_model?.brand} {eq.equipment_model?.model}</span>
                  </p>
                </div>
                <Badge status={eq.status} size="sm" />
                <span className="text-xs text-stone-400 shrink-0">{eq.location?.code || '—'}</span>
              </div>
            ))}

            {tipo === 'calibracao' && dados.map(s => {
              const dias = Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000)
              return (
                <div key={s.id} className="px-5 py-3 flex items-center gap-4">
                  <span className="font-black text-stone-900 text-sm w-24 shrink-0">{s.code}</span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-stone-700">{s.brand} {s.model}</p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${dias < 0 ? 'bg-red-100 text-red-600' : dias <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-yellow-50 text-yellow-700'}`}>
                    {dias < 0 ? `${Math.abs(dias)}d vencido` : `${dias}d restantes`}
                  </span>
                  <span className="text-xs text-stone-400 shrink-0">{fmtDate(s.next_calibration)}</span>
                </div>
              )
            })}

            {tipo === 'movimentacoes' && dados.map(m => (
              <div key={m.id} className="px-5 py-3 flex items-center gap-3">
                <span className="font-black text-stone-700 text-xs w-16 shrink-0">{m.equipment?.asset_number}</span>
                <Badge status={m.from_status} size="sm" />
                <ArrowRight size={11} className="text-stone-300 shrink-0" />
                <Badge status={m.to_status} size="sm" />
                {m.reason && <span className="text-xs text-stone-400 truncate flex-1">{m.reason}</span>}
                <span className="text-[10px] text-stone-300 shrink-0">{fmtDate(m.moved_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && tipo && dados.length === 0 && (
        <div className="bg-white rounded-2xl border border-stone-200 p-8 text-center">
          <p className="text-stone-400 text-sm">Nenhum registro encontrado.</p>
        </div>
      )}
    </div>
  )
}

// ── Status de Peças ──────────────────────────────────────
const PART_STATUS: Record<string, { label: string; color: string; bg: string; border: string }> = {
  novo:            { label: 'Novo',            color: '#065f46', bg: '#f0fdf4', border: '#86efac' },
  ok:              { label: 'OK',              color: '#1d4ed8', bg: '#eff6ff', border: '#93c5fd' },
  meia_vida:       { label: 'Meia Vida',       color: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
  necessita_troca: { label: 'Necessita Troca', color: '#991b1b', bg: '#fef2f2', border: '#fca5a5' },
  sem_estoque:     { label: 'Sem Estoque',     color: '#374151', bg: '#f9fafb', border: '#d1d5db' },
}

function PartBadge({ status }: { status: string }) {
  const cfg = PART_STATUS[status]
  if (!cfg) return null
  return (
    <span style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border }}
      className="inline-flex items-center px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-wider">
      {cfg.label}
    </span>
  )
}

function AbaPecas() {
  const [pecas, setPecas] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showNova, setShowNova] = useState(false)
  const [novaPeca, setNovaPeca] = useState({
    name: '', reference: '', category: 'filtro',
    compatible_model_id: '', stock_current: 0, stock_minimum: 1,
    unit: 'un', location_code: '', notes: ''
  })
  const [salvando, setSalvando] = useState(false)
  const [semEstoque, setSemEstoque] = useState<any[]>([])

  const carregar = async () => {
    setLoading(true)
    const [pRes, mRes, seRes] = await Promise.all([
      db().from('spare_parts').select('*, compatible_model:equipment_models(brand,model,nickname)').order('category').order('name'),
      db().from('equipment_models').select('id,brand,model,nickname').order('nickname'),
      db().from('equipment_part_status')
        .select('*, equipment:equipment(asset_number), spare_part:spare_parts(name,category)')
        .in('status', ['sem_estoque','necessita_troca'])
        .order('created_at', { ascending: false }),
    ])
    setPecas(pRes.data || [])
    setModels(mRes.data || [])
    setSemEstoque(seRes.data || [])
    setLoading(false)
  }

  useEffect(() => { carregar() }, [])

  const salvarPeca = async () => {
    if (!novaPeca.name.trim()) return
    setSalvando(true)
    await db().from('spare_parts').insert({
      ...novaPeca,
      compatible_model_id: novaPeca.compatible_model_id || null,
      stock_current: Number(novaPeca.stock_current),
      stock_minimum: Number(novaPeca.stock_minimum),
    })
    setSalvando(false)
    setShowNova(false)
    setNovaPeca({ name: '', reference: '', category: 'filtro', compatible_model_id: '', stock_current: 0, stock_minimum: 1, unit: 'un', location_code: '', notes: '' })
    carregar()
  }

  const ajustarEstoque = async (id: string, delta: number, atual: number) => {
    const novo = Math.max(0, atual + delta)
    await db().from('spare_parts').update({ stock_current: novo }).eq('id', id)
    setPecas(p => p.map(x => x.id === id ? {...x, stock_current: novo} : x))
  }

  const inp = "w-full px-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none transition-all"
  const lbl = "block text-[10px] font-black uppercase tracking-widest text-stone-400 mb-1.5"

  const categorias = ['filtro','sensor','acessorio','consumivel']
  const catLabel: Record<string,string> = { filtro:'Filtros', sensor:'Sensores', acessorio:'Acessórios', consumivel:'Consumíveis' }

  const pecasSemEstoque = pecas.filter(p => p.stock_current <= p.stock_minimum)

  return (
    <div className="space-y-4">

      {/* Alerta estoque crítico */}
      {pecasSemEstoque.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={15} className="text-red-500 shrink-0" />
            <p className="text-sm font-black text-red-700">{pecasSemEstoque.length} peça(s) abaixo do estoque mínimo</p>
          </div>
          <div className="space-y-1">
            {pecasSemEstoque.map(p => (
              <div key={p.id} className="flex items-center justify-between text-xs">
                <span className="text-red-600 font-medium">{p.name}</span>
                <span className="font-black text-red-700">{p.stock_current}/{p.stock_minimum} {p.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Equipamentos com peças críticas */}
      {semEstoque.length > 0 && (
        <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-3 flex items-center gap-2">
            <Clock size={11} /> Equipamentos com peças não trocadas por falta de estoque
          </p>
          <div className="space-y-2">
            {semEstoque.map(s => (
              <div key={s.id} className="flex items-center gap-3 py-1.5 border-b border-stone-100 last:border-0">
                <span className="font-black text-stone-700 text-xs w-16 shrink-0">{s.equipment?.asset_number}</span>
                <span className="text-xs text-stone-500 flex-1">{s.spare_part?.name}</span>
                <PartBadge status={s.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Header + botão nova peça */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-widest text-stone-400">Estoque de Peças</p>
        <button onClick={() => setShowNova(!showNova)}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 transition-all">
          <Plus size={12} /> Nova Peça
        </button>
      </div>

      {/* Form nova peça */}
      {showNova && (
        <div className="bg-white border border-blue-200 rounded-2xl p-5 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-blue-600">Cadastrar peça / consumível</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={lbl}>Nome *</label>
              <input autoFocus value={novaPeca.name} onChange={e => setNovaPeca({...novaPeca, name: e.target.value})}
                className={inp} placeholder="Ex: Filtro de cabeceira EverFlo" />
            </div>
            <div>
              <label className={lbl}>Referência / Código</label>
              <input value={novaPeca.reference} onChange={e => setNovaPeca({...novaPeca, reference: e.target.value})}
                className={inp} placeholder="Ex: 1020733" />
            </div>
            <div>
              <label className={lbl}>Categoria</label>
              <select value={novaPeca.category} onChange={e => setNovaPeca({...novaPeca, category: e.target.value})} className={inp}>
                {categorias.map(c => <option key={c} value={c}>{catLabel[c]}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className={lbl}>Compatível com (deixe vazio = genérico)</label>
              <select value={novaPeca.compatible_model_id} onChange={e => setNovaPeca({...novaPeca, compatible_model_id: e.target.value})} className={inp}>
                <option value="">— Genérico (todos os modelos) —</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.nickname || m.equipment_type || ''} — {m.brand} {m.model}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={lbl}>Estoque atual</label>
              <input type="number" min={0} value={novaPeca.stock_current}
                onChange={e => setNovaPeca({...novaPeca, stock_current: Number(e.target.value)})} className={inp} />
            </div>
            <div>
              <label className={lbl}>Estoque mínimo</label>
              <input type="number" min={1} value={novaPeca.stock_minimum}
                onChange={e => setNovaPeca({...novaPeca, stock_minimum: Number(e.target.value)})} className={inp} />
            </div>
            <div>
              <label className={lbl}>Unidade</label>
              <input value={novaPeca.unit} onChange={e => setNovaPeca({...novaPeca, unit: e.target.value})} className={inp} placeholder="un, cx, par" />
            </div>
            <div>
              <label className={lbl}>Localização</label>
              <input value={novaPeca.location_code} onChange={e => setNovaPeca({...novaPeca, location_code: e.target.value})} className={inp} placeholder="Ex: AP-A2" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={salvarPeca} disabled={salvando}
              className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest disabled:opacity-60">
              {salvando ? 'Salvando...' : 'Cadastrar'}
            </button>
            <button onClick={() => setShowNova(false)}
              className="px-4 py-3 rounded-xl border border-stone-200 text-xs font-black text-stone-500">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Lista por categoria */}
      {loading ? (
        <div className="p-8 flex items-center justify-center bg-white rounded-2xl border border-stone-200">
          <Activity size={20} className="text-blue-500 animate-spin" />
        </div>
      ) : pecas.length === 0 ? (
        <div className="p-8 text-center bg-white rounded-2xl border border-stone-200">
          <Zap size={24} className="text-stone-300 mx-auto mb-2" />
          <p className="text-stone-400 text-sm">Nenhuma peça cadastrada.</p>
        </div>
      ) : (
        categorias.map(cat => {
          const lista = pecas.filter(p => p.category === cat)
          if (lista.length === 0) return null
          return (
            <div key={cat} className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
              <div className="px-5 py-3 bg-stone-50 border-b border-stone-100">
                <p className="text-[10px] font-black uppercase tracking-widest text-stone-500">{catLabel[cat]}</p>
              </div>
              <div className="divide-y divide-stone-50">
                {lista.map(p => {
                  const critico = p.stock_current <= p.stock_minimum
                  const zero = p.stock_current === 0
                  return (
                    <div key={p.id} className="px-5 py-3.5 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-stone-800 truncate">{p.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {p.reference && <span className="text-[10px] text-stone-400 font-mono">{p.reference}</span>}
                          {p.compatible_model ? (
                            <span className="text-[10px] text-blue-500 font-medium">
                              {p.compatible_model.nickname || p.compatible_model.brand} {p.compatible_model.model}
                            </span>
                          ) : (
                            <span className="text-[10px] text-stone-300">genérico</span>
                          )}
                          {p.location_code && <span className="text-[10px] text-stone-400">{p.location_code}</span>}
                        </div>
                      </div>

                      {/* Controle de estoque */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => ajustarEstoque(p.id, -1, p.stock_current)}
                          className="w-7 h-7 rounded-full border border-stone-200 flex items-center justify-center text-stone-500 hover:bg-stone-100 transition-all font-black text-lg leading-none">
                          −
                        </button>
                        <div className={`text-center w-14 py-1.5 rounded-xl border ${zero ? 'bg-red-50 border-red-200' : critico ? 'bg-yellow-50 border-yellow-200' : 'bg-stone-50 border-stone-200'}`}>
                          <p className={`text-sm font-black ${zero ? 'text-red-600' : critico ? 'text-yellow-700' : 'text-stone-700'}`}>{p.stock_current}</p>
                          <p className="text-[8px] text-stone-400 uppercase">/{p.stock_minimum} min</p>
                        </div>
                        <button onClick={() => ajustarEstoque(p.id, 1, p.stock_current)}
                          className="w-7 h-7 rounded-full border border-stone-200 flex items-center justify-center text-stone-500 hover:bg-stone-100 transition-all font-black text-lg leading-none">
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })
      )}
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

  const carregar = useCallback(async () => {
    const { data: { session } } = await auth().auth.getSession()
    if (!session) { window.location.href = '/wm/login'; return }
    setLoading(true)
    const [eqRes, stRes] = await Promise.all([
      db().from('equipment')
        .select('*, location:locations(code), equipment_model:equipment_models(nickname,brand,model)')
        .order('created_at', { ascending: false }),
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

  const calVencendo = standards.filter(s => {
    if (!s.next_calibration) return false
    return Math.floor((new Date(s.next_calibration).getTime() - Date.now()) / 86400000) <= 30
  })

  const equipFiltrado = equipment.filter(e => {
    const q = search.toLowerCase()
    const matchSearch = !search || [e.asset_number, e.serial_number, e.brand, e.model,
      e.equipment_type, e.client_number, e.equipment_model?.nickname].some(v => v?.toLowerCase().includes(q))
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
    <div className="min-h-screen bg-stone-100 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <img src="/logo_wm.png" alt="White Martins" className="h-8 w-auto object-contain" />
          <div className="flex items-center gap-2">
            <button onClick={() => setShowEntrada(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all shadow-md shadow-blue-200">
              <Plus size={14} /> Entrada
            </button>
            <button onClick={logout} title="Sair"
              className="w-9 h-9 rounded-xl border border-stone-200 flex items-center justify-center text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-all">
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {/* Abas */}
        <div className="max-w-4xl mx-auto px-4 flex gap-0 border-t border-stone-100">
          {ABAS.map(a => {
            const Icon = a.icon
            return (
              <button key={a.id} onClick={() => setAba(a.id)}
                className={`flex items-center gap-2 px-4 py-3 text-xs font-black uppercase tracking-widest border-b-2 transition-all ${
                  aba === a.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-stone-400 hover:text-stone-600'
                }`}>
                <Icon size={13} />{a.label}
              </button>
            )
          })}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-5 space-y-4">

        {/* ── ABA EQUIPAMENTOS ── */}
        {aba === 'equipamentos' && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              {[
                { label: 'Total',     value: stats.total,      color: 'text-stone-700',  bg: 'bg-white',       f: 'todos' },
                { label: 'Em Fluxo',  value: stats.fluxo,      color: 'text-amber-700',  bg: 'bg-amber-50',    f: 'entrada' },
                { label: 'Ag. Peças', value: stats.ag_pecas,   color: 'text-yellow-700', bg: 'bg-yellow-50',   f: 'aguardando_pecas' },
                { label: 'Lastro',    value: stats.lastro,     color: 'text-blue-700',   bg: 'bg-blue-50',     f: 'lastro' },
                { label: 'Backup',    value: stats.backup,     color: 'text-purple-700', bg: 'bg-purple-50',   f: 'backup' },
                { label: 'Aplicado',  value: stats.aplicado,   color: 'text-green-700',  bg: 'bg-green-50',    f: 'aplicado' },
                { label: 'Manut.',    value: stats.manutencao, color: 'text-red-700',    bg: 'bg-red-50',      f: 'manutencao_externa' },
                { label: 'Descarte',  value: stats.descarte,   color: 'text-stone-500',  bg: 'bg-stone-200',   f: 'descarte' },
              ].map(s => (
                <button key={s.label} onClick={() => setFilterStatus(s.f)}
                  className={`${s.bg} rounded-2xl p-3 border transition-all hover:shadow-sm text-left ${filterStatus === s.f ? 'border-blue-400 ring-2 ring-blue-200' : 'border-stone-100'}`}>
                  <p className={`text-xl sm:text-2xl font-black ${s.color} leading-none`}>{s.value}</p>
                  <p className="text-[9px] font-black uppercase text-stone-400 mt-1 tracking-wide leading-tight">{s.label}</p>
                </button>
              ))}
            </div>

            {/* Alertas */}
            {stats.ag_pecas > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-3 flex items-center gap-3 cursor-pointer"
                onClick={() => setFilterStatus('aguardando_pecas')}>
                <Clock size={15} className="text-yellow-600 shrink-0" />
                <p className="text-sm font-bold text-yellow-800">{stats.ag_pecas} equipamento(s) aguardando peças</p>
                <ChevronRight size={14} className="text-yellow-400 ml-auto" />
              </div>
            )}
            {calVencendo.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
                <AlertTriangle size={15} className="text-red-500 shrink-0" />
                <p className="text-sm font-bold text-red-700">{calVencendo.length} padrão(ões) com calibração vencendo em 30 dias</p>
              </div>
            )}

            {/* Busca + filtros */}
            <div className="space-y-2">
              <div className="relative">
                <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por ativo, apelido, marca, série..."
                  className="w-full pl-10 pr-4 py-3 rounded-2xl border border-stone-200 bg-white text-sm text-stone-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none" />
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
                {[['todos','Todos'], ...Object.entries(S).map(([k,v]) => [k, v.short])].map(([k, v]) => (
                  <button key={k} onClick={() => setFilterStatus(k)}
                    className={`px-3 py-1.5 rounded-xl text-[10px] font-black whitespace-nowrap uppercase tracking-widest transition-all border ${
                      filterStatus === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-500 border-stone-200'
                    }`}>{v}</button>
                ))}
              </div>
            </div>

            {/* Lista */}
            <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
              {loading ? (
                <div className="p-12 flex items-center justify-center">
                  <Activity size={22} className="text-blue-500 animate-spin" />
                </div>
              ) : equipFiltrado.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <Package size={28} className="text-stone-300 mx-auto" />
                  <p className="text-stone-400 text-sm">
                    {equipment.length === 0 ? 'Nenhum equipamento cadastrado.' : 'Nenhum resultado.'}
                  </p>
                  {equipment.length === 0 && (
                    <button onClick={() => setShowEntrada(true)}
                      className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest">
                      Registrar primeiro equipamento
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="hidden sm:grid grid-cols-[80px_1fr_100px_120px_70px_36px] gap-3 px-5 py-2.5 bg-stone-50 border-b border-stone-100">
                    {['Ativo','Equipamento','Série','Status','Local',''].map(h => (
                      <span key={h} className="text-[9px] font-black uppercase tracking-widest text-stone-400">{h}</span>
                    ))}
                  </div>
                  {equipFiltrado.map((eq, i) => {
                    const nome = eq.equipment_model?.nickname || eq.equipment_type
                    const detalhe = [eq.equipment_model?.brand || eq.brand, eq.equipment_model?.model || eq.model].filter(Boolean).join(' ')
                    return (
                      <div key={eq.id}
                        onClick={() => { setAba('fluxo') }}
                        className={`grid grid-cols-1 sm:grid-cols-[80px_1fr_100px_120px_70px_36px] gap-2 sm:gap-3 px-5 py-3.5 items-center border-b border-stone-50 hover:bg-stone-50 transition-colors cursor-pointer ${i % 2 !== 0 ? 'bg-stone-50/30' : ''}`}>
                        <span className="font-black text-stone-900 text-sm tracking-tight">{eq.asset_number}</span>
                        <div className="min-w-0">
                          {nome && <p className="text-sm font-bold text-stone-700 truncate">{nome}</p>}
                          {detalhe && <p className="text-[11px] text-stone-400 truncate">{detalhe}</p>}
                        </div>
                        <span className="text-xs text-stone-400 font-mono">{eq.serial_number || '—'}</span>
                        <Badge status={eq.status} size="sm" />
                        <div className="flex items-center gap-1">
                          <MapPin size={9} className="text-stone-300 shrink-0" />
                          <span className="text-[11px] font-bold text-stone-500">{eq.location?.code || '—'}</span>
                        </div>
                        <ChevronRight size={13} className="text-stone-300 ml-auto" />
                      </div>
                    )
                  })}
                </>
              )}
            </div>
            <p className="text-center text-[10px] text-stone-400 font-medium">
              {equipment.length} equipamento(s) · Londrina
            </p>
          </>
        )}

        {/* ── ABA FLUXO ── */}
        {aba === 'fluxo' && <AbaFluxo />}

        {/* ── ABA PEÇAS ── */}
        {aba === 'pecas' && <AbaPecas />}

        {/* ── ABA RELATÓRIOS ── */}
        {aba === 'relatorios' && <AbaRelatorios />}

      </main>

      {showEntrada && <ModalEntrada onClose={() => setShowEntrada(false)} onSaved={carregar} />}
    </div>
  )
}