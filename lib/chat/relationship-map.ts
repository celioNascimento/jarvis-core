// lib/chat/relationship-map.ts
// Mapa canônico: rótulo em português → relationship_type (inglês) + metadados

export type RelationshipType =
  | 'spouse' | 'partner' | 'parent' | 'child'
  | 'sibling' | 'friend' | 'colleague' | 'other';

interface RelationshipMeta {
  type: RelationshipType;
  inverse: RelationshipType;        // tipo do outro lado
  defaultPrivacyLevel: number;      // 1-5
  defaultIntensity: number;         // 0-1
  minorLocationRequired: boolean;   // localização obrigatória se menor de idade
}

const MAP: Record<string, RelationshipMeta> = {
  // ── Cônjuge / Parceiro ───────────────────────────────────────────────────
  'conjuge':        { type: 'spouse',   inverse: 'spouse',   defaultPrivacyLevel: 5, defaultIntensity: 0.95, minorLocationRequired: false },
  'esposo':         { type: 'spouse',   inverse: 'spouse',   defaultPrivacyLevel: 5, defaultIntensity: 0.95, minorLocationRequired: false },
  'esposa':         { type: 'spouse',   inverse: 'spouse',   defaultPrivacyLevel: 5, defaultIntensity: 0.95, minorLocationRequired: false },
  'marido':         { type: 'spouse',   inverse: 'spouse',   defaultPrivacyLevel: 5, defaultIntensity: 0.95, minorLocationRequired: false },
  'noivo':          { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },
  'noiva':          { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },
  'namorado':       { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },
  'namorada':       { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },
  'companheiro':    { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },
  'companheira':    { type: 'partner',  inverse: 'partner',  defaultPrivacyLevel: 4, defaultIntensity: 0.80, minorLocationRequired: false },

  // ── Pai / Mãe ────────────────────────────────────────────────────────────
  'pai':            { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 4, defaultIntensity: 0.90, minorLocationRequired: true },
  'mae':            { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 4, defaultIntensity: 0.90, minorLocationRequired: true },
  'padrasto':       { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: true },
  'madrasta':       { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: true },
  'avo':            { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 3, defaultIntensity: 0.75, minorLocationRequired: false },
  'avoa':           { type: 'parent',   inverse: 'child',    defaultPrivacyLevel: 3, defaultIntensity: 0.75, minorLocationRequired: false },

  // ── Filho / Filha ─────────────────────────────────────────────────────────
  'filho':          { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 4, defaultIntensity: 0.90, minorLocationRequired: false },
  'filha':          { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 4, defaultIntensity: 0.90, minorLocationRequired: false },
  'enteado':        { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: false },
  'enteada':        { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: false },
  'neto':           { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 3, defaultIntensity: 0.75, minorLocationRequired: false },
  'neta':           { type: 'child',    inverse: 'parent',   defaultPrivacyLevel: 3, defaultIntensity: 0.75, minorLocationRequired: false },

  // ── Irmão / Irmã ─────────────────────────────────────────────────────────
  'irmao':          { type: 'sibling',  inverse: 'sibling',  defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: false },
  'irma':           { type: 'sibling',  inverse: 'sibling',  defaultPrivacyLevel: 3, defaultIntensity: 0.70, minorLocationRequired: false },
  'meio-irmao':     { type: 'sibling',  inverse: 'sibling',  defaultPrivacyLevel: 2, defaultIntensity: 0.50, minorLocationRequired: false },
  'meio-irma':      { type: 'sibling',  inverse: 'sibling',  defaultPrivacyLevel: 2, defaultIntensity: 0.50, minorLocationRequired: false },

  // ── Amigo ─────────────────────────────────────────────────────────────────
  'amigo_proximo':  { type: 'friend',   inverse: 'friend',   defaultPrivacyLevel: 3, defaultIntensity: 0.60, minorLocationRequired: false },
  'amigo':          { type: 'friend',   inverse: 'friend',   defaultPrivacyLevel: 2, defaultIntensity: 0.40, minorLocationRequired: false },
  'amiga':          { type: 'friend',   inverse: 'friend',   defaultPrivacyLevel: 2, defaultIntensity: 0.40, minorLocationRequired: false },
  'melhor_amigo':   { type: 'friend',   inverse: 'friend',   defaultPrivacyLevel: 3, defaultIntensity: 0.65, minorLocationRequired: false },
  'melhor_amiga':   { type: 'friend',   inverse: 'friend',   defaultPrivacyLevel: 3, defaultIntensity: 0.65, minorLocationRequired: false },

  // ── Colega / Conhecido ────────────────────────────────────────────────────
  'colega':         { type: 'colleague', inverse: 'colleague', defaultPrivacyLevel: 1, defaultIntensity: 0.25, minorLocationRequired: false },
  'chefe':          { type: 'colleague', inverse: 'colleague', defaultPrivacyLevel: 1, defaultIntensity: 0.20, minorLocationRequired: false },
  'funcionario':    { type: 'colleague', inverse: 'colleague', defaultPrivacyLevel: 1, defaultIntensity: 0.20, minorLocationRequired: false },
  'conhecido':      { type: 'other',    inverse: 'other',    defaultPrivacyLevel: 1, defaultIntensity: 0.10, minorLocationRequired: false },
};

// ── Funções públicas ─────────────────────────────────────────────────────────

/**
 * Normaliza um rótulo em português para lookup no mapa.
 * Remove acentos, espaços → underscore, lowercase.
 */
function normalize(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

/**
 * Resolve o relationship_type canônico a partir do rótulo em português.
 * Ex: "cônjuge" → "spouse"
 */
export function resolveRelationshipType(label: string): RelationshipMeta | null {
  return MAP[normalize(label)] ?? null;
}

/**
 * Resolve o relationship_type canônico a partir do par (type_a, type_b).
 * Ex: ("pai", "filho") → "parent"
 * Usa type_a como referência — type_a é quem está criando o relacionamento.
 */
export function resolveCanonicalType(typeA: string, typeB: string): RelationshipType {
  const metaA = resolveRelationshipType(typeA);
  if (metaA) return metaA.type;

  const metaB = resolveRelationshipType(typeB);
  if (metaB) return metaB.inverse;

  return 'other';
}

/**
 * Retorna os metadados completos para uso na criação do relacionamento.
 */
export function getRelationshipDefaults(typeA: string): {
  relationshipType: RelationshipType;
  inverseType: RelationshipType;
  privacyLevel: number;
  intensity: number;
  minorLocationRequired: boolean;
} {
  const meta = resolveRelationshipType(typeA);
  return {
    relationshipType:      meta?.type                  ?? 'other',
    inverseType:           meta?.inverse               ?? 'other',
    privacyLevel:          meta?.defaultPrivacyLevel   ?? 2,
    intensity:             meta?.defaultIntensity      ?? 0.30,
    minorLocationRequired: meta?.minorLocationRequired ?? false,
  };
}