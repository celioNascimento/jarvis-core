// lib/chat/profile-extractor.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';

export async function extractProfileFromConversation(
  userId: number,
  userMessage: string,
  assistantReply: string
) {
  
  const hasProfileHint = /\b(moro|trabalho|nasci|profiss|cidade|estado|me chamo|apelido|telefone|sou de|meu nome)\b/i
    .test(userMessage + ' ' + assistantReply);
  if (!hasProfileHint || userMessage.trim().length < 30) return;

  const prompt = `
Você é um assistente que aprende sobre o usuário. Extraia do diálogo abaixo informações que possam preencher o perfil do usuário no Lev.

DIÁLOGO:
Usuário: ${userMessage}
Assistente: ${assistantReply}

Retorne APENAS um JSON válido com campos que você consegue inferir. Campos possíveis:
- city (cidade onde mora)
- state (estado, sigla ou nome)
- profession (profissão)
- birth_date (data de nascimento no formato YYYY-MM-DD, apenas se explícita)
- phone (telefone, se mencionado)
- preferred_name (como gosta de ser chamado)
- nickname (apelido)

Se nada for detectado, retorne {}.
  `;

  try {
    const result = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.2);
    const updates = JSON.parse(result);
    if (Object.keys(updates).length) {
      // Atualiza user_profiles
      await supabase
        .from('user_profiles')
        .upsert({ user_id: userId, ...updates }, { onConflict: 'user_id' });
      console.log('[ProfileExtractor] Atualizado perfil:', updates);
    }
  } catch (err) {
    console.warn('[ProfileExtractor] Erro ao extrair:', err);
  }
}