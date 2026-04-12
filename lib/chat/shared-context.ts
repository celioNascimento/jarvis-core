// lib/chat/shared-context.ts
// Busca dados compartilhados de relacionamentos e monta bloco para o prompt.
//
// Prioridade de relacionamentos: spouse > partner > parent/child > sibling > friend
// Recursos por contexto detectado:
//   familia    → children, memories_shared, calendar
//   compras    → finances
//   agenda     → calendar
//   saude      → health
//   filhos     → children
//   emocao     → memories_shared
//   localizacao→ location
//
// Birthday:
//   - Sempre verificado para TODOS os relacionamentos ativos
//   - Janela de antecedência varia por tipo:
//       spouse/partner → 60 dias
//       parent/child   → 30 dias
//       sibling/friend → 14 dias
//   - Fonte primária: get_shared_data RPC (usuário no sistema)
//   - Fonte secundária: relationships.contact_birthday (contato externo)

import { supabase } from '@/lib/jarvis';
import type { ContextType } from '@/lib/chat/context-classifier';

// ── Tipos ─────────────────────────────────────────────────────

interface SharedRelationship {
  relationshipId: string;
  partnerId: string;
  partnerName: string;
  relationshipType: string; // 'spouse' | 'partner' | 'parent' | 'child' | 'sibling' | 'friend'
  priority: number;         // menor = mais importante
  contactBirthday: string | null; // fallback para contatos externos (date ISO)
  isExternal: boolean;
}

interface SharedContextResult {
  block: string;            // texto pronto para injetar no prompt
  hasData: boolean;
}

// ── Constantes ────────────────────────────────────────────────

const RELATIONSHIP_PRIORITY: Record<string, number> = {
  spouse:  1,
  partner: 2,
  parent:  3,
  child:   3,
  sibling: 4,
  friend:  5,
  other:   6,
};

// Mapa: contexto detectado → recursos a buscar
const CONTEXT_RESOURCE_MAP: Record<string, string[]> = {
  familia:     ['children', 'memories_shared', 'calendar'],
  filhos:      ['children'],
  compras:     ['finances'],
  financas:    ['finances'],
  agenda:      ['calendar'],
  evento:      ['calendar'],
  saude:       ['health'],
  emocao:      ['memories_shared'],
  localizacao: ['location'],
  trabalho:    ['calendar'],
  meta:        ['memories_shared'],
  projeto:     ['memories_shared'],
};

// Recursos que só fazem sentido para cônjuge/parceiro
const SPOUSE_ONLY_RESOURCES = new Set(['finances', 'health', 'location']);

// Janela de antecedência para aniversários por tipo de relacionamento (dias)
const BIRTHDAY_WINDOW_DAYS: Record<string, number> = {
  spouse:  60,
  partner: 60,
  parent:  30,
  child:   30,
  sibling: 14,
  friend:  14,
  other:   7,
};

// ── Função principal ──────────────────────────────────────────

export async function buildSharedContextBlock(
  viewerId: string,           // auth_user_id (text) do usuário logado
  numericViewerId: string,    // jarvis.users.id (bigint como string)
  detectedContexts: ContextType[],
  authorName: string,
): Promise<SharedContextResult> {

  try {
    // 1. Busca relacionamentos ativos do usuário
    const relationships = await getActiveRelationships(numericViewerId);
    if (relationships.length === 0) {
      return { block: '', hasData: false };
    }

    // 2. Bloco de aniversários — verificado para TODOS os relacionamentos,
    //    independente de contexto detectado
    const birthdayLines = await buildBirthdayBlock(numericViewerId, relationships);

    // 3. Decide quais recursos buscar com base nos contextos
    const resourcesToFetch = resolveResources(detectedContexts);

    // 4. Para cada relacionamento (em ordem de prioridade), busca recursos permitidos
    const contextBlocks: string[] = [];

    for (const rel of relationships) {
      const relResources = filterResourcesByRelationship(resourcesToFetch, rel.relationshipType);
      if (relResources.length === 0) continue;

      const relBlocks: string[] = [];

      for (const resource of relResources) {
        const data = await fetchSharedResource(numericViewerId, rel.partnerId, resource);
        if (data) relBlocks.push(data);
      }

      if (relBlocks.length > 0) {
        const label = formatRelLabel(rel.relationshipType, rel.partnerName);
        contextBlocks.push(`${label}\n${relBlocks.join('\n')}`);
      }
    }

    const hasData = birthdayLines.length > 0 || contextBlocks.length > 0;
    if (!hasData) return { block: '', hasData: false };

    const parts: string[] = [];
    if (birthdayLines.length > 0) {
      parts.push(`[ANIVERSÁRIOS PRÓXIMOS]\n${birthdayLines.join('\n')}`);
    }
    if (contextBlocks.length > 0) {
      parts.push(`[CONTEXTO COMPARTILHADO]\n${contextBlocks.join('\n\n')}`);
    }

    return { block: parts.join('\n\n'), hasData: true };

  } catch (e) {
    console.error('[SharedContext] Erro:', e);
    return { block: '', hasData: false };
  }
}

// ── Helpers internos ──────────────────────────────────────────

async function getActiveRelationships(numericUserId: string): Promise<SharedRelationship[]> {
  const { data, error } = await supabase
    .from('relationships')
    .select('id, user_id_a, user_id_b, relationship_type, contact_name, contact_birthday, is_external')
    .eq('status', 'active')
    .or(`user_id_a.eq.${numericUserId},user_id_b.eq.${numericUserId}`);

  if (error || !data) return [];

  return data
    .map((r): SharedRelationship => {
      const isA = r.user_id_a === numericUserId;
      const partnerId = isA ? r.user_id_b : r.user_id_a;
      const type = r.relationship_type ?? 'other';
      return {
        relationshipId: r.id,
        partnerId,
        partnerName: r.contact_name || 'Contato',
        relationshipType: type,
        priority: RELATIONSHIP_PRIORITY[type] ?? 6,
        contactBirthday: r.contact_birthday ?? null,   // fallback para externos
        isExternal: r.is_external ?? false,
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

function resolveResources(contexts: ContextType[]): Set<string> {
  const resources = new Set<string>();
  // birthday é tratado separadamente em buildBirthdayBlock — não entra aqui
  for (const ctx of contexts) {
    const mapped = CONTEXT_RESOURCE_MAP[ctx as string];
    if (mapped) mapped.forEach(r => resources.add(r));
  }
  return resources;
}

// Verifica aniversários para todos os relacionamentos ativos.
// Usa RPC para usuários no sistema; contact_birthday como fallback para externos.
async function buildBirthdayBlock(
  viewerId: string,
  relationships: SharedRelationship[],
): Promise<string[]> {
  const lines: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const rel of relationships) {
    const window = BIRTHDAY_WINDOW_DAYS[rel.relationshipType] ?? 7;
    let birthDate: Date | null = null;
    let label = '';

    if (!rel.isExternal) {
      // Tenta via RPC (usuário no sistema)
      try {
        const { data } = await supabase.rpc('get_shared_data', {
          p_viewer_id: viewerId,
          p_owner_id:  rel.partnerId,
          p_resource:  'birthday',
        });
        if (data?.ok && data.data?.birth_date && !data.data?.hidden) {
          birthDate = new Date(data.data.birth_date);
          label = data.data.full_name || rel.partnerName;
        }
      } catch { /* fallthrough para contact_birthday */ }
    }

    // Fallback: contact_birthday gravado direto em relationships
    if (!birthDate && rel.contactBirthday) {
      birthDate = new Date(rel.contactBirthday);
      label = rel.partnerName;
    }

    if (!birthDate) continue;

    // Calcula próximo aniversário
    const next = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
    if (next < today) next.setFullYear(today.getFullYear() + 1);
    const daysUntil = Math.ceil((next.getTime() - today.getTime()) / 86400000);

    if (daysUntil > window) continue;

    const relLabel = formatRelLabelShort(rel.relationshipType);
    const dateStr = birthDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const age = next.getFullYear() - birthDate.getFullYear();

    if (daysUntil === 0) {
      lines.push(`🎂 HOJE é aniversário de ${label} (${relLabel}, ${age} anos)`);
    } else if (daysUntil === 1) {
      lines.push(`🎂 AMANHÃ é aniversário de ${label} (${relLabel}, ${age} anos em ${dateStr})`);
    } else {
      lines.push(`🎂 ${label} (${relLabel}) faz aniversário em ${daysUntil} dias — ${dateStr}`);
    }
  }

  // Ordena: hoje primeiro, depois por proximidade
  return lines;
}

function filterResourcesByRelationship(resources: Set<string>, relType: string): string[] {
  const isSpouseOrPartner = relType === 'spouse' || relType === 'partner';

  return Array.from(resources).filter(r => {
    if (SPOUSE_ONLY_RESOURCES.has(r) && !isSpouseOrPartner) return false;
    return true;
  });
}

async function fetchSharedResource(
  viewerId: string,
  ownerId: string,
  resource: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('get_shared_data', {
      p_viewer_id: viewerId,
      p_owner_id:  ownerId,
      p_resource:  resource,
    });

    if (error) {
      console.warn(`[SharedContext] RPC erro (${resource}):`, error.message);
      return null;
    }

    if (!data?.ok) return null;

    return formatResource(resource, data);
  } catch (e) {
    console.error(`[SharedContext] fetchSharedResource (${resource}):`, e);
    return null;
  }
}

function formatResource(resource: string, data: any): string | null {
  switch (resource) {

    case 'calendar': {
      const items = data.data as any[];
      if (!items?.length) return null;
      const visible = items.filter(i => !i.hidden);
      const hidden  = items.filter(i => i.hidden).length;
      if (!visible.length) return null;
      const lines = visible
        .slice(0, 5)
        .map(i => `  - ${new Date(i.event_at).toLocaleDateString('pt-BR')}: ${i.description}${i.category ? ` [${i.category}]` : ''}`);
      const suffix = hidden > 0 ? `\n  (+ ${hidden} evento(s) privado(s))` : '';
      return `📅 Agenda próxima:\n${lines.join('\n')}${suffix}`;
    }

    case 'finances': {
      const items = data.data as any[];
      if (!items?.length) return null;
      const visible = items.filter(i => !i.hidden).slice(0, 5);
      if (!visible.length) return null;
      const lines = visible.map(i =>
        `  - ${i.transaction_date}: ${i.description || i.merchant || '—'} (R$ ${Number(i.amount).toFixed(2)}, ${i.type})`
      );
      return `💰 Transações recentes:\n${lines.join('\n')}`;
    }

    case 'children': {
      const items = data.data as any[];
      if (!items?.length) return null;
      const visible = items.filter(i => !i.hidden);
      if (!visible.length) return null;
      const lines = visible.map(i =>
        `  - ${i.nickname || i.name}${i.life_phase ? ` (${i.life_phase})` : ''}${i.school_name ? `, escola: ${i.school_name}` : ''}`
      );
      return `👶 Filhos:\n${lines.join('\n')}`;
    }

    case 'memories_shared': {
      const items = data.data as any[];
      if (!items?.length) return null;
      const visible = items.filter(i => !i.hidden).slice(0, 3);
      if (!visible.length) return null;
      const lines = visible.map(i => `  - ${i.summary}`);
      return `🧠 Memórias compartilhadas:\n${lines.join('\n')}`;
    }

    case 'location': {
      const loc = data.data;
      if (!loc || loc.hidden) return null;
      if (!loc.city) return null;
      return `📍 Localização: ${loc.city}, ${loc.state}`;
    }

    case 'health': {
      const h = data.data;
      if (!h || h.hidden) return null;
      if (data.note === 'no_dedicated_table') return null;
      return null;
    }

    default:
      return null;
  }
}

function formatRelLabel(type: string, name: string): string {
  const labels: Record<string, string> = {
    spouse:  `👫 ${name} (cônjuge)`,
    partner: `💑 ${name} (parceiro/a)`,
    parent:  `👨‍👩‍👧 ${name} (pai/mãe)`,
    child:   `👶 ${name} (filho/a)`,
    sibling: `🤝 ${name} (irmão/ã)`,
    friend:  `👥 ${name} (amigo/a)`,
  };
  return labels[type] ?? `🔗 ${name}`;
}

function formatRelLabelShort(type: string): string {
  const labels: Record<string, string> = {
    spouse:  'cônjuge',
    partner: 'parceiro/a',
    parent:  'pai/mãe',
    child:   'filho/a',
    sibling: 'irmão/ã',
    friend:  'amigo/a',
    other:   'contato',
  };
  return labels[type] ?? 'contato';
}