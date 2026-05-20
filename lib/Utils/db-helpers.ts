// lib/utils/db-helpers.ts
import { supabase } from '@/lib/jarvis';

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

// ── BANCO DE DADOS (Shared Helpers) ──────────────────────────────────

export async function upsertAlias(
  userId: string, alias: string, type: string,
  referId: string | null, referName: string | null
): Promise<void> {
  await supabase.from('contact_aliases').upsert({
    user_id: userId,
    alias: alias.toLowerCase().trim(),
    refers_to_type: type,
    refers_to_id: referId,
    refers_to_name: referName,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,alias' });
}

export async function upsertPerson(
  userId: string, name: string, type: string, options?: PersonOptions
): Promise<string | null> {
  try {
    const baseWeight = INITIAL_WEIGHTS[type] ?? 0.1;
    const { data: existing } = await supabase.from('persons')
      .select('id, emotional_weight, nickname')
      .eq('user_id', userId).eq('name', name).eq('type', type).maybeSingle();

    let personId: string;

    if (existing) {
      const delta = options?.weightDelta ?? 0.02;
      const newWeight = Math.min(1.0, existing.emotional_weight + delta);
      await supabase.from('persons').update({
        emotional_weight: newWeight, last_mentioned: new Date().toISOString(), updated_at: new Date().toISOString(),
        ...(options?.nickname && !existing.nickname ? { nickname: options.nickname } : {}),
      }).eq('id', existing.id);
      personId = existing.id;
    } else {
      const { data: created } = await supabase.from('persons').insert({
        user_id: userId, name, type, emotional_weight: baseWeight, nickname: options?.nickname ?? null, last_mentioned: new Date().toISOString(),
      }).select('id').single();
      personId = created?.id;
    }

    if (options?.noteText && personId) {
      await supabase.from('person_notes').upsert({
        user_id: userId, person_name: name, person_type: type, person_id: personId, note: options.noteText, noted_at: new Date().toISOString().slice(0, 10),
      }, { onConflict: 'user_id,person_name,note,noted_at', ignoreDuplicates: true });
    }
    return personId ?? null;
  } catch (e) { console.error('[upsertPerson] Erro:', e); return null; }
}

export async function upsertEvent(userId: string, ev: EventPayload): Promise<void> {
  // Simplificado para o helper (A lógica complexa de deduplicação estava aqui, mantive o core de insert/update)
  const norm = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  const mmdd = ev.event_date.slice(5);

  const { data: candidates } = await supabase.from('events')
    .select('id, title, priority, emotional_weight, notes, decay_type, is_recurring')
    .eq('user_id', userId).like('start_at', `%-${mmdd}`);

  const ex = (candidates || []).find((c: any) => norm(c.title) === norm(ev.title));

  if (ex?.id) {
    await supabase.from('events').update({
      title: ev.title, priority: ev.priority, emotional_weight: ev.emotional_weight, notes: ev.notes,
    }).eq('id', ex.id);
  } else {
    await supabase.from('events').insert({
      user_id: userId, title: ev.title, start_at: ev.event_date, category: ev.category, priority: ev.priority,
      decay_type: ev.decay_type, emotional_weight: ev.emotional_weight, is_recurring: ev.is_recurring, notes: ev.notes, relevance_score: 1.0,
    });
  }
}