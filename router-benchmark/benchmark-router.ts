/**
 * benchmark-router.ts
 *
 * Avalia modelos candidatos a roteador usando o dataset router-train.jsonl.
 *
 * Uso:
 *   npx tsx benchmark-router.ts                   → roda todos os casos
 *   npx tsx benchmark-router.ts --category hibrido → filtra por categoria
 *   npx tsx benchmark-router.ts --dry-run          → sem salvar no banco
 */

// DOTENV DEVE SER O PRIMEIRO — antes de qualquer outra importação
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../.env.local') })

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://rkvwlzbsxtnxtzeldych.supabase.co"
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENROUTER_KEY = process.env.OPENAI_API_KEY

// Valida env vars antes de começar
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENROUTER_KEY) {
  console.error('❌ Variáveis de ambiente não carregadas. Verifique o caminho do .env.local')
  console.error(`   NEXT_PUBLIC_SUPABASE_URL: ${SUPABASE_URL ? '✓' : '✗ FALTANDO'}`)
  console.error(`   SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_KEY ? '✓' : '✗ FALTANDO'}`)
  console.error(`   OPENAI_API_KEY: ${OPENROUTER_KEY ? '✓' : '✗ FALTANDO'}`)
  process.exit(1)
}

const MODELS_TO_TEST = [
  { id: 'anthropic/claude-sonnet-4.6', alias: 'claude-sonnet' },
  { id: 'google/gemini-2.5-flash',     alias: 'flash-25'      },
]

const DATASET_PATH = path.join(process.cwd(), 'router-train.jsonl')
const DRY_RUN = process.argv.includes('--dry-run')
const FILTER_CATEGORY = process.argv.includes('--category')
  ? process.argv[process.argv.indexOf('--category') + 1]
  : null

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouterCase {
  id: string
  input: string
  context_turns: string[]
  expected: {
    intent: 'emocional' | 'factual' | 'acao' | 'recuperacao' | 'hibrido'
    fragments: number
    needs_rag: boolean
    escalate: boolean
    entities: { x: string | null; y: string | null; z: string | null }
  }
}

interface RouterOutput {
  intent: string
  fragments: number
  needs_rag: boolean
  escalate: boolean
  resolution_confidence: number
  ambiguous: boolean
  entities: { x: string | null; y: string | null; z: string | null }
  reason?: string
}

interface CaseResult {
  case_id: string
  model_alias: string
  category: string
  intent_correct: boolean
  fragments_correct: boolean
  needs_rag_correct: boolean
  escalate_correct: boolean
  entities_x_present: boolean
  resolution_confidence: number
  ambiguous: boolean
  overall_correct: boolean
  latency_ms: number
  raw_output: string
  error?: string
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildRouterPrompt(input: string, contextTurns: string[]): string {
  const contextBlock = contextTurns.length > 0
    ? `\nContexto das mensagens anteriores:\n${contextTurns.map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
    : ''

  return `Você é um roteador de intenções de um assistente pessoal. Analise a mensagem e retorne APENAS um JSON válido, sem markdown, sem explicações.
${contextBlock}
Mensagem atual: "${input}"

Categorias de intent:
- "emocional": desabafo, sentimento, estado emocional — sem intenção de ação ou busca
- "factual": conhecimento geral que qualquer pessoa poderia responder (tecnologia, definições, comparações públicas) — NUNCA precisa buscar memória pessoal
- "acao": comando explícito — salvar, criar lembrete, registrar, marcar, arquivar
- "recuperacao": busca em MEMÓRIA PESSOAL do usuário — o que EU disse, o que EU decidi, quanto EU gastei, quando EU fiz — só o próprio usuário sabe a resposta
- "hibrido": contém MAIS DE UMA categoria distinta na mesma mensagem

Distinção crítica:
- "quanto custa o Claude?" → factual (conhecimento público)
- "quanto EU gastei no fine-tuning?" → recuperacao (memória pessoal, needs_rag=true)
- "qual a diferença entre RAG e fine-tuning?" → factual
- "qual decisão EU tomei sobre o módulo?" → recuperacao (needs_rag=true)

Regras:
- fragments: 1 para intenção única, 2+ para hibrido
- needs_rag: true SOMENTE para recuperacao ou hibrido com busca em memória pessoal
- escalate: true somente se pronome sem antecedente claro E contexto insuficiente para resolver
- factual NUNCA tem needs_rag=true nem escalate=true
- emocional NUNCA tem needs_rag=true
- resolution_confidence: 0.0 a 1.0

Retorne APENAS o JSON:
{
  "intent": "",
  "fragments": 1,
  "needs_rag": false,
  "escalate": false,
  "resolution_confidence": 0.9,
  "ambiguous": false,
  "entities": { "x": null, "y": "", "z": "" },
  "reason": null
}`
}

// ─── Call OpenRouter ──────────────────────────────────────────────────────────

async function callModel(
  modelId: string,
  prompt: string
): Promise<{ output: RouterOutput | null; latency: number; raw: string; error?: string }> {
  const start = Date.now()

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 300,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const data = await res.json()
    const latency = Date.now() - start

    if (!res.ok) {
      return { output: null, latency, raw: '', error: `HTTP ${res.status}: ${data.error?.message}` }
    }

    const raw = data.choices?.[0]?.message?.content ?? ''

    // Parser robusto — extrai bloco JSON independente de markdown ou texto extra
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { output: null, latency, raw, error: `JSON não encontrado. Raw: ${raw.substring(0, 200)}` }
    }

    const clean = jsonMatch[0]
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()

    const output: RouterOutput = JSON.parse(clean)

    if (!output.intent || typeof output.fragments !== 'number') {
      return { output: null, latency, raw, error: `JSON incompleto: ${clean.substring(0, 200)}` }
    }

    return { output, latency, raw }
  } catch (err: any) {
    return { output: null, latency: Date.now() - start, raw: '', error: err.message }
  }
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────

function evaluate(
  caseData: RouterCase,
  modelAlias: string,
  output: RouterOutput | null,
  latency: number,
  raw: string,
  error?: string
): CaseResult {
  if (!output) {
    return {
      case_id: caseData.id, model_alias: modelAlias, category: caseData.expected.intent,
      intent_correct: false, fragments_correct: false, needs_rag_correct: false,
      escalate_correct: false, entities_x_present: false, resolution_confidence: 0,
      ambiguous: false, overall_correct: false, latency_ms: latency, raw_output: raw, error,
    }
  }

  const intent_correct = output.intent === caseData.expected.intent
  const fragments_correct = output.fragments === caseData.expected.fragments
  const needs_rag_correct = output.needs_rag === caseData.expected.needs_rag

  // factual: ignora escalate — modelo pode querer mais contexto e isso não é erro de roteamento
  const escalate_correct = caseData.expected.intent === 'factual'
    ? true
    : output.escalate === caseData.expected.escalate

  const entities_x_present = caseData.expected.entities.x === null
    ? true
    : output.entities?.x !== null && output.entities?.x !== undefined

  const overall_correct = intent_correct && fragments_correct && needs_rag_correct && escalate_correct

  return {
    case_id: caseData.id, model_alias: modelAlias, category: caseData.expected.intent,
    intent_correct, fragments_correct, needs_rag_correct, escalate_correct,
    entities_x_present, resolution_confidence: output.resolution_confidence ?? 0,
    ambiguous: output.ambiguous ?? false, overall_correct,
    latency_ms: latency, raw_output: raw, error,
  }
}

// ─── Score Summary ────────────────────────────────────────────────────────────

function summarizeScores(results: CaseResult[]) {
  const byModel: Record<string, Record<string, { correct: number; total: number; latency: number[] }>> = {}
  for (const r of results) {
    if (!byModel[r.model_alias]) byModel[r.model_alias] = {}
    if (!byModel[r.model_alias][r.category]) {
      byModel[r.model_alias][r.category] = { correct: 0, total: 0, latency: [] }
    }
    byModel[r.model_alias][r.category].total++
    if (r.overall_correct) byModel[r.model_alias][r.category].correct++
    byModel[r.model_alias][r.category].latency.push(r.latency_ms)
  }
  return byModel
}

// ─── Persist ──────────────────────────────────────────────────────────────────

async function persistResults(results: CaseResult[], scores: ReturnType<typeof summarizeScores>) {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, { db: { schema: 'jarvis' } })

  const { error: insertError } = await supabase
    .from('router_benchmark_runs')
    .insert(results.map(r => ({ ...r, ran_at: new Date().toISOString() })))

  if (insertError) console.error('Erro ao salvar runs:', insertError.message)

  for (const [modelAlias, categories] of Object.entries(scores)) {
    for (const [category, data] of Object.entries(categories)) {
      const newScore = data.correct / data.total
      const avgLatency = data.latency.reduce((a, b) => a + b, 0) / data.latency.length

      const { data: existing } = await supabase
        .from('router_model_scores')
        .select('score, hit_count')
        .eq('model_alias', modelAlias)
        .eq('category', category)
        .single()

      const updatedScore = existing ? existing.score * 0.8 + newScore * 0.2 : newScore

      await supabase.from('router_model_scores').upsert({
        model_alias: modelAlias, category,
        score: updatedScore, avg_latency_ms: avgLatency,
        hit_count: (existing?.hit_count ?? 0) + data.total,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'model_alias,category' })
    }
  }

  console.log('✅ Resultados salvos no Supabase.')
}

// ─── Print Report ─────────────────────────────────────────────────────────────

function printReport(scores: ReturnType<typeof summarizeScores>) {
  console.log('\n══════════════════════════════════════════════')
  console.log('  ROUTER BENCHMARK REPORT')
  console.log('══════════════════════════════════════════════\n')

  const categories = ['emocional', 'factual', 'acao', 'recuperacao', 'hibrido']

  for (const [model, cats] of Object.entries(scores)) {
    console.log(`▶ ${model}`)
    let totalCorrect = 0, totalCases = 0

    for (const cat of categories) {
      const d = cats[cat]
      if (!d) continue
      const pct = ((d.correct / d.total) * 100).toFixed(0)
      const avgLat = (d.latency.reduce((a, b) => a + b, 0) / d.latency.length).toFixed(0)
      const filled = Math.round(d.correct / d.total * 10)
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
      console.log(`  ${cat.padEnd(12)} ${bar} ${pct}% (${d.correct}/${d.total}) ~${avgLat}ms`)
      totalCorrect += d.correct
      totalCases += d.total
    }

    const overall = ((totalCorrect / totalCases) * 100).toFixed(1)
    console.log(`  ${'TOTAL'.padEnd(12)} ${'─'.repeat(10)} ${overall}% (${totalCorrect}/${totalCases})\n`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Router Benchmark iniciado')
  console.log(`   Modo: ${DRY_RUN ? 'DRY RUN (sem salvar)' : 'PRODUÇÃO'}`)
  if (FILTER_CATEGORY) console.log(`   Filtro: ${FILTER_CATEGORY}`)

  const raw = fs.readFileSync(DATASET_PATH, 'utf-8')
  let cases: RouterCase[] = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))

  if (FILTER_CATEGORY) cases = cases.filter(c => c.expected.intent === FILTER_CATEGORY)

  console.log(`   Casos: ${cases.length} | Modelos: ${MODELS_TO_TEST.length}`)
  console.log(`   Total de chamadas: ${cases.length * MODELS_TO_TEST.length}\n`)

  const allResults: CaseResult[] = []

  for (const model of MODELS_TO_TEST) {
    console.log(`\n🔍 Testando: ${model.alias} (${model.id})`)

    for (const caseData of cases) {
      const prompt = buildRouterPrompt(caseData.input, caseData.context_turns)
      const { output, latency, raw, error } = await callModel(model.id, prompt)
      const result = evaluate(caseData, model.alias, output, latency, raw, error)
      allResults.push(result)

      const icon = result.overall_correct ? '✓' : '✗'
      const conf = output?.resolution_confidence?.toFixed(2) ?? '---'
      const err = error ? ` ⚠ ${error.substring(0, 60)}` : ''
      process.stdout.write(`  ${icon} [${caseData.id}] conf:${conf} lat:${latency}ms${err}\n`)

      await new Promise(r => setTimeout(r, 200))
    }
  }

  const scores = summarizeScores(allResults)
  printReport(scores)

  if (!DRY_RUN) {
    await persistResults(allResults, scores)
  } else {
    console.log('\n⚠️  DRY RUN: nada foi salvo no banco.')
  }
}

main().catch(console.error)