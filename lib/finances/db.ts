// lib/finances/db.ts
// Queries e mutations do módulo de finanças
// Todas via service_role (sem RLS — uuid/bigint mismatch)

import { createClient } from '@supabase/supabase-js';
import type {
  Transaction,
  UserAccount,
  Category,
  Budget,
  BudgetWithUsage,
  FinanceSummary,
  CreateTransactionPayload,
  TransactionType,
} from './types';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

// ─── Períodos ───────────────────────────────────────────────────────────────
export function getPeriodDates(
  period: 'today' | 'week' | 'month' | 'last_month' | 'year' = 'month'
): { start: string; end: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (period === 'today') {
    const s = toISO(now);
    return { start: s, end: s };
  }
  if (period === 'week') {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: toISO(start), end: toISO(end) };
  }
  if (period === 'last_month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: toISO(start), end: toISO(end) };
  }
  if (period === 'year') {
    return {
      start: `${now.getFullYear()}-01-01`,
      end: `${now.getFullYear()}-12-31`,
    };
  }
  // month (default)
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start: toISO(start), end: toISO(end) };
}

// ─── Contas ──────────────────────────────────────────────────────────────────
export async function getUserAccounts(jarvisUserId: number): Promise<UserAccount[]> {
  const { data, error } = await supabase
    .from('user_accounts')
    .select('*')
    .eq('jarvis_user_id', jarvisUserId)
    .eq('is_active', true)
    .order('bank_name');

  if (error) throw new Error(`[Finance] getUserAccounts: ${error.message}`);
  return data || [];
}

export async function resolveAccountId(
  jarvisUserId: number,
  authUserId: string,
  accountLabel?: string
): Promise<string | null> {
  const accounts = await getUserAccounts(jarvisUserId);
  if (!accounts.length) return null;

  if (accountLabel) {
    const label = accountLabel.toLowerCase();
    const match = accounts.find(
      (a) =>
        a.account_label?.toLowerCase().includes(label) ||
        a.bank_name.toLowerCase().includes(label)
    );
    if (match) return match.id;
  }

  // Retorna primeira conta ativa como default
  return accounts[0].id;
}

// ─── Categorias ──────────────────────────────────────────────────────────────
export async function getCategories(
  authUserId: string,
  type?: TransactionType
): Promise<Category[]> {
  let query = supabase
    .from('categories')
    .select('*')
    .or(`user_id.is.null,user_id.eq.${authUserId}`)
    .order('name');

  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) throw new Error(`[Finance] getCategories: ${error.message}`);
  return data || [];
}

export async function resolveCategoryId(
  authUserId: string,
  categoryName: string,
  type?: TransactionType
): Promise<string | null> {
  const categories = await getCategories(authUserId, type);
  if (!categories.length) return null;

  const name = categoryName.toLowerCase().trim();
  const exact = categories.find((c) => c.name.toLowerCase() === name);
  if (exact) return exact.id;

  const partial = categories.find((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase()));
  return partial?.id ?? null;
}

// ─── Transações ──────────────────────────────────────────────────────────────
export async function createTransaction(
  authUserId: string,
  jarvisUserId: number,
  payload: CreateTransactionPayload
): Promise<Transaction> {
  const today = new Date().toISOString().split('T')[0];

  let categoryId: string | null = null;
  if (payload.category_name) {
    categoryId = await resolveCategoryId(authUserId, payload.category_name, payload.type);
  }

  let accountId: string | null = null;
  if (payload.account_label) {
    accountId = await resolveAccountId(jarvisUserId, authUserId, payload.account_label);
  }

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: authUserId,
      jarvis_user_id: jarvisUserId,
      amount: payload.amount,
      type: payload.type,
      description: payload.description || null,
      transaction_date: payload.transaction_date || today,
      category_id: categoryId,
      merchant: payload.merchant || null,
      user_account_id: accountId,
      source: payload.source || 'manual',
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      confidence: 1.0,
    })
    .select('*, category:categories(*), user_account:user_accounts(*)')
    .single();

  if (error) throw new Error(`[Finance] createTransaction: ${error.message}`);
  return data;
}

export async function getTransactions(
  jarvisUserId: number,
  options: {
    start?: string;
    end?: string;
    type?: TransactionType;
    category_id?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<Transaction[]> {
  let query = supabase
    .from('transactions')
    .select('*, category:categories(id,name,icon,color), user_account:user_accounts(id,bank_name,account_label)')
    .eq('jarvis_user_id', jarvisUserId)
    .neq('status', 'ignored')
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (options.start) query = query.gte('transaction_date', options.start);
  if (options.end) query = query.lte('transaction_date', options.end);
  if (options.type) query = query.eq('type', options.type);
  if (options.category_id) query = query.eq('category_id', options.category_id);
  if (options.status) query = query.eq('status', options.status);
  query = query.limit(options.limit || 50);
  if (options.offset) query = query.range(options.offset, options.offset + (options.limit || 50) - 1);

  const { data, error } = await query;
  if (error) throw new Error(`[Finance] getTransactions: ${error.message}`);
  return data || [];
}

export async function updateTransactionStatus(
  transactionId: number,
  status: 'confirmed' | 'ignored' | 'duplicate'
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({
      status,
      confirmed_at: status === 'confirmed' ? new Date().toISOString() : null,
    })
    .eq('id', transactionId);

  if (error) throw new Error(`[Finance] updateTransactionStatus: ${error.message}`);
}

// ─── Resumo / Summary ────────────────────────────────────────────────────────
export async function getFinanceSummary(
  jarvisUserId: number,
  period: 'today' | 'week' | 'month' | 'last_month' | 'year' = 'month'
): Promise<FinanceSummary> {
  const { start, end } = getPeriodDates(period);

  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('*, category:categories(id,name,icon,color)')
    .eq('jarvis_user_id', jarvisUserId)
    .in('status', ['confirmed', 'pending'])
    .gte('transaction_date', start)
    .lte('transaction_date', end);

  if (error) throw new Error(`[Finance] getFinanceSummary: ${error.message}`);

  const txs = transactions || [];

  const total_income = txs
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + Number(t.amount), 0);

  const total_expense = txs
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + Number(t.amount), 0);

  const pending_count = txs.filter((t) => t.status === 'pending').length;

  // By category (expenses only)
  const expenseTxs = txs.filter((t) => t.type === 'expense');
  const catMap = new Map<string, { name: string; icon: string | null; color: string | null; total: number; count: number }>();

  for (const t of expenseTxs) {
    const cid = t.category_id || '__uncategorized__';
    const cname = (t as any).category?.name || 'Sem categoria';
    const cicon = (t as any).category?.icon || null;
    const ccolor = (t as any).category?.color || null;

    if (!catMap.has(cid)) catMap.set(cid, { name: cname, icon: cicon, color: ccolor, total: 0, count: 0 });
    const entry = catMap.get(cid)!;
    entry.total += Number(t.amount);
    entry.count += 1;
  }

  const by_category = Array.from(catMap.entries())
    .map(([id, v]) => ({
      category_id: id,
      category_name: v.name,
      category_icon: v.icon,
      category_color: v.color,
      total: v.total,
      count: v.count,
      percent_of_expenses: total_expense > 0 ? Math.round((v.total / total_expense) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // By day
  const dayMap = new Map<string, { income: number; expense: number }>();
  for (const t of txs) {
    const d = t.transaction_date;
    if (!dayMap.has(d)) dayMap.set(d, { income: 0, expense: 0 });
    const entry = dayMap.get(d)!;
    if (t.type === 'income') entry.income += Number(t.amount);
    else if (t.type === 'expense') entry.expense += Number(t.amount);
  }

  const by_day = Array.from(dayMap.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    period_start: start,
    period_end: end,
    total_income,
    total_expense,
    balance: total_income - total_expense,
    by_category,
    by_day,
    pending_count,
  };
}

// ─── Orçamentos ──────────────────────────────────────────────────────────────
export async function getBudgetsWithUsage(
  jarvisUserId: number,
  authUserId: string,
  period?: { start: string; end: string }
): Promise<BudgetWithUsage[]> {
  const { start, end } = period || getPeriodDates('month');

  const { data: budgets, error } = await supabase
    .from('budgets')
    .select('*, category:categories(id,name,icon,color)')
    .eq('jarvis_user_id', jarvisUserId)
    .lte('period_start', end)
    .gte('period_end', start);

  if (error) throw new Error(`[Finance] getBudgetsWithUsage: ${error.message}`);

  const result: BudgetWithUsage[] = [];

  for (const budget of budgets || []) {
    const { data: spent_data } = await supabase
      .from('transactions')
      .select('amount')
      .eq('jarvis_user_id', jarvisUserId)
      .eq('category_id', budget.category_id)
      .in('status', ['confirmed', 'pending'])
      .eq('type', 'expense')
      .gte('transaction_date', budget.period_start)
      .lte('transaction_date', budget.period_end);

    const spent = (spent_data || []).reduce((s, t) => s + Number(t.amount), 0);
    const percent_used = Math.round((spent / budget.amount) * 100);

    // Verifica alertas ativos
    const { data: alerts } = await supabase
      .from('budget_alerts')
      .select('threshold_percent')
      .eq('budget_id', budget.id)
      .lte('threshold_percent', percent_used)
      .order('threshold_percent', { ascending: false })
      .limit(1);

    result.push({
      ...budget,
      spent,
      percent_used,
      remaining: Math.max(0, budget.amount - spent),
      alert_triggered: !!(alerts && alerts.length > 0),
    });
  }

  return result.sort((a, b) => b.percent_used - a.percent_used);
}

export async function createBudget(
  authUserId: string,
  jarvisUserId: number,
  categoryName: string,
  amount: number,
  period: 'month' | 'custom',
  customDates?: { start: string; end: string }
): Promise<Budget> {
  const categoryId = await resolveCategoryId(authUserId, categoryName, 'expense');
  if (!categoryId) throw new Error(`Categoria "${categoryName}" não encontrada.`);

  const { start, end } = customDates || getPeriodDates('month');

  const { data, error } = await supabase
    .from('budgets')
    .insert({
      user_id: authUserId,
      jarvis_user_id: jarvisUserId,
      category_id: categoryId,
      amount,
      period_start: start,
      period_end: end,
    })
    .select('*, category:categories(*)')
    .single();

  if (error) throw new Error(`[Finance] createBudget: ${error.message}`);
  return data;
}

// ─── Block para o sistema prompt do Jarvis ───────────────────────────────────
export async function buildFinanceBlock(jarvisUserId: number, authUserId: string): Promise<string> {
  try {
    const [summary, budgets] = await Promise.all([
      getFinanceSummary(jarvisUserId, 'month').catch(() => null),
      getBudgetsWithUsage(jarvisUserId, authUserId).catch(() => []),
    ]);

    if (!summary) return '';

    const fmt = (n: number) =>
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

    const parts: string[] = [];

    parts.push(
      `[FINANÇAS — ${new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' }).toUpperCase()}]\n` +
      `Receitas: ${fmt(summary.total_income)} | Despesas: ${fmt(summary.total_expense)} | Saldo: ${fmt(summary.balance)}` +
      (summary.pending_count > 0 ? ` | ⏳ ${summary.pending_count} transação(ões) pendente(s)` : '')
    );

    if (summary.by_category.length > 0) {
      const topCats = summary.by_category.slice(0, 3);
      parts.push(
        `Top gastos: ${topCats.map((c) => `${c.category_name} ${fmt(c.total)} (${c.percent_of_expenses}%)`).join(' · ')}`
      );
    }

    const alertedBudgets = (budgets as BudgetWithUsage[]).filter((b) => b.percent_used >= 80);
    if (alertedBudgets.length > 0) {
      parts.push(
        `⚠️ Orçamentos estourados/próximos do limite: ` +
        alertedBudgets.map((b) => `${(b.category as any)?.name || 'Cat.'} ${b.percent_used}%`).join(', ')
      );
    }

    return parts.join('\n');
  } catch (e) {
    console.error('[Finance] buildFinanceBlock:', e);
    return '';
  }
}