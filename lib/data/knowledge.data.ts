// lib/data/knowledge.data.ts
//
// Busca conhecimento curado por domínio para enriquecer respostas do Lev.
// Separado das memórias pessoais (memories.data.ts) — aqui é conhecimento
// especializado que serve para qualquer usuário, não memória individual.

import { supabase, generateEmbedding } from '@/lib/jarvis'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface KnowledgeRecord {
  id: number
  input_exemplo: string
  output_ideal: string
  teoria_principal: string | null
  passo_fluxo: number | null
  tags: string[]
  similarity: number
}

export interface KnowledgeLoadResult {
  records: KnowledgeRecord[]
  domain: string
}

// ─── Detector de domínio ──────────────────────────────────────────────────────

const DOMAIN_PATTERNS: Record<string, RegExp> = {
  parentalidade: /\b(filho|filha|criança|criancas|crianças|miguel|birra|lição de casa|escola|dever|brinquedo|bagunça|colégio|prof|professora|pedagog|educaç|disciplina|comportamento|castigo|adolescente|bebê|bebe|criança|kids|infantil|filho|filha|meu filho|minha filha)\b/i,
  // Futuros domínios podem ser adicionados aqui:
  // saude: /\b(médico|remédio|sintoma|dor|consulta|exame)\b/i,
  // financas: /\b(investimento|carteira|ações|renda|dividendo)\b/i,
}

export function detectKnowledgeDomain(message: string): string | null {
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (pattern.test(message)) return domain
  }
  return null
}

// ─── Loader principal ─────────────────────────────────────────────────────────

/**
 * Busca conhecimento especializado relevante para a mensagem atual.
 * Só é chamado quando um domínio específico é detectado na mensagem.
 *
 * @param domain  Domínio detectado ('parentalidade', etc)
 * @param message Mensagem do usuário (usada como query semântica)
 * @param limit   Máximo de registros (default: 2 — evita poluir o prompt)
 */
export async function loadKnowledgeForDomain(
  domain: string,
  message: string,
  limit = 2,
): Promise<KnowledgeLoadResult> {
  try {
    const embedding = await generateEmbedding(message)

    if (!embedding) {
      console.warn('[knowledge.data] Embedding null — abortando busca de conhecimento.')
      return { records: [], domain }
    }

    const { data, error } = await supabase.rpc('get_knowledge_for_domain', {
      p_domain:    domain,
      p_query:     embedding,
      p_limit:     limit,
      p_min_score: 0.5,
    })

    if (error) {
      console.error('[knowledge.data] RPC falhou:', error.message)
      return { records: [], domain }
    }

    if (!Array.isArray(data) || data.length === 0) {
      return { records: [], domain }
    }

    const records: KnowledgeRecord[] = data.map((row: any) => ({
      id:               row.id,
      input_exemplo:    row.input_exemplo,
      output_ideal:     row.output_ideal,
      teoria_principal: row.teoria_principal ?? null,
      passo_fluxo:      row.passo_fluxo ?? null,
      tags:             row.tags ?? [],
      similarity:       row.similarity ?? 0,
    }))

    console.log(`[knowledge.data] ${records.length} registros de '${domain}' encontrados (top similarity: ${records[0]?.similarity.toFixed(2)})`)

    return { records, domain }

  } catch (err) {
    console.error('[knowledge.data] Erro inesperado:', err)
    return { records: [], domain }
  }
}