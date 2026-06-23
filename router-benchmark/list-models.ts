/**
 * list-models.ts
 * 
 * Consulta a API do OpenRouter e lista modelos baratos disponíveis agora.
 * Use para validar IDs antes de adicionar ao benchmark.
 * 
 * Uso:
 *   npx tsx list-models.ts                    → lista top 20 mais baratos
 *   npx tsx list-models.ts --free             → somente modelos gratuitos
 *   npx tsx list-models.ts --search gemini    → filtra por nome
 */

import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../.env.local') })

const OPENROUTER_KEY = process.env.OPENAI_API_KEY!
const FREE_ONLY = process.argv.includes('--free')
const SEARCH = process.argv.includes('--search')
  ? process.argv[process.argv.indexOf('--search') + 1]?.toLowerCase()
  : null

async function listModels() {
  const params = new URLSearchParams({
    sort: 'pricing-low-to-high',
    output_modalities: 'text',
  })

  if (FREE_ONLY) params.set('max_price', '0')
  if (SEARCH) params.set('q', SEARCH)

  const res = await fetch(`https://openrouter.ai/api/v1/models?${params}`, {
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` }
  })

  const data = await res.json()
  const models = data.data ?? []

  console.log(`\n${'ID'.padEnd(55)} ${'Nome'.padEnd(35)} ${'Input$/M'.padEnd(10)} ${'Output$/M'.padEnd(10)}`)
  console.log('─'.repeat(115))

  let count = 0
  for (const m of models) {
    if (count >= 30) break

    const inputPrice  = parseFloat(m.pricing?.prompt ?? '0') * 1_000_000
    const outputPrice = parseFloat(m.pricing?.completion ?? '0') * 1_000_000
    const isFree      = inputPrice === 0 && outputPrice === 0

    if (FREE_ONLY && !isFree) continue

    const freeTag = isFree ? ' [FREE]' : ''
    console.log(
      `${(m.id + freeTag).padEnd(55)} ${m.name.substring(0, 34).padEnd(35)} ${'$' + inputPrice.toFixed(4)}`.padEnd(100) +
      ` ${'$' + outputPrice.toFixed(4)}`
    )
    count++
  }

  console.log(`\nTotal exibido: ${count} modelos`)
  console.log('\nDica: copie o ID exato da coluna ID para usar no benchmark.')
}

listModels().catch(console.error)