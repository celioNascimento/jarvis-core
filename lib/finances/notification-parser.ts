// lib/finances/notification-parser.ts
// Parser de notificações bancárias para transações
// Extrai amount, type, merchant, description de texto livre

import { callOpenRouter } from '@/lib/jarvis';

export interface ParsedNotification {
  amount: number | null;
  type: 'expense' | 'income' | 'transfer_out' | 'transfer_in' | null;
  merchant: string | null;
  description: string | null;
  bank: string | null;
  confidence: number; // 0.0 – 1.0
  raw_text: string;
}

// ─── Regex rápida para bancos brasileiros ────────────────────────────────────
// Testa primeiro sem gastar token de LLM
const BANK_PATTERNS: Array<{
  bank: string;
  patterns: RegExp[];
  parseAmount: (m: RegExpMatchArray) => number | null;
  parseType: (text: string) => ParsedNotification['type'];
  parseMerchant: (m: RegExpMatchArray, text: string) => string | null;
}> = [
  {
    bank: 'Nubank',
    patterns: [
      /Compra aprovada de R\$\s*([\d.,]+)\s+(?:no|em|na)?\s*(.+?)(?:\.|$)/i,
      /Você pagou R\$\s*([\d.,]+)\s+(?:para|em)\s*(.+?)(?:\.|$)/i,
      /Débito de R\$\s*([\d.,]+)/i,
      /Pix enviado: R\$\s*([\d.,]+)\s+(?:para\s+)?(.+?)(?:\.|$)/i,
      /Pix recebido: R\$\s*([\d.,]+)\s+(?:de\s+)?(.+?)(?:\.|$)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: (text) => {
      if (/recebido|entrada|crédito/i.test(text)) return 'income';
      if (/enviado|transferência para/i.test(text)) return 'transfer_out';
      return 'expense';
    },
    parseMerchant: (m, text) => m[2]?.trim() || null,
  },
  {
    bank: 'Itaú',
    patterns: [
      /Compra no crédito\s+R\$\s*([\d.,]+)\s+(.+?)(?:\s+em\s+|\.|$)/i,
      /Compra no débito\s+R\$\s*([\d.,]+)\s+(.+?)(?:\s+em\s+|\.|$)/i,
      /Pix de R\$\s*([\d.,]+)\s+(?:enviado para|recebido de)\s+(.+?)(?:\.|$)/i,
      /Transferência de R\$\s*([\d.,]+)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: (text) => {
      if (/recebido|crédito/i.test(text)) return 'income';
      if (/enviado|transferência/i.test(text)) return 'transfer_out';
      return 'expense';
    },
    parseMerchant: (m, text) => m[2]?.trim() || null,
  },
  {
    bank: 'Bradesco',
    patterns: [
      /Compra aprovada\s+R\$\s*([\d.,]+)\s+(.+?)(?:\.|$)/i,
      /Débito realizado R\$\s*([\d.,]+)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: () => 'expense',
    parseMerchant: (m) => m[2]?.trim() || null,
  },
  {
    bank: 'Santander',
    patterns: [
      /Compra de R\$\s*([\d.,]+)\s+(?:em|no|na)\s+(.+?)(?:\.|$)/i,
      /Débito R\$\s*([\d.,]+)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: () => 'expense',
    parseMerchant: (m) => m[2]?.trim() || null,
  },
  {
    bank: 'Inter',
    patterns: [
      /Compra aprovada R\$\s*([\d.,]+)\s+(.+?)(?:\.|$)/i,
      /Pix enviado R\$\s*([\d.,]+)\s+(?:para\s+)?(.+?)(?:\.|$)/i,
      /Pix recebido R\$\s*([\d.,]+)\s+(?:de\s+)?(.+?)(?:\.|$)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: (text) => {
      if (/recebido/i.test(text)) return 'income';
      if (/enviado/i.test(text)) return 'transfer_out';
      return 'expense';
    },
    parseMerchant: (m) => m[2]?.trim() || null,
  },
  {
    bank: 'C6 Bank',
    patterns: [
      /Transação de R\$\s*([\d.,]+)\s+(?:em|no|na)\s+(.+?)(?:\.|$)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: () => 'expense',
    parseMerchant: (m) => m[2]?.trim() || null,
  },
  // Genérico — captura qualquer R$ X em Y
  {
    bank: 'Desconhecido',
    patterns: [
      /R\$\s*([\d.,]+)\s+(?:em|no|na|para|de)\s+(.{3,40})(?:\.|$)/i,
      /R\$\s*([\d.,]+)/i,
    ],
    parseAmount: (m) => parseAmountBR(m[1]),
    parseType: (text) => {
      if (/receb|entrada|crédito|credit/i.test(text)) return 'income';
      if (/transfer|pix env|enviado/i.test(text)) return 'transfer_out';
      return 'expense';
    },
    parseMerchant: (m) => m[2]?.trim() || null,
  },
];

function parseAmountBR(str: string): number | null {
  if (!str) return null;
  // "1.234,56" → 1234.56 | "1234.56" → 1234.56 | "50,00" → 50.00
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) || val <= 0 ? null : val;
}

// ─── Parser regex (rápido, sem LLM) ──────────────────────────────────────────
export function parseNotificationRegex(text: string): ParsedNotification | null {
  const normalized = text.trim();

  for (const bank of BANK_PATTERNS) {
    for (const pattern of bank.patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const amount = bank.parseAmount(match);
        if (!amount) continue;

        return {
          amount,
          type: bank.parseType(normalized),
          merchant: bank.parseMerchant(match, normalized),
          description: normalized.slice(0, 120),
          bank: bank.bank !== 'Desconhecido' ? bank.bank : detectBank(normalized),
          confidence: bank.bank !== 'Desconhecido' ? 0.85 : 0.6,
          raw_text: normalized,
        };
      }
    }
  }

  return null;
}

function detectBank(text: string): string | null {
  const banks: Record<string, RegExp> = {
    'Nubank': /nubank|nu\s/i,
    'Itaú': /ita[uú]/i,
    'Bradesco': /bradesco/i,
    'Santander': /santander/i,
    'Inter': /\binter\b/i,
    'C6 Bank': /c6\s*bank/i,
    'BTG': /btg/i,
    'XP': /\bxp\b/i,
    'Caixa': /caixa\s*econ/i,
    'Banco do Brasil': /banco\s*do\s*brasil|\bbb\b/i,
  };

  for (const [name, regex] of Object.entries(banks)) {
    if (regex.test(text)) return name;
  }
  return null;
}

// ─── Parser LLM (para textos ambíguos) ───────────────────────────────────────
export async function parseNotificationLLM(text: string): Promise<ParsedNotification> {
  const prompt = `Você é um parser de notificações bancárias brasileiras.
Extraia as informações da notificação abaixo e responda APENAS com JSON válido.

Notificação: "${text.slice(0, 300)}"

JSON esperado:
{
  "amount": <número positivo em reais ou null>,
  "type": <"expense"|"income"|"transfer_out"|"transfer_in"|null>,
  "merchant": <nome do estabelecimento/beneficiário ou null>,
  "description": <descrição curta ou null>,
  "bank": <nome do banco ou null>,
  "confidence": <0.0 a 1.0>
}

Regras:
- amount: sempre positivo (ex: 50.00, não -50.00)
- type: "expense" para compras/débitos, "income" para créditos/recebimentos, "transfer_out" para pix/ted enviados, "transfer_in" para pix/ted recebidos
- merchant: nome curto do estabelecimento (ex: "iFood", "Mercado Extra") — null se não identificável
- confidence: 0.9 se todos os campos claros, 0.7 se parcial, 0.5 se incerto`;

  try {
    const raw = await callOpenRouter(prompt, 'flash', 0.1);
    const cleaned = raw.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      amount: typeof parsed.amount === 'number' && parsed.amount > 0 ? parsed.amount : null,
      type: ['expense', 'income', 'transfer_out', 'transfer_in'].includes(parsed.type) ? parsed.type : null,
      merchant: typeof parsed.merchant === 'string' ? parsed.merchant.slice(0, 80) : null,
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 120) : text.slice(0, 120),
      bank: typeof parsed.bank === 'string' ? parsed.bank : detectBank(text),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      raw_text: text,
    };
  } catch {
    return {
      amount: null, type: null, merchant: null,
      description: text.slice(0, 120),
      bank: detectBank(text),
      confidence: 0.3,
      raw_text: text,
    };
  }
}

// ─── Entry point principal ────────────────────────────────────────────────────
// Tenta regex primeiro (rápido), fallback para LLM se confiança baixa
export async function parseNotification(text: string): Promise<ParsedNotification> {
  const regexResult = parseNotificationRegex(text);

  // Regex com boa confiança e amount válido → retorna direto
  if (regexResult && regexResult.amount && regexResult.confidence >= 0.75) {
    return regexResult;
  }

  // Fallback para LLM se regex falhou ou confiança baixa
  return parseNotificationLLM(text);
}