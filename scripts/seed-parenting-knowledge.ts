/**
 * seed-parenting-knowledge.ts
 *
 * Importa o parenting-dataset.jsonl para a tabela jarvis.knowledge_base
 * com embeddings gerados para cada caso.
 *
 * Uso:
 *   npx tsx seed-parenting-knowledge.ts --dry-run  → mostra sem inserir
 *   npx tsx seed-parenting-knowledge.ts            → insere no banco
 */

import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../.env.local') })

import fs from 'fs'
import path from 'path'

const SUPABASE_URL = "https://rkvwlzbsxtnxtzeldych.supabase.co"
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrdndsemJzeHRueHR6ZWxkeWNoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA1NDA0NywiZXhwIjoyMDg1NjMwMDQ3fQ.u1ddjbXZKZ5KkwH91QSL7WtkDsSaZuUwyscY46HS4oE"
const OPENROUTER_KEY = "***REMOVED***"
const DRY_RUN = process.argv.includes('--dry-run')
const DATASET_PATH = path.join(process.cwd(), 'parenting-dataset.jsonl')

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENROUTER_KEY) {
  console.error('❌ Variáveis de ambiente não carregadas.')
  process.exit(1)
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    })
    const data = await res.json()
    return data.data?.[0]?.embedding ?? null
  } catch {
    return null
  }
}

// ─── Supabase insert ──────────────────────────────────────────────────────────

async function insertKnowledge(rows: any[]) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_base`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase insert falhou: ${err}`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seed: Knowledge Base de Parentalidade')
  console.log(`   Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUÇÃO'}`)

  const raw = fs.readFileSync(DATASET_PATH, 'utf-8')
  const cases = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
  console.log(`   Casos: ${cases.length}\n`)

  const rows: any[] = []
  let embeddingErrors = 0

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]

    // Texto para embedding: input + output concatenados para busca rica
    const embeddingText = `${c.input}\n${c.output}`
    process.stdout.write(`[${i + 1}/${cases.length}] Gerando embedding...`)

    const embedding = await generateEmbedding(embeddingText)
    if (!embedding) {
      embeddingErrors++
      process.stdout.write(' ⚠️ falhou\n')
    } else {
      process.stdout.write(' ✓\n')
    }

    rows.push({
      domain:           'parentalidade',
      teoria_principal: c.teoria_principal,
      passo_fluxo:      c.passo_fluxo,
      input_exemplo:    c.input,
      output_ideal:     c.output,
      tags:             c.tags,
      embedding:        embedding,
    })

    // Pausa para não estourar rate limit
    await new Promise(r => setTimeout(r, 200))
  }

  console.log(`\n   Embeddings gerados: ${cases.length - embeddingErrors}/${cases.length}`)

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — nada foi inserido.')
    console.log('\nPrimeiro registro:')
    const sample = { ...rows[0] }
    sample.embedding = sample.embedding ? `[vetor de ${sample.embedding.length} dims]` : null
    console.log(JSON.stringify(sample, null, 2))
    return
  }

  console.log('\n📤 Inserindo no Supabase em lotes de 10...')
  const BATCH_SIZE = 10
  let inserted = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    try {
      await insertKnowledge(batch)
      inserted += batch.length
      console.log(`   ✓ Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${inserted}/${rows.length} inseridos`)
    } catch (err: any) {
      console.error(`   ✗ Lote ${Math.floor(i / BATCH_SIZE) + 1} falhou:`, err.message)
    }
  }

  console.log(`\n✅ Seed concluído. ${inserted} registros na tabela jarvis.knowledge_base`)
}

main().catch(console.error)