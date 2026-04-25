// lib/finances/broker-parser.ts
// Parser de notificações de corretoras brasileiras
// Extrai eventos de investimento: dividendo, JCP, rendimento, compra, venda

export interface ParsedBrokerEvent {
  event_type: 'dividendo' | 'jcp' | 'rendimento' | 'compra' | 'venda' | 'resgate' | 'amortizacao' | 'outro';
  ticker: string | null;
  asset_name: string | null;
  gross_amount: number | null;
  ir_amount: number | null;
  net_amount: number | null;
  broker: string | null;
  confidence: number;
  raw_text: string;
}

function parseAmountBR(str: string): number | null {
  if (!str) return null;
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) || val <= 0 ? null : val;
}

// ─── Padrões por corretora ────────────────────────────────────
const BROKER_PATTERNS: Array<{
  broker: string;
  patterns: Array<{
    regex: RegExp;
    event_type: ParsedBrokerEvent['event_type'];
    extractAmount: (m: RegExpMatchArray) => number | null;
    extractTicker: (m: RegExpMatchArray) => string | null;
    extractIR: (m: RegExpMatchArray) => number | null;
    confidence: number;
  }>;
}> = [
  {
    broker: 'Clear',
    patterns: [
      {
        regex: /Dividendos?\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.92,
      },
      {
        regex: /JCP\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'jcp',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.92,
      },
      {
        regex: /Rendimento\s+(?:de\s+)?(.+?)[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'rendimento',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => null,
        extractIR: () => null,
        confidence: 0.85,
      },
      {
        regex: /Provento\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)\s+creditado[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.90,
      },
      {
        regex: /Compra\s+(?:de\s+)?(\d+)\s+([A-Z]{4}\d{1,2}[A-Z]?)\s+a\s+R\$\s*([\d.,]+)/i,
        event_type: 'compra',
        extractAmount: m => {
          const qty = parseFloat(m[1]);
          const price = parseAmountBR(m[3]);
          return price && qty ? qty * price : null;
        },
        extractTicker: m => m[2].toUpperCase(),
        extractIR: () => null,
        confidence: 0.88,
      },
      {
        regex: /Venda\s+(?:de\s+)?(\d+)\s+([A-Z]{4}\d{1,2}[A-Z]?)\s+a\s+R\$\s*([\d.,]+)/i,
        event_type: 'venda',
        extractAmount: m => {
          const qty = parseFloat(m[1]);
          const price = parseAmountBR(m[3]);
          return price && qty ? qty * price : null;
        },
        extractTicker: m => m[2].toUpperCase(),
        extractIR: () => null,
        confidence: 0.88,
      },
    ],
  },
  {
    broker: 'XP Investimentos',
    patterns: [
      {
        regex: /Você\s+recebeu\s+R\$\s*([\d.,]+)\s+(?:referente\s+a\s+)?(?:dividendo|JCP|provento)\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[1]),
        extractTicker: m => m[2].toUpperCase(),
        extractIR: () => null,
        confidence: 0.90,
      },
      {
        regex: /Você\s+recebeu\s+R\$\s*([\d.,]+)\s+referente\s+a\s+JCP\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)/i,
        event_type: 'jcp',
        extractAmount: m => parseAmountBR(m[1]),
        extractTicker: m => m[2].toUpperCase(),
        extractIR: () => null,
        confidence: 0.92,
      },
      {
        regex: /Rendimento\s+(?:creditado|disponível)[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'rendimento',
        extractAmount: m => parseAmountBR(m[1]),
        extractTicker: () => null,
        extractIR: () => null,
        confidence: 0.82,
      },
    ],
  },
  {
    broker: 'Rico',
    patterns: [
      {
        regex: /([A-Z]{4}\d{1,2}[A-Z]?)\s+(?:pagou|distribuiu)\s+dividendos?\s+(?:de\s+)?R\$\s*([\d.,]+)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.88,
      },
    ],
  },
  {
    broker: 'BTG Pactual',
    patterns: [
      {
        regex: /Provento\s+([A-Z]{4}\d{1,2}[A-Z]?)[\s-]+R\$\s*([\d.,]+)\s+(?:líquido|bruto)?/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.87,
      },
    ],
  },
  {
    broker: 'Nu Invest',
    patterns: [
      {
        regex: /Provento\s+(?:de\s+)?([A-Z]{4}\d{1,2}[A-Z]?)\s+creditado[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1].toUpperCase(),
        extractIR: () => null,
        confidence: 0.90,
      },
      {
        regex: /Rendimento\s+do\s+(?:mês|período)[\s:]+R\$\s*([\d.,]+)/i,
        event_type: 'rendimento',
        extractAmount: m => parseAmountBR(m[1]),
        extractTicker: () => null,
        extractIR: () => null,
        confidence: 0.83,
      },
    ],
  },
  // Genérico — captura qualquer padrão de provento
  {
    broker: null as any,
    patterns: [
      {
        regex: /(?:dividendo|provento|JCP|rendimento|amortização)\s+(?:de\s+)?(?:([A-Z]{4}\d{1,2}[A-Z]?)\s+)?(?:creditado\s+)?R\$\s*([\d.,]+)/i,
        event_type: 'dividendo',
        extractAmount: m => parseAmountBR(m[2]),
        extractTicker: m => m[1]?.toUpperCase() || null,
        extractIR: () => null,
        confidence: 0.65,
      },
    ],
  },
];

// ─── App packages → broker ────────────────────────────────────
const PACKAGE_BROKER: Record<string, string> = {
  'com.xpinvestimentos.app': 'XP Investimentos',
  'com.rico.app':            'Rico',
  'com.btgpactual.app':      'BTG Pactual',
  'com.clear.app':           'Clear',
  'br.com.nuinvest':         'Nu Invest',
  'com.genial.app':          'Genial',
  'br.com.avenue':           'Avenue',
};

// ─── Detect broker from text ──────────────────────────────────
function detectBrokerFromText(text: string): string | null {
  const brokers: Record<string, RegExp> = {
    'Clear':          /\bclear\b/i,
    'XP Investimentos': /\bxp\b/i,
    'Rico':           /\brico\b/i,
    'BTG Pactual':    /btg/i,
    'Nu Invest':      /nu\s*invest/i,
    'Genial':         /\bgenial\b/i,
    'Avenue':         /\bavenue\b/i,
  };
  for (const [name, re] of Object.entries(brokers)) {
    if (re.test(text)) return name;
  }
  return null;
}

// ─── Main parser (regex, sem LLM) ────────────────────────────
export function parseBrokerNotification(
  text: string,
  appPackage?: string
): ParsedBrokerEvent | null {
  const normalized = text.trim();

  // Broker pelo package
  const brokerFromPkg = appPackage ? PACKAGE_BROKER[appPackage] || null : null;
  const brokerFromTxt = detectBrokerFromText(normalized);
  const knownBroker   = brokerFromPkg || brokerFromTxt;

  // Tenta brokers conhecidos primeiro (maior confiança)
  const orderedBrokers = knownBroker
    ? [
        ...BROKER_PATTERNS.filter(b => b.broker === knownBroker),
        ...BROKER_PATTERNS.filter(b => b.broker !== knownBroker),
      ]
    : BROKER_PATTERNS;

  for (const brokerDef of orderedBrokers) {
    for (const pattern of brokerDef.patterns) {
      const match = normalized.match(pattern.regex);
      if (match) {
        const amount = pattern.extractAmount(match);
        if (!amount) continue;

        const ir = pattern.extractIR(match);

        return {
          event_type:   pattern.event_type,
          ticker:       pattern.extractTicker(match),
          asset_name:   null,
          gross_amount: amount,
          ir_amount:    ir,
          net_amount:   ir ? amount - ir : amount,
          broker:       brokerDef.broker || knownBroker,
          confidence:   pattern.confidence,
          raw_text:     normalized,
        };
      }
    }
  }

  return null;
}

// ─── Verificar se é notificação de corretora ──────────────────
const BROKER_KEYWORDS = /dividendo|provento|jcp|rendimento|amortização|custódia|nota de corretagem|compra executada|venda executada|liquidação/i;

export function isBrokerNotification(text: string, appPackage?: string): boolean {
  if (appPackage && PACKAGE_BROKER[appPackage]) return true;
  return BROKER_KEYWORDS.test(text);
}