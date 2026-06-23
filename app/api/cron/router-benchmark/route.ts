/**
 * app/api/cron/router-benchmark/route.ts
 *
 * CRON semanal que roda o benchmark do roteador automaticamente.
 *
 * Configurar no vercel.json:
 * {
 *   "crons": [{ "path": "/api/cron/router-benchmark", "schedule": "0 3 * * 1" }]
 * }
 * (Toda segunda-feira às 03:00 UTC)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../.env.local') })

const CRON_SECRET = process.env.CRON_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENROUTER_KEY = process.env.OPENAI_API_KEY!

// ─── Dataset subset (20 casos representativos) ───────────────────────────────

const CRON_CASES = [
  // 4 emocionais
  { id: 'e001', input: 'tô me sentindo sobrecarregado com tudo isso', context_turns: [], expected: { intent: 'emocional', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'e003', input: 'sei lá, acho que criei expectativa demais', context_turns: ['o modelo treinado ficou muito bom mas não vou poder usar'], expected: { intent: 'emocional', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'e007', input: 'foi difícil mas valeu a pena', context_turns: ['terminei o pipeline de fine-tuning hoje'], expected: { intent: 'emocional', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'e010', input: 'tô orgulhoso do que construí', context_turns: ['o Lev respondeu perfeitamente hoje'], expected: { intent: 'emocional', fragments: 1, needs_rag: false, escalate: false } },
  // 4 factuais — escalate: true aceitável (modelos podem querer mais contexto)
  { id: 'f001', input: 'quanto custa o claude opus 4 por milhão de tokens', context_turns: [], expected: { intent: 'factual', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'f004', input: 'o que é mixture of experts', context_turns: [], expected: { intent: 'factual', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'f009', input: 'como funciona o Promise.allSettled no javascript', context_turns: [], expected: { intent: 'factual', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'f010', input: 'qual a diferença entre fine-tuning e RAG', context_turns: [], expected: { intent: 'factual', fragments: 1, needs_rag: false, escalate: false } },
  // 4 ações
  { id: 'a001', input: 'salva isso no meu dossiê', context_turns: ['acabei de decidir pausar o módulo financeiro por 30 dias'], expected: { intent: 'acao', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'a002', input: 'cria um lembrete pra eu revisar isso amanhã às 9h', context_turns: ['preciso revisar o benchmark do roteador'], expected: { intent: 'acao', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'a005', input: 'registra que o custo do mês foi R$260', context_turns: [], expected: { intent: 'acao', fragments: 1, needs_rag: false, escalate: false } },
  { id: 'a007', input: 'me lembra disso na sexta', context_turns: ['tenho reunião com a equipe sobre o WM Lab'], expected: { intent: 'acao', fragments: 1, needs_rag: false, escalate: false } },
  // 4 recuperações
  { id: 'r001', input: 'o que eu disse sobre o custo do modelo semana passada', context_turns: [], expected: { intent: 'recuperacao', fragments: 1, needs_rag: true, escalate: false } },
  { id: 'r005', input: 'qual era o nome daquele modelo que testei', context_turns: [], expected: { intent: 'recuperacao', fragments: 1, needs_rag: true, escalate: true } },
  { id: 'r007', input: 'qual foi o custo total do fine-tuning', context_turns: [], expected: { intent: 'recuperacao', fragments: 1, needs_rag: true, escalate: false } },
  { id: 'r010', input: 'qual era mesmo aquele threshold que definimos', context_turns: [], expected: { intent: 'recuperacao', fragments: 1, needs_rag: true, escalate: true } },
  // 4 híbridos
  { id: 'h001', input: 'tô frustrado com esse custo... aliás salva isso no dossiê', context_turns: ['o fine-tuning custou R$260 e não vou poder usar o modelo'], expected: { intent: 'hibrido', fragments: 2, needs_rag: false, escalate: false } },
  { id: 'h003', input: 'não sei se vale a pena, mas cria um lembrete pra eu decidir amanhã', context_turns: ['estou pensando em refatorar o módulo de memória'], expected: { intent: 'hibrido', fragments: 2, needs_rag: false, escalate: false } },
  { id: 'h005', input: 'me sinto travado... o que eu tinha decidido sobre isso mesmo', context_turns: ['estou pensando na arquitetura do módulo financeiro'], expected: { intent: 'hibrido', fragments: 2, needs_rag: true, escalate: false } },
  { id: 'h010', input: 'tô em dúvida se continuo ou paro, o que eu decidi da última vez numa situação assim', context_turns: [], expected: { intent: 'hibrido', fragments: 2, needs_rag: true, escalate: true } },
]

// ─── IDs atualizados ──────────────────────────────────────────────────────────

const MODELS = [
  { id: 'google/gemini-3.1-flash-lite-preview', alias: 'flash-lite' },
  { id: 'google/gemini-2.5-flash',              alias: 'flash-25'   },
  { id: 'qwen/qwen3-8b',                        alias: 'qwen-8b'    },
]

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(input: string, contextTurns: string[]): string {
  const ctx = contextTurns.length > 0
    ? `\nContexto anterior:\n${contextTurns.map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
    : ''

  return `Você é um roteador de intenções. Retorne APENAS JSON válido, sem markdown, sem texto extra.
${ctx}
Mensagem: "${input}"

Regras:
- intent: "emocional" | "factual" | "acao" | "recuperacao" | "hibrido"
- fragments: número de intenções distintas (hibrido = 2+)
- needs_rag: true somente para recuperacao ou hibrido com busca em memória
- escalate: true somente se pronome sem antecedente claro E contexto insuficiente para resolver
- factual nunca precisa de needs_rag nem escalate

{"intent":"","fragments":1,"needs_rag":false,"escalate":false,"resolution_confidence":0.9,"ambiguous":false,"entities":{"x":null,"y":"","z":""},"reason":null}`
}

// ─── Call model com parser robusto ────────────────────────────────────────────

async function callModel(modelId: string, prompt: string) {
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
        max_tokens: 200,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = await res.json()
    const latency = Date.now() - start
    const raw = data.choices?.[0]?.message?.content ?? ''

    // Parser robusto — extrai o primeiro bloco JSON independente de markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { output: null, latency, error: `JSON não encontrado. Raw: ${raw.substring(0, 200)}` }

    const output = JSON.parse(jsonMatch[0].replace(/[\u0000-\u001F\u007F]/g, ' ').trim())
    return { output, latency, error: null }
  } catch (err: any) {
    return { output: null, latency: Date.now() - start, error: err.message }
  }
}

// ─── Avaliação com critério relaxado para factual ────────────────────────────

function evaluate(c: typeof CRON_CASES[0], output: any) {
  const intent_correct = output?.intent === c.expected.intent
  const fragments_correct = output?.fragments === c.expected.fragments
  const needs_rag_correct = output?.needs_rag === c.expected.needs_rag

  // factual: ignora escalate — modelo pode querer mais contexto e isso não é erro
  const escalate_correct = c.expected.intent === 'factual'
    ? true
    : output?.escalate === c.expected.escalate

  const overall_correct = intent_correct && fragments_correct && needs_rag_correct && escalate_correct

  return { intent_correct, fragments_correct, needs_rag_correct, escalate_correct, overall_correct }
}

// ─── Handler CRON ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { db: { schema: 'jarvis' } })
  const results: any[] = []
  const scores: Record<string, Record<string, { correct: number; total: number; latency: number[] }>> = {}

  for (const model of MODELS) {
    scores[model.alias] = {}

    for (const c of CRON_CASES) {
      const prompt = buildPrompt(c.input, c.context_turns)
      const { output, latency, error } = await callModel(model.id, prompt)
      const { intent_correct, fragments_correct, needs_rag_correct, escalate_correct, overall_correct } = evaluate(c, output)

      const cat = c.expected.intent
      if (!scores[model.alias][cat]) scores[model.alias][cat] = { correct: 0, total: 0, latency: [] }
      scores[model.alias][cat].total++
      if (overall_correct) scores[model.alias][cat].correct++
      scores[model.alias][cat].latency.push(latency)

      results.push({
        case_id: c.id,
        model_alias: model.alias,
        category: cat,
        intent_correct,
        fragments_correct,
        needs_rag_correct,
        escalate_correct,
        entities_x_present: true,
        resolution_confidence: output?.resolution_confidence ?? 0,
        ambiguous: output?.ambiguous ?? false,
        overall_correct,
        latency_ms: latency,
        raw_output: JSON.stringify(output),
        error,
        ran_at: new Date().toISOString(),
      })

      await new Promise(r => setTimeout(r, 150))
    }
  }

  // Salva runs
  await supabase.from('router_benchmark_runs').insert(results)

  // Atualiza scores com média móvel 80/20
  for (const [modelAlias, cats] of Object.entries(scores)) {
    for (const [category, data] of Object.entries(cats)) {
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
        model_alias: modelAlias,
        category,
        score: updatedScore,
        avg_latency_ms: avgLatency,
        hit_count: (existing?.hit_count ?? 0) + data.total,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'model_alias,category' })
    }
  }

  // Sumário
  const summary: Record<string, any> = {}
  for (const [model, cats] of Object.entries(scores)) {
    let totalCorrect = 0, totalCases = 0
    for (const d of Object.values(cats)) { totalCorrect += d.correct; totalCases += d.total }
    summary[model] = {
      overall_accuracy: `${((totalCorrect / totalCases) * 100).toFixed(1)}%`,
      by_category: Object.fromEntries(
        Object.entries(cats).map(([cat, d]) => [cat, `${((d.correct / d.total) * 100).toFixed(0)}%`])
      ),
    }
  }

  return NextResponse.json({ ok: true, ran_at: new Date().toISOString(), cases: results.length, summary })
}