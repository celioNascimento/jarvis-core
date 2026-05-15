// lib/chat/pipeline/extractors/shopping.extractor.ts
// V1.0.1 — Regex corrigida, Number(userId) removido

import { supabase, callOpenRouter } from '@/lib/jarvis';

const CLEAN_JSON = (raw: string) => raw.replace(/```(?:json)?\r?\n?/g, '').trim();

export async function extractShopping(userId: string, userMessage: string, aiReply: string = ''): Promise<void> {
  const prompt = [
    {
      role: 'system',
      content: 'Você é um gerenciador de estoque e compras. Responda EXCLUSIVAMENTE com o objeto JSON estruturado solicitado.',
    },
    {
      role: 'user',
      content: `Extraia itens de compras da mensagem do usuário: "${userMessage}".
${aiReply ? `Contexto da resposta do assistente (use para desmembrar itens específicos): "${aiReply}"` : ''}

[REGRA CRÍTICA]: NUNCA agrupe itens em pacotes genéricos. Extraia item por item individualmente.
Retorne: {"items": [{"item": "nome específico", "category": "mercado|higiene|farmacia|casa|tecnologia|outros"}]}`,
    },
  ];

  try {
    const raw = await callOpenRouter(prompt as any, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));
    if (!parsed?.items || parsed.items.length === 0) return;

    const inserts = parsed.items.map((i: any) => ({
      user_id: userId,
      item: i.item,
      category: i.category || 'outros',
      done: false,
    }));

    await supabase.from('shopping_items').insert(inserts);
  } catch (e) {
    console.error('[Extrator/Shopping] Erro:', e);
  }
}

export async function extractShoppingLinks(userId: string, userMessage: string): Promise<void> {
  const prompt = `Identifique links ou referências comerciais em: "${userMessage}". Retorne: {"links": [{"url": "...", "title": "...", "category": "casa"}]}`;

  try {
    const raw = await callOpenRouter(prompt, 'google/gemini-2.0-flash-001', 0.1, 4);
    const parsed = JSON.parse(CLEAN_JSON(raw));
    if (!parsed?.links) return;

    for (const link of parsed.links) {
      const { data: existing } = await supabase
        .from('shopping_list_metadata')
        .select('links')
        .eq('user_id', userId)
        .eq('category', link.category)
        .maybeSingle();

      const newLinks = [...(existing?.links || []), { url: link.url, title: link.title }];

      await supabase.from('shopping_list_metadata').upsert(
        {
          user_id:    userId,
          category:   link.category,
          links:      newLinks,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,category' }
      );
    }
  } catch (e) {
    console.error('[Extrator/ShoppingLinks] Erro:', e);
  }
}