// app/api/finances/dashboard/route.ts
// GET — dados completos do dashboard por mês
// ?year=2025&month=4

import { NextRequest, NextResponse } from 'next/server';
import { callOpenRouter } from '@/lib/jarvis';
import { resolveUser } from '@/lib/finances/auth';
import { supabase } from '@/lib/jarvis';




function getPeriod(year: number, month: number) {
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0);
  const pad   = (n: number) => String(n).padStart(2, '0');
  const fmt   = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { start: fmt(start), end: fmt(end) };
}

function getPrevPeriod(year: number, month: number) {
  const prev = month === 1 ? { year: year-1, month: 12 } : { year, month: month-1 };
  return getPeriod(prev.year, prev.month);
}

export async function GET(req: NextRequest) {
  try {
    const user = await resolveUser(req);
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const now = new Date();
    const year  = parseInt(searchParams.get('year')  || String(now.getFullYear()), 10);
    const month = parseInt(searchParams.get('month') || String(now.getMonth() + 1), 10);

    const { start, end } = getPeriod(year, month);
    const { start: prevStart, end: prevEnd } = getPrevPeriod(year, month);

    // ── 1. Transações do mês ──────────────────────────────────
    const { data: transactions } = await supabase
      .from('transactions')
      .select('*, category:categories(id,name,icon,color)')
      .eq('jarvis_user_id', user.jarvisUserId)
      .in('status', ['confirmed', 'pending'])
      .gte('transaction_date', start)
      .lte('transaction_date', end);

    const txs = transactions || [];

    const total_income  = txs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    const total_expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const pending_count = txs.filter(t => t.status === 'pending').length;

    // ── 2. Contas com saldo ───────────────────────────────────
    const { data: accountsRaw } = await supabase
      .from('user_accounts')
      .select('*, open_invoice:credit_invoices(total_amount,due_date,status)')
      .eq('jarvis_user_id', user.jarvisUserId)
      .eq('is_active', true)
      .order('sort_order');

    const accounts = (accountsRaw || []).map((a: any) => {
      const invoice = Array.isArray(a.open_invoice)
        ? a.open_invoice.find((i: any) => i.status !== 'paid') ?? null
        : a.open_invoice ?? null;
      return {
        id: a.id,
        bank_name: a.bank_name,
        bank_domain: a.bank_domain,
        bank_color: a.bank_color,
        account_label: a.account_label,
        account_type: a.account_type,
        current_balance: Number(a.current_balance),
        open_invoice: invoice ? {
          total_amount: Number(invoice.total_amount),
          due_date: invoice.due_date,
          status: invoice.status,
        } : null,
        // Previsto = saldo atual - despesas pendentes vinculadas a esta conta
        forecast_balance: Number(a.current_balance) - txs
          .filter(t => t.user_account_id === a.id && t.status === 'pending' && t.type === 'expense')
          .reduce((s: number, t: any) => s + Number(t.amount), 0),
      };
    });

    // ── 3. Saldo consolidado ──────────────────────────────────
    const checkingAccounts = accounts.filter(a => ['checking','savings','wallet'].includes(a.account_type));
    const balance_initial  = checkingAccounts.reduce((s, a) => s + a.current_balance, 0);
    const balance_forecast = checkingAccounts.reduce((s, a) => s + a.forecast_balance, 0);
    const balance          = total_income - total_expense;
    const credit_total     = accounts
      .filter(a => a.account_type === 'credit_card')
      .reduce((s, a) => s + (a.open_invoice?.total_amount ?? 0), 0);

    // ── 4. By category ────────────────────────────────────────
    const catMap = new Map<string, { name: string; icon: string|null; color: string|null; total: number; count: number }>();
    for (const t of txs.filter(t => t.type === 'expense')) {
      const cid   = t.category_id || '__uncategorized__';
      const cname = (t as any).category?.name || 'Sem categoria';
      if (!catMap.has(cid)) catMap.set(cid, { name: cname, icon: (t as any).category?.icon || null, color: (t as any).category?.color || null, total: 0, count: 0 });
      const entry = catMap.get(cid)!;
      entry.total += Number(t.amount); entry.count++;
    }
    const by_category = Array.from(catMap.entries()).map(([id, v]) => ({
      category_id: id, category_name: v.name, category_icon: v.icon, category_color: v.color,
      total: v.total, count: v.count,
      percent_of_expenses: total_expense > 0 ? Math.round((v.total / total_expense) * 100) : 0,
    })).sort((a, b) => b.total - a.total);

    // ── 5. Mês anterior para comparação (insights) ───────────
    const { data: prevTxs } = await supabase
      .from('transactions')
      .select('amount, type, category_id')
      .eq('jarvis_user_id', user.jarvisUserId)
      .in('status', ['confirmed'])
      .gte('transaction_date', prevStart)
      .lte('transaction_date', prevEnd);

    const prevExpense = (prevTxs || []).filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);

    // ── 6. Insights do Lev (LLM) ─────────────────────────────
    let insights: any[] = [];
    try {
      const topCats = by_category.slice(0, 3).map(c => `${c.category_name}: R$${c.total.toFixed(0)} (${c.percent_of_expenses}%)`).join(', ');
      const insightPrompt = `Você é o ${user.assistantName || 'Lev'}, assistente financeiro de ${user.nickname || 'Usuário'}.
Analise os dados financeiros de ${new Date(year, month-1, 1).toLocaleDateString('pt-BR', {month:'long', year:'numeric'})}:
- Receitas: R$${total_income.toFixed(2)}
- Despesas: R$${total_expense.toFixed(2)}
- Economia: R$${(total_income - total_expense).toFixed(2)}
- Top categorias: ${topCats || 'nenhuma'}
- Mês anterior (despesas): R$${prevExpense.toFixed(2)}
- Transações pendentes: ${pending_count}

Gere de 2 a 3 insights curtos, diretos e úteis. Responda APENAS com JSON válido:
[{"type":"anomaly"|"projection"|"alert"|"tip","title":"<máx 6 palavras>","body":"<máx 25 palavras>"}]
Sem markdown, sem explicações fora do JSON.`;

      const raw = await callOpenRouter(insightPrompt, 'flash', 0.3);
      const cleaned = raw.trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) insights = parsed.slice(0, 3);
    } catch { /* insights opcionais — não bloqueiam */ }

    return NextResponse.json({
      ok: true,
      data: {
        summary: {
          period_start: start, period_end: end,
          total_income, total_expense,
          balance, balance_initial,
          balance_forecast, pending_count,
          by_category, credit_total,
          savings: total_income - total_expense,
        },
        accounts,
        insights,
      },
    });
  } catch (e: any) {
    console.error('[Dashboard]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
