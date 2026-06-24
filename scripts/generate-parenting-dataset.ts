/**
 * generate-parenting-dataset.ts
 *
 * Gera dataset JSONL sobre parentalidade consciente baseado nas 4 teorias:
 * Siegel (Whole-Brain), Harvard (Funções Executivas), Shanker (Self-Reg), Greene (CPS)
 *
 * Gerador: gemini-2.5-flash
 * Juiz:    gemini-2.5-flash (validação simples de aderência ao fluxo)
 *
 * Uso:
 *   npx tsx generate-parenting-dataset.ts           → gera + valida + salva
 *   npx tsx generate-parenting-dataset.ts --dry-run → mostra sem salvar
 *
 * Custo estimado: ~R$2-4 para 50 casos
 */

import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '../.env.local') })

import fs from 'fs'
import path from 'path'

const OPENROUTER_KEY = process.env.OPENAI_API_KEY!
const DRY_RUN = process.argv.includes('--dry-run')
const OUTPUT_PATH = path.join(process.cwd(), 'parenting-dataset.jsonl')
const MODEL_GENERATOR = 'google/gemini-2.5-flash'
const MODEL_JUDGE = 'anthropic/claude-haiku-4.5'

if (!OPENROUTER_KEY) {
  console.error('❌ OPENAI_API_KEY não encontrada no .env.local')
  process.exit(1)
}

// ─── Conhecimento base (as 4 teorias) ────────────────────────────────────────

const KNOWLEDGE_BASE = `
Você é um especialista em parentalidade consciente. Use APENAS estas 4 teorias como base:

## 1. Siegel — Whole-Brain Child (O Cérebro de Dois Andares)
- Andar de baixo: amígdala/tronco cerebral → emoções intensas, reações primitivas
- Andar de cima: córtex pré-frontal → lógica, empatia, controle de impulsos
- Quando criança está no andar de baixo (gritando/chorando): lógica não funciona
- Regra: "Conectar antes de Redirecionar" — valide a emoção PRIMEIRO
- Erro comum: dar explicações lógicas ou ameaças quando criança está em colapso

## 2. Harvard — Funções Executivas (O Sistema Operacional)
- Memória de Trabalho (RAM): reter instrução enquanto executa — limitada por idade
- Controle Inibitório (Firewall): pausar impulso para fazer o necessário
- Flexibilidade Cognitiva (Troca de Threads): ajustar quando a regra muda
- Desenvolvimento completo só aos 25 anos
- Erro comum: dar múltiplos comandos ao mesmo tempo → Stack Overflow
- Solução: chunking — 1 comando de cada vez, adequado à idade

## 3. Shanker — Self-Reg (Regulação de Estresse)
- Diferença crucial: Misbehavior (escolha) vs Stress Behavior (sistema sobrecarregado)
- Gatilhos de estresse: fome, cansaço, barulho, transição abrupta, mudança de rotina
- Ameaça em criança sobrecarregada = joga mais carga na CPU → piora o colapso
- Primeiro passo SEMPRE: identificar se há sobrecarga antes de qualquer técnica

## 4. Greene — CPS (Soluções Colaborativas)
- "Kids do well if they can" — se não estão se comportando, falta uma habilidade
- Lagging skill: tolerância à frustração, flexibilidade, transições
- Ameaçar por falta de habilidade = gritar com código que não compila
- CPS: após acalmar, negociar a solução COM a criança (dar 2 opções limitadas)

## Fluxo de Decisão do Lev (executar nesta ordem):
1. TRIAGEM (Shanker): É desobediência ou sobrecarga? → Se sobrecarga: reduzir estímulo, não exigir nada
2. PING DO HARDWARE (Siegel): A amígdala disparou? → Conectar/validar emoção antes de qualquer lógica
3. CHECK DE RAM (Harvard): O comando exige mais do que a idade suporta? → 1 comando, curto, simples
4. PATCH/DEPLOY (Greene): Criança calma e capaz? → Negociar execução com escolhas limitadas
`

// ─── Cenários para gerar casos ────────────────────────────────────────────────

const SCENARIOS = [
  // Lição de casa
  'criança recusa fazer lição de casa após escola',
  'criança faz lição de casa "nas coxas" sem capricho',
  'criança chora quando pai pede para fazer lição',
  'criança diz que não entendeu a lição e desiste',
  'criança procrastina a lição jogando videogame',

  // Tarefas domésticas
  'criança não guarda os brinquedos quando pedida',
  'criança deixa o quarto bagunçado repetidamente',
  'criança não ajuda a pôr a mesa quando solicitada',
  'criança abandona tarefa no meio sem terminar',

  // Transições e rotina
  'criança tem meltdown na hora de sair de casa para escola',
  'criança não quer parar de brincar para tomar banho',
  'criança resiste na hora de dormir toda noite',
  'criança tem birra ao desligar TV ou tablet',
  'criança chora ao chegar da escola sem motivo aparente',

  // Comportamento social
  'criança bate em irmão mais novo quando frustrada',
  'criança não divide brinquedos com amigos',
  'criança grita "odeio você" quando contrariada',
  'criança tem crise em supermercado querendo algo',

  // Escola e aprendizado
  'professor reclama que criança não presta atenção na aula',
  'criança diz que odeia a escola todo dia',
  'criança tem dificuldade com uma matéria específica',

  // Limites e disciplina
  'como estabelecer limite sem usar ameaças ou punições',
  'criança repete o mesmo comportamento mesmo após conversa',
  'criança desafia regras combinadas anteriormente',
  'pai se pegou gritando com filho e quer mudar',

  // Contexto específico do Celio
  'como falar de responsabilidade com filho sem soar autoritário',
  'criança faz apenas o mínimo e não tem iniciativa própria',
  'como motivar filho que parece não se importar com nada',
  'criança de 7 anos que ainda precisa ser lembrada de tudo',
  'como lidar quando pai reproduz padrão autoritário que teve',
]

// ─── Prompt do gerador ────────────────────────────────────────────────────────

function buildGeneratorPrompt(scenario: string): string {
  return `${KNOWLEDGE_BASE}

## Sua tarefa:
Gere 2 casos de treinamento no formato JSON para o cenário: "${scenario}"

Cada caso deve ser um objeto com:
- "input": pergunta ou situação que o Celio (pai) traria ao Lev
- "output": resposta ideal do Lev seguindo o fluxo de 4 passos
- "teoria_principal": qual das 4 teorias é o foco principal (siegel|harvard|shanker|greene)
- "passo_fluxo": qual passo do fluxo foi ativado (1|2|3|4)
- "tags": array com tags relevantes

Regras para o output do Lev:
- NUNCA dar solução genérica sem antes identificar o estado emocional da criança
- SEMPRE perguntar sobre contexto antes de sugerir técnica (quando necessário)
- Tom: parceiro de reflexão, não especialista autoritário
- Referenciar a teoria de forma natural, sem jargão técnico
- Máximo 4 parágrafos
- Terminar com uma pergunta ou sugestão prática

Retorne APENAS um array JSON válido com 2 objetos, sem markdown:
[
  {
    "input": "...",
    "output": "...",
    "teoria_principal": "...",
    "passo_fluxo": 1,
    "tags": ["..."]
  },
  {
    "input": "...",
    "output": "...",
    "teoria_principal": "...",
    "passo_fluxo": 2,
    "tags": ["..."]
  }
]`
}

// ─── Prompt do juiz ───────────────────────────────────────────────────────────

function buildJudgePrompt(input: string, output: string, teoriaEsperada: string, passoEsperado: number): string {
  return `Você é um avaliador de qualidade de dataset de parentalidade consciente.

Avalie este par input/output segundo os critérios abaixo.
Retorne APENAS um JSON válido, sem markdown.

Input do usuário: "${input}"
Output do Lev: "${output}"
Teoria principal esperada: ${teoriaEsperada}
Passo do fluxo esperado: ${passoEsperado}

Critérios de avaliação (0 ou 1 para cada):
1. segue_fluxo: O output seguiu a ordem correta do fluxo? (não pulou passos importantes)
2. identifica_estado: O Lev tentou identificar o estado emocional/carga da criança?
3. sem_solucao_prematura: O Lev evitou dar solução antes de entender o contexto?
4. tom_adequado: Tom de parceiro, não de especialista autoritário?
5. pratico: Termina com pergunta ou sugestão prática concreta?

Retorne:
{
  "aprovado": true ou false,
  "score": número de 0 a 5,
  "segue_fluxo": 0 ou 1,
  "identifica_estado": 0 ou 1,
  "sem_solucao_prematura": 0 ou 1,
  "tom_adequado": 0 ou 1,
  "pratico": 0 ou 1,
  "motivo_reprovacao": "string explicando por que reprovou, ou null se aprovado"
}`
}

// ─── Call OpenRouter ──────────────────────────────────────────────────────────

async function callModel(model: string, prompt: string, maxTokens = 1500): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message}`)
  return data.choices?.[0]?.message?.content ?? ''
}

// ─── Parser seguro ────────────────────────────────────────────────────────────

function parseJSON<T>(raw: string): T | null {
  try {
    const match = raw.match(/[\[\{][\s\S]*[\]\}]/)
    if (!match) return null
    return JSON.parse(match[0].replace(/[\u0000-\u001F\u007F]/g, ' ').trim())
  } catch {
    return null
  }
}

// ─── Validação de schema ──────────────────────────────────────────────────────

interface GeneratedCase {
  input: string
  output: string
  teoria_principal: string
  passo_fluxo: number
  tags: string[]
}

interface JudgeResult {
  aprovado: boolean
  score: number
  motivo_reprovacao: string | null
}

function validateSchema(item: any): item is GeneratedCase {
  return (
    typeof item?.input === 'string' && item.input.length > 10 &&
    typeof item?.output === 'string' && item.output.length > 50 &&
    ['siegel', 'harvard', 'shanker', 'greene'].includes(item?.teoria_principal) &&
    typeof item?.passo_fluxo === 'number' && item.passo_fluxo >= 1 && item.passo_fluxo <= 4 &&
    Array.isArray(item?.tags)
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧠 Dataset de Parentalidade — Geração + Validação')
  console.log(`   Modelo gerador: ${MODEL_GENERATOR}`)
  console.log(`   Modelo juiz:    ${MODEL_JUDGE}`)
  console.log(`   Cenários:       ${SCENARIOS.length}`)
  console.log(`   Casos esperados: ~${SCENARIOS.length * 2}`)
  console.log(`   Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUÇÃO'}\n`)

  const approved: GeneratedCase[] = []
  const rejected: { caso: GeneratedCase; motivo: string }[] = []
  let totalGenerated = 0
  let schemaErrors = 0

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i]
    process.stdout.write(`[${i + 1}/${SCENARIOS.length}] Gerando: "${scenario.substring(0, 50)}"...\n`)

    try {
      // 1. Gera 2 casos
      const generatorPrompt = buildGeneratorPrompt(scenario)
      const raw = await callModel(MODEL_GENERATOR, generatorPrompt, 2000)
      const cases = parseJSON<GeneratedCase[]>(raw)

      if (!cases || !Array.isArray(cases)) {
        console.log(`  ⚠️ Parse falhou para cenário "${scenario}"`)
        schemaErrors++
        continue
      }

      for (const caso of cases) {
        totalGenerated++

        // 2. Valida schema
        if (!validateSchema(caso)) {
          console.log(`  ✗ Schema inválido`)
          schemaErrors++
          continue
        }

        // 3. Juiz avalia
        const judgePrompt = buildJudgePrompt(
          caso.input, caso.output,
          caso.teoria_principal, caso.passo_fluxo
        )
        const judgeRaw = await callModel(MODEL_JUDGE, judgePrompt, 300)
        const judgeResult = parseJSON<JudgeResult>(judgeRaw)

        if (!judgeResult) {
          console.log(`  ⚠️ Juiz falhou — aprovando por padrão`)
          approved.push(caso)
          process.stdout.write(`  ✓ [schema ok, juiz falhou] ${caso.teoria_principal} p${caso.passo_fluxo}\n`)
          continue
        }

        if (judgeResult.aprovado && judgeResult.score >= 3) {
          approved.push(caso)
          process.stdout.write(`  ✓ [score:${judgeResult.score}/5] ${caso.teoria_principal} p${caso.passo_fluxo}\n`)
        } else {
          rejected.push({ caso, motivo: judgeResult.motivo_reprovacao ?? 'score baixo' })
          process.stdout.write(`  ✗ [score:${judgeResult.score}/5] ${judgeResult.motivo_reprovacao ?? 'reprovado'}\n`)
        }

        // Pausa para não estourar rate limit
        await new Promise(r => setTimeout(r, 300))
      }

    } catch (err: any) {
      console.error(`  ❌ Erro no cenário "${scenario}":`, err.message)
    }
  }

  // ─── Relatório ──────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════')
  console.log('  RELATÓRIO DE GERAÇÃO')
  console.log('══════════════════════════════════════════════')
  console.log(`  Cenários processados: ${SCENARIOS.length}`)
  console.log(`  Casos gerados:        ${totalGenerated}`)
  console.log(`  ✅ Aprovados:          ${approved.length}`)
  console.log(`  ✗  Reprovados:         ${rejected.length}`)
  console.log(`  ⚠️  Erros de schema:   ${schemaErrors}`)
  console.log(`  Taxa de aprovação:    ${((approved.length / totalGenerated) * 100).toFixed(1)}%`)

  // Distribuição por teoria
  const byTheory: Record<string, number> = {}
  for (const c of approved) {
    byTheory[c.teoria_principal] = (byTheory[c.teoria_principal] ?? 0) + 1
  }
  console.log('\n  Distribuição por teoria:')
  for (const [teoria, count] of Object.entries(byTheory)) {
    const bar = '█'.repeat(Math.round(count / approved.length * 20))
    console.log(`    ${teoria.padEnd(10)} ${bar} ${count}`)
  }

  // Distribuição por passo
  const byStep: Record<number, number> = {}
  for (const c of approved) {
    byStep[c.passo_fluxo] = (byStep[c.passo_fluxo] ?? 0) + 1
  }
  console.log('\n  Distribuição por passo do fluxo:')
  for (const [step, count] of Object.entries(byStep)) {
    console.log(`    Passo ${step}: ${count} casos`)
  }

  if (rejected.length > 0) {
    console.log('\n  Motivos de reprovação mais comuns:')
    const motivos = rejected.map(r => r.motivo).slice(0, 5)
    motivos.forEach((m, i) => console.log(`    ${i + 1}. ${m}`))
  }

  // ─── Salva ──────────────────────────────────────────────────────────────────

  if (!DRY_RUN && approved.length > 0) {
    const jsonl = approved
      .map(c => JSON.stringify({
        input: c.input,
        output: c.output,
        teoria_principal: c.teoria_principal,
        passo_fluxo: c.passo_fluxo,
        tags: c.tags,
        domain: 'parentalidade',
      }))
      .join('\n')

    fs.writeFileSync(OUTPUT_PATH, jsonl, 'utf-8')
    console.log(`\n✅ Dataset salvo em: ${OUTPUT_PATH}`)
    console.log(`   ${approved.length} casos prontos para injetar no RAG`)
  } else if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — nada foi salvo.')
    console.log('\nPrimeiros 2 casos aprovados:')
    approved.slice(0, 2).forEach((c, i) => {
      console.log(`\n--- Caso ${i + 1} ---`)
      console.log(`Input:  ${c.input}`)
      console.log(`Output: ${c.output.substring(0, 200)}...`)
      console.log(`Teoria: ${c.teoria_principal} | Passo: ${c.passo_fluxo}`)
    })
  }
}

main().catch(console.error)
