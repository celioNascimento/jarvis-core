// app/api/finances/parse-notification/route.ts
// V2 — detecta automaticamente se é notificação bancária ou de corretora

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseNotification } from '@/lib/finances/notification-parser';
import { parseBrokerNotification, isBrokerNotification } from '@/lib/finances/broker-parser';
import { resolveCategoryId, resolveAccountId } from '@/lib/finances/db';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { createClient: c } = await import('@supabase/supabase-js');
  const { data: { user } } = await c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!).auth.getUser(token);
  if (!user) return null;
  const { data: j } = await supabase.from('users').select('id').eq('auth_user_id', user.id).maybeSingle();
  return j ? { authUserId: user.id, jarvisUserId: j.id as number } : null;
}

const MERCHANT_CATEGORY_MAP: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /ifood|rappi|uber\s*eats|delivery|restaurante|lanche/i, category: 'Alimentação' },
  { pattern: /mercado|supermercado|carrefour|extra|pão\s*de\s*açúcar|hortifruti/i, category: 'Alimentação' },
  { pattern: /uber|99|cabify|combustível|gasolina|shell|ipiranga|posto/i, category: 'Transporte' },
  { pattern: /farmácia|drogaria|droga\s*raia|ultrafarma/i, category: 'Saúde' },
  { pattern: /academia|smartfit|gym/i, category: 'Saúde' },
  { pattern: /netflix|spotify|amazon\s*prime|hbo|disney|globoplay/i, category: 'Assinaturas' },
  { pattern: /amazon|mercado\s*livre|shopee|americanas/i, category: 'Vestuário' },
  { pattern: /escola|faculdade|curso|udemy|alura/i, category: 'Educação' },
  { pattern: /aluguel|condomínio|iptu|água|energia|gás/i, category: 'Moradia' },
];

function inferCategory(merchant: string | null, description: string | null): string | null {
  const text = `${merchant || ''} ${description || ''}`.toLowerCase();
  for (const { pattern, category } of MERCHANT_CATEGORY_MAP) {
    if (pattern.test(text)) return category;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const body = await req.json();
    const { notification_text, notification_title, app_package, notification_time } = body;

    if (!notification_text && !notification_title)
      return NextResponse.json({ error: 'notification_text obrigatório' }, { status: 400 });

    const fullText = [notification_title, notification_text].filter(Boolean).join(' — ');
    const today = notification_time
      ? new Date(notification_time).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    const sourceId = `notif_${Buffer.from(fullText.slice(0, 60)).toString('base64')}`;

    // Deduplicação
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('jarvis_user_id', user.jarvisUserId)
      .eq('source_id', sourceId)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: false, skipped: true, reason: 'Duplicata detectada', existing_id: existing.id });
    }

    // ── Detecta se é corretora ────────────────────────────────
    if (isBrokerNotification(fullText, app_package)) {
      const parsed = parseBrokerNotification(fullText, app_package);

      if (!parsed || !parsed.gross_amount || parsed.confidence < 0.5) {
        return NextResponse.json({ ok: false, skipped: true, reason: 'Evento de corretora não reconhecido', confidence: parsed?.confidence });
      }

      // Busca primeira carteira de investimento
      const { data: invAcc } = await supabase
        .from('investment_accounts')
        .select('id')
        .eq('jarvis_user_id', user.jarvisUserId)
        .eq('is_active', true)
        .order('sort_order')
        .limit(1)
        .maybeSingle();

      if (!invAcc) {
        return NextResponse.json({ ok: false, skipped: true, reason: 'Nenhuma carteira de investimento cadastrada' });
      }

      const { data: event, error: evtError } = await supabase
        .from('investment_events')
        .insert({
          investment_account_id: invAcc.id,
          user_id:               user.authUserId,
          jarvis_user_id:        user.jarvisUserId,
          event_type:            parsed.event_type,
          ticker:                parsed.ticker,
          asset_name:            parsed.ticker || null,
          gross_amount:          parsed.gross_amount,
          ir_amount:             parsed.ir_amount || 0,
          net_amount:            parsed.net_amount ?? parsed.gross_amount,
          event_date:            today,
          source:                'notification',
          source_id:             sourceId,
          raw_notification:      fullText,
          broker_ref:            parsed.broker || null,
          auto_create_transaction: true,
        })
        .select('id')
        .single();

      if (evtError) throw evtError;

      // Push de confirmação
      await sendConfirmationPush(user.jarvisUserId, {
        title: `${parsed.broker || 'Corretora'} — ${parsed.event_type}`,
        body: `${parsed.ticker ? parsed.ticker + ' · ' : ''}+R$${(parsed.net_amount ?? parsed.gross_amount).toFixed(2).replace('.', ',')}. Confirmar?`,
        data: { type: 'investment_event', event_id: event.id },
      });

      return NextResponse.json({
        ok: true, type: 'investment_event', event_id: event.id,
        parsed: { event_type: parsed.event_type, ticker: parsed.ticker, net_amount: parsed.net_amount, confidence: parsed.confidence },
      }, { status: 201 });
    }

    // ── Notificação bancária (transação) ──────────────────────
    const parsed = await parseNotification(fullText);

    if (!parsed.amount || parsed.confidence < 0.4) {
      return NextResponse.json({ ok: false, skipped: true, reason: 'Notificação não reconhecida', confidence: parsed.confidence });
    }

    let categoryId: string | null = null;
    const inferredCat = inferCategory(parsed.merchant, parsed.description);
    if (inferredCat) {
      categoryId = await resolveCategoryId(user.authUserId, inferredCat, parsed.type || 'expense').catch(() => null);
    }

    let accountId: string | null = null;
    if (parsed.bank) {
      accountId = await resolveAccountId(user.jarvisUserId, user.authUserId, parsed.bank).catch(() => null);
    }

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        user_id:         user.authUserId,
        jarvis_user_id:  user.jarvisUserId,
        amount:          parsed.amount,
        type:            parsed.type || 'expense',
        description:     parsed.description,
        merchant:        parsed.merchant,
        transaction_date: today,
        category_id:     categoryId,
        user_account_id: accountId,
        source:          'notification',
        source_id:       sourceId,
        raw_data:        { notification_title, notification_text, app_package, bank: parsed.bank },
        status:          'pending',
        confidence:      parsed.confidence,
      })
      .select('id, amount, type, merchant')
      .single();

    if (error) throw error;

    const fmt = (n: number) => `R$${n.toFixed(2).replace('.', ',')}`;

    await sendConfirmationPush(user.jarvisUserId, {
      title: 'Transação detectada',
      body: `${parsed.type === 'income' ? '+' : '-'}${fmt(parsed.amount)}${parsed.merchant ? ' · ' + parsed.merchant : ''}. Confirmar?`,
      data: { type: 'finance_pending', transaction_id: transaction.id },
    });

    return NextResponse.json({
      ok: true, type: 'transaction', transaction_id: transaction.id,
      parsed: { amount: parsed.amount, type: parsed.type, merchant: parsed.merchant, confidence: parsed.confidence },
    }, { status: 201 });

  } catch (e: any) {
    console.error('[ParseNotification]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function sendConfirmationPush(jarvisUserId: number, notification: { title: string; body: string; data: any }) {
  try {
    const { data: u } = await supabase.from('users').select('push_token').eq('id', jarvisUserId).maybeSingle();
    if (!u?.push_token) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: u.push_token, ...notification }),
    });
  } catch { /* silencioso */ }
}