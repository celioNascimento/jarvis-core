import { supabase } from '@/lib/jarvis';

// ============================================================
// lib/relationships.ts
// Funções de relacionamento usadas pelo webhook
// Para enriquecer o contexto do Jarvis com dados dos vínculos
// ============================================================

// Busca vínculos ativos e o contexto que cada um compartilha
export async function getRelationshipContext(userId: string): Promise<string> {
  try {
    const { data: relationships } = await supabase.rpc('get_user_relationships', {
      p_user_id: parseInt(userId)
    });

    if (!relationships || relationships.length === 0) return '';

    // Monta contexto de vínculos para o prompt
    const lines = relationships.map((r: any) => {
      const name = r.other_nickname || r.other_user_name;
      return `- ${name}: ${r.my_type} (intensidade: ${r.intensity?.toFixed(2)}, privacidade nível ${r.privacy_level})`;
    });

    return `[VÍNCULOS ATIVOS]\n${lines.join('\n')}`;

  } catch (e) {
    console.error('getRelationshipContext erro:', e);
    return '';
  }
}

// Verifica se o Jarvis pode compartilhar uma info com outro usuário
export async function canShare(
  fromUserId: string,
  toUserId: string,
  permission: string
): Promise<boolean> {
  try {
    // Busca o vínculo entre os dois
    const { data: rel } = await supabase
      .from('relationships')
      .select('id, status')
      .or(
        `and(user_id_a.eq.${fromUserId},user_id_b.eq.${toUserId}),` +
        `and(user_id_a.eq.${toUserId},user_id_b.eq.${fromUserId})`
      )
      .eq('status', 'active')
      .single();

    if (!rel) return false;

    // Verifica se a permissão específica existe e está ativa
    const { data: perm } = await supabase
      .from('relationship_permissions')
      .select('id')
      .eq('relationship_id', rel.id)
      .eq('granted_by', parseInt(fromUserId))
      .eq('granted_to', parseInt(toUserId))
      .eq('permission', permission)
      .eq('is_active', true)
      .single();

    return !!perm;

  } catch {
    return false;
  }
}

// Aceita convite via mensagem no Telegram
// Chamado pelo webhook quando usuário diz "aceitar vínculo"
export async function acceptRelationshipByMessage(
  userId: string,
  message: string
): Promise<string | null> {
  const match = message.match(/aceitar vínculo/i);
  if (!match) return null;

  try {
    // Busca vínculo pendente onde esse usuário é o convidado
    const { data: pending } = await supabase
      .from('relationships')
      .select('id, user_id_a, type_a, type_b')
      .eq('user_id_b', parseInt(userId))
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!pending) return 'Não encontrei nenhum convite pendente para você.';

    // Aceita o vínculo
    await supabase
      .from('relationships')
      .update({
        status: 'active',
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', pending.id);

    // Notifica quem enviou
    const { data: userInfo } = await supabase
      .from('users')
      .select('nickname, name')
      .eq('id', userId)
      .single();

    const nome = userInfo?.nickname || userInfo?.name || 'Seu contato';

    // Importa sendTelegram aqui para evitar circular dependency
    const { sendTelegram } = await import('./jarvis');
    await sendTelegram(pending.user_id_a, `✅ *${nome}* aceitou seu convite! Vocês agora estão conectados no Lev. 🎉`);

    return `✅ Vínculo aceito! Vocês agora estão conectados no Lev.`;

  } catch (e: any) {
    console.error('acceptRelationshipByMessage erro:', e.message);
    return null;
  }
}
