// lib/finances/executor.ts
// Executor das ferramentas de finanças — integra com tools-executor.ts
// Adicionar o switch case correspondente em lib/chat/tools-executor.ts

import {
  createTransaction,
  getFinanceSummary,
  getTransactions,
  getBudgetsWithUsage,
  createBudget,
  resolveCategoryId,
  getPeriodDates,
} from './db';
import type { CreateTransactionPayload, TransactionType, FinanceQueryPayload } from './types';

const fmt = (n: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

// ─── registrar_transacao ──────────────────────────────────────────────────────
export async function executeRegistrarTransacao(
  args: CreateTransactionPayload,
  authUserId: string,
  jarvisUserId: string
): Promise<string> {
  try {
    const numericId = parseInt(jarvisUserId, 10);
    if (isNaN(numericId)) return JSON.stringify({ error: 'ID de usuário inválido.' });

    if (!args.amount || args.amount <= 0)
      return JSON.stringify({ error: 'Valor inválido. O valor deve ser positivo.' });

    const tx = await createTransaction(authUserId, numericId, args);

    const typeLabel: Record<TransactionType, string> = {
      expense: 'Despesa',
      income: 'Receita',
      transfer_out: 'Transferência (saída)',
      transfer_in: 'Transferência (entrada)',
    };

    const catName = (tx as any).category?.name || args.category_name || null;
    const accountLabel = (tx as any).user_account
      ? `${(tx as any).user_account.bank_name}${(tx as any).user_account.account_last_digits ? ` ****${(tx as any).user_account.account_last_digits}` : ''}`
      : null;

    const result = {
      ok: true,
      id: tx.id,
      message:
        `${typeLabel[tx.type]} de ${fmt(tx.amount)} registrada com sucesso.` +
        (catName ? ` Categoria: ${catName}.` : '') +
        (accountLabel ? ` Conta: ${accountLabel}.` : '') +
        (tx.merchant ? ` Estabelecimento: ${tx.merchant}.` : ''),
      transaction: {
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        description: tx.description,
        date: tx.transaction_date,
        category: catName,
        merchant: tx.merchant,
        status: tx.status,
      },
    };

    return JSON.stringify(result);
  } catch (e: any) {
    console.error('[Finance] executeRegistrarTransacao:', e);
    return JSON.stringify({ error: e.message || 'Erro ao registrar transação.' });
  }
}

// ─── consultar_financas ───────────────────────────────────────────────────────
export async function executeConsultarFinancas(
  args: FinanceQueryPayload,
  authUserId: string,
  jarvisUserId: string
): Promise<string> {
  try {
    const numericId = parseInt(jarvisUserId, 10);
    if (isNaN(numericId)) return JSON.stringify({ error: 'ID de usuário inválido.' });

    const period = args.period || 'month';
    const summary = await getFinanceSummary(numericId, period);

    const periodLabel: Record<string, string> = {
      today: 'hoje',
      week: 'esta semana',
      month: 'este mês',
      last_month: 'mês passado',
      year: 'este ano',
    };

    // Transações recentes (até 5)
    const { start, end } = getPeriodDates(period);
    let txFilter: any = { start, end, limit: 5 };
    if (args.type) txFilter.type = args.type;
    if (args.category) {
      const catId = await resolveCategoryId(authUserId, args.category);
      if (catId) txFilter.category_id = catId;
    }
    const recentTxs = await getTransactions(numericId, txFilter);

    const result = {
      ok: true,
      period: periodLabel[period] || period,
      summary: {
        income: fmt(summary.total_income),
        expense: fmt(summary.total_expense),
        balance: fmt(summary.balance),
        balance_positive: summary.balance >= 0,
        pending_count: summary.pending_count,
      },
      top_categories: summary.by_category.slice(0, 5).map((c) => ({
        name: c.category_name,
        total: fmt(c.total),
        percent: `${c.percent_of_expenses}%`,
      })),
      recent_transactions: recentTxs.slice(0, 5).map((t) => ({
        date: t.transaction_date,
        description: t.description || t.merchant || '—',
        amount: fmt(t.amount),
        type: t.type,
        category: (t as any).category?.name || 'Sem categoria',
        status: t.status,
      })),
      message:
        `Resumo ${periodLabel[period]}: ` +
        `Receitas ${fmt(summary.total_income)}, ` +
        `Despesas ${fmt(summary.total_expense)}, ` +
        `Saldo ${fmt(summary.balance)}` +
        (summary.pending_count > 0 ? `. ⏳ ${summary.pending_count} transação(ões) aguardando confirmação.` : '.'),
    };

    return JSON.stringify(result);
  } catch (e: any) {
    console.error('[Finance] executeConsultarFinancas:', e);
    return JSON.stringify({ error: e.message || 'Erro ao consultar finanças.' });
  }
}

// ─── criar_orcamento ──────────────────────────────────────────────────────────
export async function executeCriarOrcamento(
  args: { category_name: string; amount: number },
  authUserId: string,
  jarvisUserId: string
): Promise<string> {
  try {
    const numericId = parseInt(jarvisUserId, 10);
    if (isNaN(numericId)) return JSON.stringify({ error: 'ID de usuário inválido.' });

    if (!args.amount || args.amount <= 0)
      return JSON.stringify({ error: 'Valor do orçamento deve ser positivo.' });

    const budget = await createBudget(authUserId, numericId, args.category_name, args.amount, 'month');

    return JSON.stringify({
      ok: true,
      message: `Orçamento de ${fmt(args.amount)} criado para ${(budget as any).category?.name || args.category_name} em ${new Date(budget.period_start).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}.`,
      budget: {
        id: budget.id,
        category: (budget as any).category?.name || args.category_name,
        amount: fmt(budget.amount),
        period: `${budget.period_start} → ${budget.period_end}`,
      },
    });
  } catch (e: any) {
    console.error('[Finance] executeCriarOrcamento:', e);
    return JSON.stringify({ error: e.message || 'Erro ao criar orçamento.' });
  }
}

// ─── listar_orcamentos ────────────────────────────────────────────────────────
export async function executeListarOrcamentos(
  authUserId: string,
  jarvisUserId: string
): Promise<string> {
  try {
    const numericId = parseInt(jarvisUserId, 10);
    if (isNaN(numericId)) return JSON.stringify({ error: 'ID de usuário inválido.' });

    const budgets = await getBudgetsWithUsage(numericId, authUserId);

    if (!budgets.length) {
      return JSON.stringify({
        ok: true,
        message: 'Nenhum orçamento cadastrado para este mês.',
        budgets: [],
      });
    }

    const budgetList = budgets.map((b) => ({
      category: (b as any).category?.name || 'Categoria',
      limit: fmt(b.amount),
      spent: fmt(b.spent),
      remaining: fmt(b.remaining),
      percent_used: b.percent_used,
      alert: b.alert_triggered,
      status:
        b.percent_used >= 100 ? '🔴 Estourado' :
        b.percent_used >= 80 ? '🟡 Atenção' :
        '🟢 OK',
    }));

    const overBudget = budgets.filter((b) => b.percent_used >= 100);
    const nearLimit = budgets.filter((b) => b.percent_used >= 80 && b.percent_used < 100);

    let message = `${budgets.length} orçamento(s) este mês.`;
    if (overBudget.length > 0)
      message += ` 🔴 ${overBudget.length} estourado(s): ${overBudget.map((b) => (b as any).category?.name).join(', ')}.`;
    if (nearLimit.length > 0)
      message += ` 🟡 ${nearLimit.length} próximo(s) do limite: ${nearLimit.map((b) => (b as any).category?.name).join(', ')}.`;

    return JSON.stringify({ ok: true, message, budgets: budgetList });
  } catch (e: any) {
    console.error('[Finance] executeListarOrcamentos:', e);
    return JSON.stringify({ error: e.message || 'Erro ao listar orçamentos.' });
  }
}