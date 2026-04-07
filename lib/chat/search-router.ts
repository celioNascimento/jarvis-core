// lib/chat/search-router.ts
import type { ContextType } from './context-classifier';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Compilado uma vez no load — sem custo por request
const PERSONAL_KW = new RegExp(
  norm('\\b(eu|meu|minha|meus|minhas|comecei|trabalhei|trabalho|nasci|moro|morei|casei|tive|tenho|familia|esposa|marido|filho|filha|minha vida|meu trabalho|minha historia|quando comecei|quando fui|quando entrei)\\b'),
  'i'
);

const EXTERNAL_KW = new RegExp(
  norm('\\b(jogo|partida|futebol|basquete|volei|tenis|f1|corrida|campeonato|copa|libertadores|copa do brasil|classificacao|tabela|artilheiro|resultado|placar|hoje tem|proximo|escalacao|expo|feira|comeca|inicio|data de|horario de|edicao|noticia|ultimas|recente|aconteceu|clima|temperatura|chuva|chover|previsao|vai chover|como esta o tempo|cotacao|preco do|valor do|dolar|euro|bitcoin|ibovespa)\\b'),
  'i'
);

const EXTERNAL_PHRASE = new RegExp(
  norm('(qual e|como esta|como fica|o que aconteceu|o que rolou|vai chover|vai ter|como vai ser|como vai ficar o tempo|previsao do tempo|tempo em|clima em|temperatura em)'),
  'i'
);

export function shouldForceSearch(message: string, contexts: ContextType[]): boolean {
  const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (PERSONAL_KW.test(lower)) {
    console.log('[shouldForceSearch] Frase pessoal — sem busca web.');
    return false;
  }

  if (EXTERNAL_KW.test(lower)) {
    console.log('[shouldForceSearch] Palavra-chave externa — forçando busca');
    return true;
  }

  if (EXTERNAL_PHRASE.test(lower)) {
    console.log('[shouldForceSearch] Domínio externo — forçando busca');
    return true;
  }

  // Fallback por contexto detectado (cobre casos onde regex não capturou mas L4 classificou)
  if (contexts.includes('clima') || contexts.includes('esporte') || contexts.includes('noticias')) {
    console.log('[shouldForceSearch] Contexto de busca detectado — forçando busca');
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
    const locationMatch = message.match(/(em|no|na)\s+([\w\s]{2,30})(?:\?|$)/i);
    query = locationMatch
      ? `clima ${locationMatch[2].trim()}`
      : `previsão do tempo ${message}`.replace(/\?+/g, '');
  } else if (contexts.includes('noticias') && !/(notícia|notícias)/i.test(query)) {
    query = `últimas notícias ${query}`;
  }

  return query.trim();
}
