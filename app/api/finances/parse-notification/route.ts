// app/api/finances/parse-notification/route.ts
// Recebe texto de notificação bancária e cria transação pendente
// Chamado pelo app React Native quando intercepta uma push notification

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseNotification } from '@/lib/finances/notification-parser';
import { resolveCategoryId, resolveAccountId } from '@/lib/finances/db';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

async function resolveUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const { createClient: c } = await import('@supabase/supabase-js');
  const authClient = c(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: { user } } = await authClient.auth.getUser(token);
  if (!user) return null;

  const { data: jarvisUser } = await supabase
    .from('users')
    .select('id, email')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  return jarvisUser
    ? { authUserId: user.id, jarvisUserId: jarvisUser.id as number }
    : null;
}

// Mapeamento heurístico merchant → categoria
const MERCHANT_CATEGORY_MAP: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /ifood|rappi|uber\s*eats|delivery|hamburger|pizza|restaurante|lanche|refeição/i, category: 'Alimentação' },
  { pattern: /mercado|supermercado|carrefour|extra|pão\s*de\s*açúcar|atacadão|rede\s*attack|hortifruti|feira/i, category: 'Alimentação' },
  { pattern: /uber|99|cabify|taxi|ônibus|metro|metrô|combustível|gasolina|shell|ipiranga|posto/i, category: 'Transporte' },
  { pattern: /farmácia|farmacia|drogaria|droga\s*raia|ultrafarma|panvel/i, category: 'Saúde' },
  { pattern: /academia|smartfit|bio\s*ritmo|gym/i, category: 'Saúde' },
  { pattern: /netflix|spotify|amazon\s*prime|hbo|disney|globoplay|youtube\s*premium/i, category: 'Assinaturas' },
  { pattern: /amazon|mercado\s*livre|shopee|aliexpress|magalu|americanas|casas\s*bahia/i, category: 'Compras' },
  { pattern: /escola|faculdade|universidade|curso|udemy|alura|estacio/i, category: 'Educação' },
  { pattern: /aluguel|condomínio|condominio|iptu|água|agua|luz|energia|gás|gas\s*natural/i, category: 'Moradia' },
  { pattern: /bar|boteco|cerveja|chopp|pub/i, category: 'Lazer' },
  { pattern: /cinema|ingresso|teatro|show|concerto|bilheteria/i, category: 'Lazer' },
  { pattern: /salário|salario|pagamento|folha/i, category: 'Salário' },
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

    if (!notification_text && !notification_title) {
      return NextResponse.json({ error: 'notification_text obrigatório' }, { status: 400 });
    }

    const fullText = [notification_title, notification_text].filter(Boolean).join(' — ');

    // 1. Parsear a notificação
    const parsed = await parseNotification(fullText);

    // Se confidence muito baixa ou sem valor, não cria transação
    if (!parsed.amount || parsed.confidence < 0.4) {
      return NextResponse.json({
        ok: false,
        skipped: true,
        reason: 'Notificação não reconhecida como transação financeira',
        confidence: parsed.confidence,
      });
    }

    // 2. Detectar banco pelo app_package se não veio no parse
    let bank = parsed.bank;
    if (!bank && app_package) {
      const PACKAGE_BANK_MAP: Record<string, string> = {
        'com.nu.production': 'Nubank',
        'com.itau': 'Itaú',
        'com.bradesco': 'Bradesco',
        'com.santander.app': 'Santander',
        'br.com.intermedium': 'Inter',
        'com.c6bank.app': 'C6 Bank',
        'br.com.bb.android': 'Banco do Brasil',
        'com.caixa.tem': 'Caixa',
      };
      bank = PACKAGE_BANK_MAP[app_package] || null;
    }

    // 3. Inferir categoria
    const inferredCategoryName = inferCategory(parsed.merchant, parsed.description);
    let categoryId: string | null = null;
    if (inferredCategoryName) {
      categoryId = await resolveCategoryId(user.authUserId, inferredCategoryName, parsed.type || 'expense').catch(() => null);
    }

    // 4. Resolver conta pelo banco
    let accountId: string | null = null;
    if (bank) {
      accountId = await resolveAccountId(user.jarvisUserId, user.authUserId, bank).catch(() => null);
    }

    // 5. Verificar duplicata (mesmo source_id nos últimos 5 min)
    const sourceId = `notif_${Buffer.from(fullText.slice(0, 60)).toString('base64')}`;
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('jarvis_user_id', user.jarvisUserId)
      .eq('source', 'notification')
      .eq('source_id', sourceId)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({
        ok: false,
        skipped: true,
        reason: 'Transação duplicada — já registrada',
        existing_id: existing.id,
      });
    }

    // 6. Criar transação com status 'pending' (aguarda confirmação do usuário)
    const today = new Date().toISOString().split('T')[0];
    const txDate = notification_time
      ? new Date(notification_time).toISOString().split('T')[0]
      : today;

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        user_id: user.authUserId,
        jarvis_user_id: user.jarvisUserId,
        amount: parsed.amount,
        type: parsed.type || 'expense',
        description: parsed.description,
        merchant: parsed.merchant,
        transaction_date: txDate,
        category_id: categoryId,
        user_account_id: accountId,
        source: 'notification',
        source_id: sourceId,
        raw_data: {
          notification_title,
          notification_text,
          app_package,
          bank,
          parsed_by: parsed.confidence >= 0.75 ? 'regex' : 'llm',
        },
        status: 'pending', // usuário precisa confirmar
        confidence: parsed.confidence,
      })
      .select('id, amount, type, merchant, status, transaction_date')
      .single();

    if (error) throw new Error(error.message);

    // 7. Enfileirar push notification para pedir confirmação ao usuário
    // (usa o sistema de push existente)
    try {
      const { data: userRecord } = await supabase
        .from('users')
        .select('push_token, assistant_name')
        .eq('id', user.jarvisUserId)
        .maybeSingle();

      if (userRecord?.push_token) {
        const assistantName = userRecord.assistant_name || 'Lev';
        const fmt = (n: number) =>
          new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: userRecord.push_token,
            title: `${assistantName} detectou uma transação`,
            body: `${parsed.type === 'income' ? '+' : '-'}${fmt(parsed.amount)}${parsed.merchant ? ` · ${parsed.merchant}` : ''}. Confirmar?`,
            data: {
              type: 'finance_pending',
              transaction_id: transaction.id,
            },
          }),
        });
      }
    } catch (pushErr) {
      // Push falha silenciosamente — transação já foi criada
      console.warn('[ParseNotification] Push falhou:', pushErr);
    }

    return NextResponse.json({
      ok: true,
      transaction_id: transaction.id,
      parsed: {
        amount: parsed.amount,
        type: parsed.type,
        merchant: parsed.merchant,
        category: inferredCategoryName,
        confidence: parsed.confidence,
        bank,
      },
      status: 'pending',
      message: `Transação de ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(parsed.amount)} detectada e aguardando confirmação.`,
    }, { status: 201 });

  } catch (e: any) {
    console.error('[ParseNotification]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}