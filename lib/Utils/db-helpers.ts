// lib/utils/db-helpers.ts
import { supabase } from '@/lib/jarvis';
// AQUI: Importe o seu invalidador de cache do novo serviço centralizado
import { invalidateContextField } from '@/lib/services/context-cache'; 

// ── TIPAGENS ─────────────────────────────────────────────────────────

export interface EventPayload {
  title: string;
  event_date: string;
  category: string;
  priority: string;
  decay_type: string;
  emotional_weight: number;
  is_recurring?: boolean;
  notes?: string | null;
}

export interface PersonOptions {
  nickname?: string;
  weightDelta?: number;
  noteText?: string;
}

const INITIAL_WEIGHTS: Record<string, number> = {
  spouse: 1.0, child: 0.9, parent: 0.7, sibling: 0.4, friend: 0.3, colleague: 0.2, ex: 0.1, other: 0.1,
};

// ── FORMATADORES (Puros) ─────────────────────────────────────────────
// (Mantidos idênticos - Estão perfeitos)

export function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const months: Record<string, string> = {
    janeiro: '01', fevereiro: '02', marco: '03', abril: '04',
    maio: '05', junho: '06', julho: '07', agosto: '08',
    setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
  };
  const currentYear = new Date().getFullYear();

  const ptMatch = raw.match(/(\d{1,2})\s+de?\s+(\w+)(\s+de?\s+(\d{4}))?/i);
  if (ptMatch) {
    const mon = months[ptMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    const year = ptMatch[4] || String(currentYear);
    if (mon) return `${year}-${mon}-${ptMatch[1].padStart(2, '0')}`;
  }

  const parts = raw.split(/[-/]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    if (c.length === 4) return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (c.length === 2) return `20${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }
  if (parts.length === 2) {
    return `${currentYear}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return raw;
}

export function getLifePhase(age: number | null): string {
  if (age === null || age === undefined || age < 0) return 'child';
  if (age < 3) return 'baby';
  if (age <= 11) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 24) return 'young_adult';
  return 'adult';
}

export function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo)) return 'school';
  if (/medic|saude/.test(tipo)) return 'health';
  if (/trabalho|projeto/.test(tipo)) return 'work';
  if (/aniversario|familiar/.test(tipo)) return 'family';
  return 'personal';
}

// ── BANCO DE DADOS (Shared Helpers c/ Regra 2) ────────────────────────

export async function upsertAlias(
  userId: string, alias: string, type: string,
  referId: string | null, referName: string | null
): Promise<void> {
  const { error } = await supabase.from('contact_aliases').upsert({
    user_id: userId,
    alias: alias.toLowerCase().trim(),
    refers_to_type: type,
    refers_to_id: referId,
    refers_to_name: referName,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,alias' });

  // Invalida o contexto de 'persons' pois os aliases mapeiam para eles
  if (!error) {
    invalidateContextField(Number(userId), 'persons').catch(console.error);
  }
}

export async function upsertPerson(
  userId: string, 
  name: string, 
  type: string, 
  options?: PersonOptions,
  masterContext?: any // Adicionado para evitar I/O
): Promise<string | null> {
  try {
    const baseWeight = INITIAL_WEIGHTS[type] ?? 0.1;
    
    // 1. TENTA BUSCAR NO CONTEXTO (Zero I/O)
    const existing = masterContext?.persons?.find(
      (p: any) => p.name.toLowerCase() === name.toLowerCase() && p.type === type
    );

    let personId: string;

    if (existing) {
      // 2. ATUALIZAÇÃO DIRETA (Escrita atômica)
      const delta = options?.weightDelta ?? 0.02;
      const newWeight = Math.min(1.0, existing.emotional_weight + delta);
      await supabase.from('persons').update({
        emotional_weight: newWeight, 
        last_mentioned: new Date().toISOString(), 
        updated_at: new Date().toISOString(),
        ...(options?.nickname && !existing.nickname ? { nickname: options.nickname } : {}),
      }).eq('id', existing.id);
      personId = existing.id;
    } else {
      // 3. INSERÇÃO (Caminho padrão)
      const { data: created, error: insertError } = await supabase.from('persons').insert({
        user_id: userId, 
        name, 
        type, 
        emotional_weight: baseWeight, 
        nickname: options?.nickname ?? null, 
        last_mentioned: new Date().toISOString(),
      }).select('id').single();
      
      if (insertError) throw insertError;
      personId = created?.id;
    }

    // [Manutenção dos detalhes originais do seu código]
    if (options?.noteText && personId) {
      await supabase.from('person_notes').upsert({
        user_id: userId, person_name: name, person_type: type, person_id: personId, note: options.noteText, noted_at: new Date().toISOString().slice(0, 10),
      }, { onConflict: 'user_id,person_name,note,noted_at', ignoreDuplicates: true });
    }

    // REGRA 2: Invalidação de Cache (Mantida intacta)
    await invalidateContextField(Number(userId), 'persons').catch(console.error);
    
    return personId ?? null;
    
  } catch (e) { 
    console.error('[upsertPerson] Erro:', e); 
    return null; 
  }
}


export async function upsertEvent(userId: string, ev: EventPayload): Promise<void> {
  const norm = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  const mmdd = ev.event_date.slice(5);

  // * ALERTA DE RIGOR TÉCNICO: Se 'start_at' for tipo timestamp no Postgres, 
  // fazer um .like() nele pode falhar silenciosamente no Supabase.
  const { data: candidates } = await supabase.from('events')
    .select('id, title, priority, emotional_weight, notes, decay_type, is_recurring')
    .eq('user_id', userId).like('start_at', `%-${mmdd}`);

  const ex = (candidates || []).find((c: any) => norm(c.title) === norm(ev.title));

  let error;
  if (ex?.id) {
    ({ error } = await supabase.from('events').update({
      title: ev.title, priority: ev.priority, emotional_weight: ev.emotional_weight, notes: ev.notes,
    }).eq('id', ex.id));
  } else {
    ({ error } = await supabase.from('events').insert({
      user_id: userId, title: ev.title, start_at: ev.event_date, category: ev.category, priority: ev.priority,
      decay_type: ev.decay_type, emotional_weight: ev.emotional_weight, is_recurring: ev.is_recurring, notes: ev.notes, relevance_score: 1.0,
    }));
  }

  // REGRA 2: Invalida o cache
  if (!error) {
    await invalidateContextField(Number(userId), 'events').catch(console.error);
  }
}
