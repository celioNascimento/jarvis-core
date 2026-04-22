// lib/finances/types.ts
// Tipos centrais do módulo de finanças

export type TransactionType = 'expense' | 'income' | 'transfer_out' | 'transfer_in';
export type TransactionStatus = 'pending' | 'confirmed' | 'ignored' | 'duplicate';
export type TransactionSource = 'notification' | 'bank_statement' | 'manual' | 'open_banking';
export type AccountType = 'checking' | 'savings' | 'credit_card';

export interface UserAccount {
  id: string;
  user_id: string;
  jarvis_user_id: number;
  bank_name: string;
  account_label: string | null;
  account_last_digits: string | null;
  account_type: AccountType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string | null; // null = global
  name: string;
  icon: string | null;
  color: string | null;
  parent_id: string | null;
  type: TransactionType | null;
  created_at: string;
}

export interface Transaction {
  id: number;
  user_id: string;
  jarvis_user_id: number;
  amount: number;
  type: TransactionType;
  description: string | null;
  transaction_date: string;
  category_id: string | null;
  merchant: string | null;
  merchant_normalized: string | null;
  user_account_id: string | null;
  source: TransactionSource;
  source_id: string | null;
  raw_data: Record<string, any> | null;
  status: TransactionStatus;
  confirmed_at: string | null;
  confidence: number | null;
  linked_transaction_id: number | null;
  created_at: string;
  updated_at: string;
  // joins
  category?: Category;
  user_account?: UserAccount;
}

export interface Budget {
  id: string;
  user_id: string;
  jarvis_user_id: number;
  category_id: string;
  amount: number;
  period_start: string;
  period_end: string;
  shared_with: string[];
  owner_controls: { can_edit: boolean };
  created_at: string;
  updated_at: string;
  // joins
  category?: Category;
}

export interface BudgetAlert {
  id: string;
  budget_id: string;
  threshold_percent: number;
  alerted_at: string;
}

export interface BudgetWithUsage extends Budget {
  spent: number;
  percent_used: number;
  remaining: number;
  alert_triggered: boolean;
}

export interface FinanceSummary {
  period_start: string;
  period_end: string;
  total_income: number;
  total_expense: number;
  balance: number;
  by_category: Array<{
    category_id: string;
    category_name: string;
    category_icon: string | null;
    category_color: string | null;
    total: number;
    count: number;
    percent_of_expenses: number;
  }>;
  by_day: Array<{
    date: string;
    income: number;
    expense: number;
  }>;
  pending_count: number;
}

// Payload para criar transação via chat
export interface CreateTransactionPayload {
  amount: number;
  type: TransactionType;
  description?: string;
  transaction_date?: string; // ISO date, default hoje
  category_name?: string;
  merchant?: string;
  account_label?: string;
  source?: TransactionSource;
}

// Payload para consulta via chat
export interface FinanceQueryPayload {
  period?: 'today' | 'week' | 'month' | 'last_month' | 'year';
  category?: string;
  type?: TransactionType;
  limit?: number;
}