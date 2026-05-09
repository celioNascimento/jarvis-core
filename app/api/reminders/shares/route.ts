import { NextResponse } from 'next/server';
import { supabase } from '@/lib/jarvis'; // Importando o SEU cliente central

/**
 * Rota para Gerenciamento de Compartilhamento de Lembretes
 * GET: Lista usuários vinculados e o status de compartilhamento
 * POST: Ativa/Desativa o compartilhamento
 */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const reminderId = searchParams.get('reminder_id');

  if (!reminderId) {
    return NextResponse.json({ error: 'reminder_id obrigatório' }, { status: 400 });
  }

  try {
    // Usamos o cabeçalho de autorização para identificar o usuário
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) throw new Error('Usuário não autenticado');

    /**
     * Chamada RPC conforme configuramos no Postgres.
     * Note que usamos o supabase.rpc para bater na função jarvis.get_reminder_share_options
     */
    const { data: options, error: rpcError } = await supabase
      .rpc('get_reminder_share_options', { 
        p_reminder_id: reminderId,
        p_user_id: user.id 
      });

    if (rpcError) throw rpcError;

    return NextResponse.json({ ok: true, options });
  } catch (error: any) {
    console.error('[Reminder Shares GET] Erro:', error.message);
    return NextResponse.json({ error: error.message || 'Falha ao carregar opções' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { reminder_id, shared_with_id, active } = await req.json();

    // 🛡️ Validação de Segurança do Arquiteto
    if (!shared_with_id) {
      console.error('[Reminder Shares POST] Abortado: shared_with_id está nulo ou indefinido.');
      return NextResponse.json({ error: 'ID do destinatário não encontrado na lista.' }, { status: 400 });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) throw new Error('Usuário não autenticado');

    if (active) {
      const { error } = await supabase
        .from('reminder_shares')
        .upsert({ 
          reminder_id, 
          shared_with_id, // Agora garantido que é um BigInt
          active: true 
        }, { onConflict: 'reminder_id, shared_with_id' });

      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('reminder_shares')
        .update({ active: false })
        .match({ reminder_id, shared_with_id });

      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[Reminder Shares POST] Erro:', error.message);
    return NextResponse.json({ error: error.message || 'Falha ao atualizar' }, { status: 500 });
  }
}