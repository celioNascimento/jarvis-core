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
import { createClient } from '@supabase/supabase-js'

// Aceita nomes alternativos comuns para cada variável, já que diferentes partes
// do projeto (lib/jarvis.ts vs. scripts) podem ter sido escritas com convenções
// diferentes (com/sem prefixo NEXT_PUBLIC_, OPENAI_ vs OPENROUTER_, etc).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY
const DRY_RUN = process.argv.includes('--dry-run')
const DATASET_PATH = path.join(process.cwd(), 'parenting-dataset.jsonl')

const faltando: string[] = []
if (!SUPABASE_URL) faltando.push('NEXT_PUBLIC_SUPABASE_URL (ou SUPABASE_URL)')
if (!SUPABASE_SERVICE_KEY) faltando.push('SUPABASE_SERVICE_ROLE_KEY')
if (!OPENROUTER_KEY) faltando.push('OPENROUTER_API_KEY (ou OPENAI_API_KEY)')

if (faltando.length > 0) {
  console.error('❌ Variáveis de ambiente faltando:')
  faltando.forEach(v => console.error(`   - ${v}`))
  console.error(`\n   Verifique os nomes exatos em D:\\Projetos\\jarvis-core\\.env.local`)
  process.exit(1)
}

// ─── Cliente Supabase (schema "jarvis") ────────────────────────────────────────
// Importante: a tabela knowledge_base vive no schema "jarvis", não no "public".
// Passar { db: { schema: 'jarvis' } } faz o supabase-js enviar automaticamente
// os headers Content-Profile / Accept-Profile corretos em cada requisição,
// evitando o erro PGRST205 ("Could not find the table 'public.knowledge_base'").
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
  db: { schema: 'jarvis' },
  auth: { persistSession: false },
})

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
  const { error } = await supabase.from('knowledge_base').insert(rows)
  if (error) {
    throw new Error(`Supabase insert falhou: ${JSON.stringify(error)}`)
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

  console.log('\n📤 Inserindo no Supabase (schema "jarvis") em lotes de 10...')
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