'use client'
export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Save, AlertTriangle, CheckCircle } from 'lucide-react'

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'white_martins' }, auth: { storageKey: 'wm-auth' } }
  )
}

const inp = "w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-50 outline-none transition-all font-medium"
const lbl = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5"

const FILTER_STATUS = ['ok','meia_vida','necessita_troca','trocado','sem_estoque']
const SENSOR_STATUS = ['presente','saiu_com_paciente','em_outro_cliente','danificado','ausente']
const STATUS_LABELS: Record<string,string> = {
  ok: 'OK', meia_vida: 'Meia Vida', necessita_troca: 'Necessita Troca',
  trocado: 'Trocado', sem_estoque: 'Sem Estoque',
  presente: 'Presente', saiu_com_paciente: 'Saiu c/ Paciente',
  em_outro_cliente: 'Em outro cliente', danificado: 'Danificado', ausente: 'Ausente',
}

export default function EditarEquipamento() {
  const router = useRouter()
  const params = useParams()
  const id = params?.id as string

  const [form, setForm] = useState<any>(null)
  const [models, setModels] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    Promise.all([
      db().from('equipment').select('*, location:locations(code), equipment_model:equipment_models(*)').eq('id', id).single(),
      db().from('equipment_models').select('*').order('nickname'),
      db().from('locations').select('id,code,area,description').eq('active', true).order('code'),
    ]).then(([eqRes, mRes, lRes]) => {
      if (eqRes.data) {
        const eq = eqRes.data
        // Normaliza location_code a partir do join location:locations(code)
        setForm({ ...eq, location_code: eq.location?.code || eq.location_code || '' })
      }
      setModels(mRes.data || [])
      setLocations(lRes.data || [])
      setLoading(false)
    })
  }, [id])

  const f = (field: string, val: any) => setForm((p: any) => ({...p, [field]: val}))

  const salvar = async () => {
    if (!form) return
    setSaving(true); setError('')
    // Busca por code (seleção no dropdown) ou mantém location_id atual se não mudou
    const loc = locations.find(l => l.code === form.location_code)
    const finalLocationId = loc?.id || (form.location_code ? null : form.location_id)
    const { error: err } = await db().from('equipment').update({
      serial_number: form.serial_number || null,
      client_number: form.client_number || null,
      seal_number: form.seal_number || null,
      model_id: form.model_id || null,
      brand: models.find(m => m.id === form.model_id)?.brand || form.brand,
      model: models.find(m => m.id === form.model_id)?.model || form.model,
      location_id: finalLocationId,
      notes: form.notes || null,
      // concentrador
      flow_measurement: form.flow_measurement ? Number(form.flow_measurement) : null,
      o2_concentration: form.o2_concentration ? Number(form.o2_concentration) : null,
      filter_status: form.filter_status,
      filter_last_change: form.filter_last_change || null,
      filter_next_change: form.filter_next_change || null,
      cannula_status: form.cannula_status,
      alarm_status: form.alarm_status,
      has_humidifier: form.has_humidifier,
      opi_indicator: form.opi_indicator,
      // oxímetro
      sensor_adult_status: form.sensor_adult_status,
      sensor_pediatric_status: form.sensor_pediatric_status,
      sensor_adult_client: form.sensor_adult_client || null,
      sensor_pediatric_client: form.sensor_pediatric_client || null,
      battery_status: form.battery_status,
      display_status: form.display_status,
      spo2_reading: form.spo2_reading ? Number(form.spo2_reading) : null,
      hr_reading: form.hr_reading ? Number(form.hr_reading) : null,
    }).eq('id', id)

    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(true)
    setTimeout(() => { setSaved(false); router.push('/wm') }, 1500)
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  )

  if (!form) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-gray-400">Equipamento não encontrado.</p>
    </div>
  )

  const isConcentrador = form.equipment_category === 'concentrador' || form.equipment_type?.toLowerCase().includes('concentrador')
  const isOximetro = form.equipment_category === 'oximetro' || form.equipment_type?.toLowerCase().includes('oxímetro') || form.equipment_type?.toLowerCase().includes('oximetro')

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.back()} className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 transition-all">
              <ArrowLeft size={15} />
            </button>
            <div>
              <p className="font-black text-gray-900 text-sm">Editar Equipamento</p>
              <p className="text-xs text-gray-400">{form.asset_number} · {form.equipment_type || form.equipment_model?.equipment_type || '—'}</p>
            </div>
          </div>
          <button onClick={salvar} disabled={saving || saved}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${saved ? 'bg-green-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95'} disabled:opacity-60`}>
            {saved ? <><CheckCircle size={14} />Salvo!</> : saving ? 'Salvando...' : <><Save size={14} />Salvar</>}
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 space-y-5">

        {/* Identificação */}
        <div className="bg-white rounded-3xl border border-gray-200 p-5 space-y-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Identificação</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={lbl}>Nº Patrimônio (não editável)</label>
              <input value={form.asset_number} disabled className={inp + ' bg-gray-50 text-gray-400'} />
            </div>
            <div>
              <label className={lbl}>Número de Série</label>
              <input value={form.serial_number || ''} onChange={e => f('serial_number', e.target.value)} className={inp} />
            </div>
            <div>
              <label className={lbl}>Nº do Cliente</label>
              <input value={form.client_number || ''} onChange={e => f('client_number', e.target.value)} className={inp} />
            </div>
            <div>
              <label className={lbl}>Nº do Lacre</label>
              <input value={form.seal_number || ''} onChange={e => f('seal_number', e.target.value)} className={inp} />
            </div>
          </div>
        </div>

        {/* Modelo */}
        <div className="bg-white rounded-3xl border border-gray-200 p-5 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Modelo</p>
          <select value={form.model_id || ''} onChange={e => f('model_id', e.target.value)} className={inp}>
            <option value="">— Sem modelo —</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.nickname || m.equipment_type} — {m.brand} {m.model}</option>)}
          </select>
        </div>

        {/* Localização */}
        <div className="bg-white rounded-3xl border border-gray-200 p-5 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Localização</p>
          <select value={form.location_code || form.location?.code || ''} onChange={e => f('location_code', e.target.value)} className={inp}>
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

        {/* Concentrador */}
        {isConcentrador && (
          <div className="bg-white rounded-3xl border border-gray-200 p-5 space-y-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Concentrador — Medições e Componentes</p>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={lbl}>Fluxo (L/min)</label><input type="number" step="0.1" value={form.flow_measurement || ''} onChange={e => f('flow_measurement', e.target.value)} className={inp} /></div>
              <div><label className={lbl}>O₂ (%)</label><input type="number" step="0.1" value={form.o2_concentration || ''} onChange={e => f('o2_concentration', e.target.value)} className={inp} /></div>
              <div><label className={lbl}>Data entrada filtro</label><input type="date" value={form.filter_last_change || ''} onChange={e => f('filter_last_change', e.target.value)} className={inp} /></div>
              <div><label className={lbl}>Próxima troca filtro</label><input type="date" value={form.filter_next_change || ''} onChange={e => f('filter_next_change', e.target.value)} className={inp} /></div>
            </div>
            <div>
              <label className={lbl}>Status do Filtro</label>
              <div className="flex gap-2 flex-wrap">
                {FILTER_STATUS.map(s => (
                  <button key={s} onClick={() => f('filter_status', s)}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.filter_status === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={lbl}>Status da Cânula</label>
              <div className="flex gap-2 flex-wrap">
                {['ok','meia_vida','necessita_troca','trocada'].map(s => (
                  <button key={s} onClick={() => f('cannula_status', s)}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form.cannula_status === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>
                    {STATUS_LABELS[s] || s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={lbl}>Alarme</label>
              <select value={form.alarm_status || 'ok'} onChange={e => f('alarm_status', e.target.value)} className={inp}>
                <option value="ok">OK</option>
                <option value="falha">Falha</option>
                <option value="nao_testado">Não testado</option>
              </select>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.has_humidifier || false} onChange={e => f('has_humidifier', e.target.checked)} className="w-4 h-4 accent-blue-600" />
                <span className="text-sm font-semibold text-gray-700">Umidificador</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.opi_indicator || false} onChange={e => f('opi_indicator', e.target.checked)} className="w-4 h-4 accent-blue-600" />
                <span className="text-sm font-semibold text-gray-700">OPI</span>
              </label>
            </div>
          </div>
        )}

        {/* Oxímetro */}
        {isOximetro && (
          <div className="bg-white rounded-3xl border border-gray-200 p-5 space-y-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Oxímetro — Sensores e Medições</p>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={lbl}>SpO₂ (%)</label><input type="number" step="0.1" value={form.spo2_reading || ''} onChange={e => f('spo2_reading', e.target.value)} className={inp} /></div>
              <div><label className={lbl}>FC (bpm)</label><input type="number" value={form.hr_reading || ''} onChange={e => f('hr_reading', e.target.value)} className={inp} /></div>
            </div>
            {[
              ['Sensor Adulto', 'sensor_adult_status', 'sensor_adult_client'],
              ['Sensor Pediátrico', 'sensor_pediatric_status', 'sensor_pediatric_client'],
            ].map(([label, statusField, clientField]) => (
              <div key={statusField} className="space-y-2">
                <label className={lbl}>{label}</label>
                <div className="flex gap-2 flex-wrap">
                  {SENSOR_STATUS.map(s => (
                    <button key={s} onClick={() => f(statusField, s)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${form[statusField] === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500'}`}>
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
                {(form[statusField] === 'saiu_com_paciente' || form[statusField] === 'em_outro_cliente') && (
                  <input value={form[clientField] || ''} onChange={e => f(clientField, e.target.value)} className={inp} placeholder="Nº do cliente" />
                )}
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Bateria</label>
                <select value={form.battery_status || 'ok'} onChange={e => f('battery_status', e.target.value)} className={inp}>
                  <option value="ok">OK</option>
                  <option value="fraca">Fraca</option>
                  <option value="necessita_troca">Necessita troca</option>
                </select>
              </div>
              <div>
                <label className={lbl}>Display</label>
                <select value={form.display_status || 'ok'} onChange={e => f('display_status', e.target.value)} className={inp}>
                  <option value="ok">OK</option>
                  <option value="danificado">Danificado</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Observações */}
        <div className="bg-white rounded-3xl border border-gray-200 p-5">
          <label className={lbl}>Observações</label>
          <textarea value={form.notes || ''} onChange={e => f('notes', e.target.value)}
            className={inp + ' resize-none'} rows={3} />
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
            <AlertTriangle size={13} className="text-red-500" />
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}

        <button onClick={salvar} disabled={saving || saved}
          className={`w-full py-4 rounded-2xl font-black text-sm uppercase tracking-widest transition-all ${saved ? 'bg-green-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'} disabled:opacity-60 shadow-lg shadow-blue-100`}>
          {saved ? '✓ Salvo com sucesso!' : saving ? 'Salvando...' : 'Salvar alterações'}
        </button>
      </main>
    </div>
  )
}
