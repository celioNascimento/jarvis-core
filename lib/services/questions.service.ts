// lib/services/questions.service.ts
import { supabase } from '@/lib/jarvis';

export async function getPendingQuestion(userId: string): Promise<{ question: string | null; context: any }> {
  try {
    const { data } = await supabase
      .from('users')
      .select('pending_question, pending_context')
      .eq('id', userId)
      .maybeSingle();

    return {
      question: data?.pending_question || null,
      context: data?.pending_context || null
    };
  } catch {
    return { question: null, context: null };
  }
}

export async function setPendingQuestion(userId: string, question: string | null, context: any = null): Promise<void> {
  try {
    await supabase
      .from('users')
      .update({
        pending_question: question,
        pending_context: context
      })
      .eq('id', userId);
  } catch (e) {
    console.error("[PendingQuestion] Erro setPendingQuestion:", e);
  }
}

export async function clearPendingQuestion(userId: string): Promise<void> {
  await setPendingQuestion(userId, null, null);
}
