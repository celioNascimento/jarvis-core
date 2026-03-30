// lib/chat/search-router.ts
import type { ContextType } from './context-classifier';

export function shouldForceSearch(message: string, contexts: ContextType[]): boolean {
  const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const personalKeywords =
    /\b(eu|meu|minha|meus|minhas|comecei|trabalhei|trabalho|nasci|moro|morei|casei|tive|tenho|familia|esposa|marido|filho|filha|minha vida|meu trabalho|minha historia|quando comecei|quando fui|quando entrei)\b/i;

  if (personalKeywords.test(lower)) {
    console.log('[shouldForceSearch] Frase pessoal — sem busca web.');
    return false;
  }

  const keywords =
    /\b(jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|copa do brasil|classificacao|tabela|artilheiro|resultado|placar|hoje tem|proximo|escalacao|expo|feira|comeca|inicio|data de|horario de|edicao|noticia|ultimas|recente|aconteceu|clima|temperatura|chuva|chover|previsao|cotacao|preco do|valor do|dolar|euro|bitcoin|ibovespa)\b/i;

  if (keywords.test(lower)) {
    console.log('[shouldForceSearch] Palavra-chave externa — forçando busca');
    return true;
  }

  if (/(qual e|como esta|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser)/i.test(lower)) {
    console.log('[shouldForceSearch] Domínio externo — forçando busca');
    return true;
  }

  return false;
}

export function refineSearchQuery(message: string, contexts: ContextType[]): string {
  let query = message.trim();

  if (contexts.includes('esporte')) {
    const cleanMsg = message
      .replace(/^(quando é|quando e|qual o|qual e|quem joga|onde e|onde vai ser)\s+/i, '')
      .trim();
    query = `${cleanMsg} 2026`.replace(/\?+/g, '');
    if (
      !query.toLowerCase().includes('jogo') &&
      !query.toLowerCase().includes('escalação') &&
      !query.toLowerCase().includes('próximo') &&
      !query.toLowerCase().includes('data') &&
      !query.toLowerCase().includes('horário')
    ) {
      query = `próximo jogo ${query}`;
    }
  } else if (contexts.includes('evento') && /expo|feira|evento|começa|início/i.test(message)) {
    query = `${message} ${new Date().getFullYear()}`.replace(/\?+/g, '');
  } else if (contexts.includes('clima')) {
    const locationMatch = message.match(/(em|no|na) (.*?)(?:\?|$)/i);
    query = locationMatch && locationMatch[2].trim().length < 30
      ? `clima ${locationMatch[2].trim()}`
      : `clima ${message}`.replace(/\?+/g, '');
  } else if (contexts.includes('noticias') && !/(notícia|notícias)/i.test(query)) {
    query = `últimas notícias ${query}`;
  }

  return query.trim();
}