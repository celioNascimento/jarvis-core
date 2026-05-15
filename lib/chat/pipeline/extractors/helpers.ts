// lib/chat/pipeline/extractors/helpers.ts

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

export function getCategoryFromType(tipo: string): string {
  if (/escola|escolar/.test(tipo)) return 'school';
  if (/medic|saude/.test(tipo)) return 'health';
  if (/trabalho|projeto/.test(tipo)) return 'work';
  if (/aniversario|familiar/.test(tipo)) return 'family';
  return 'personal';
}

export function mapCategoriaToCategory(cat: string | null): string {
  const map: Record<string, string> = {
    'Saúde':    'health',
    'Trabalho': 'work',
    'Escola':   'school',
    'Família':  'family',
    'Pessoal':  'personal',
    'Rotina':   'personal',
  };
  return map[cat ?? ''] ?? 'personal';
}