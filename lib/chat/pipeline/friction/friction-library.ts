// lib/chat/pipeline/friction/friction-library.ts

/**
 * Biblioteca de Atrito Intelectual
 *
 * Cada entrada é um contraponto curado de um pensador real,
 * indexado por tema e tradição-alvo.
 *
 * Filosofia: compreender ≠ concordar.
 * O Lev não usa isso para atacar a crença do usuário.
 * Usa para testar se ela sobrevive a resistência real.
 *
 * Regra de uso: sempre com referência. Nunca como opinião da IA.
 */

export type FrictionTheme =
  | 'moralidade_sem_deus'
  | 'sofrimento_e_fe'
  | 'familia_e_papeis'
  | 'liberdade_e_identidade'
  | 'justica_e_perdao'
  | 'desapego_e_resignacao'
  | 'verdade_e_convenencia'
  | 'autoridade_e_consciencia'
  | 'amor_e_sacrificio'
  | 'progresso_e_tradicao';

export type FrictionTradition =
  | 'christian'
  | 'buddhist'
  | 'stoic'
  | 'secular_moralist'
  | 'progressive'
  | 'conservative'
  | 'universal'; // desafia qualquer tradição

export interface FrictionEntry {
  id: string;
  theme: FrictionTheme;
  targets: FrictionTradition[];   // tradições que esse contraponto desafia
  author: string;
  work: string;
  year?: string;
  argument: string;               // o argumento resumido, na voz do Lev
  tension: string;                // o que exatamente isso força o usuário a responder
  socratic_question: string;      // a pergunta que o Lev faz ao apresentar
}

export const FRICTION_LIBRARY: FrictionEntry[] = [

  // ─── MORALIDADE SEM DEUS ─────────────────────────────────────────────────

  {
    id: 'dostoevsky_god_morality',
    theme: 'moralidade_sem_deus',
    targets: ['secular_moralist', 'progressive'],
    author: 'Fiódor Dostoiévski',
    work: 'Os Irmãos Karamazov',
    year: '1880',
    argument:
      'Ivan Karamazov coloca o problema com precisão cirúrgica: se Deus não existe, tudo é permitido — ' +
      'não como libertação, mas como colapso da obrigatoriedade moral. ' +
      'A ética secular pressupõe que "tortura de inocentes é errada" é uma verdade objetiva. ' +
      'Mas objetiva para quem, com base em quê?',
    tension:
      'O ateu moralista precisa explicar por que sua moral obriga — não apenas por que ela lhe agrada.',
    socratic_question:
      'Você diz que certos atos são objetivamente errados. Em que você ancora essa objetividade, ' +
      'se não em algo além do consenso humano — que já aprovou escravidão e genocídio?',
  },

  {
    id: 'nietzsche_morality_origin',
    theme: 'moralidade_sem_deus',
    targets: ['christian', 'secular_moralist', 'progressive'],
    author: 'Friedrich Nietzsche',
    work: 'Genealogia da Moral',
    year: '1887',
    argument:
      'Nietzsche argumenta que a moral ocidental — incluindo a secular — é herdeira do cristianismo, ' +
      'e que seus valores de compaixão e igualdade não são "naturais" nem "racionais": ' +
      'são o ressentimento dos fracos institucionalizado como virtude.',
    tension:
      'Se o usuário rejeita o cristianismo mas mantém seus valores, precisa explicar de onde eles vêm ' +
      'e por que sobrevivem sem o fundamento que os gerou.',
    socratic_question:
      'Você rejeita a religião mas defende compaixão, igualdade e proteção dos vulneráveis. ' +
      'Nietzsche chamaria isso de "moral de escravo" disfarçada de razão. O que você responderia a ele?',
  },

  // ─── SOFRIMENTO E FÉ ─────────────────────────────────────────────────────

  {
    id: 'lewis_problem_of_pain',
    theme: 'sofrimento_e_fe',
    targets: ['christian'],
    author: 'C.S. Lewis',
    work: 'O Problema da Dor',
    year: '1940',
    argument:
      'Lewis argumenta que o sofrimento é compatível com um Deus bom — mas não que seja confortável aceitá-lo. ' +
      'Em "A Morte da Esposa", escrito após perder Joy, ele confessa que a fé fácil ' +
      'não sobrevive ao sofrimento real. A fé que resiste é diferente da fé que nunca foi testada.',
    tension:
      'O cristão que nunca revisou sua teologia diante do sofrimento tem uma fé de teoria, não de experiência.',
    socratic_question:
      'Sua fé foi formada em momentos de gratidão ou também sobreviveu a momentos em que Deus pareceu ausente? ' +
      'Esses dois tipos de fé são diferentes?',
  },

  {
    id: 'camus_absurd_revolt',
    theme: 'sofrimento_e_fe',
    targets: ['christian', 'secular_moralist', 'universal'],
    author: 'Albert Camus',
    work: 'O Mito de Sísifo',
    year: '1942',
    argument:
      'Camus propõe que a resposta honesta ao sofrimento não é nem a fé (salto para o absurdo) ' +
      'nem o suicídio, mas a revolta: viver plenamente consciente da ausência de sentido dado. ' +
      '"É preciso imaginar Sísifo feliz." Não resignado — em revolta lúcida.',
    tension:
      'Tanto o crente quanto o ateu tendem a resolver o sofrimento rápido demais: ' +
      'um com "Deus tem um plano", outro com "é só bioquímica". Camus diz que ambos estão fugindo.',
    socratic_question:
      'Quando você encontra sofrimento sem explicação, qual é seu primeiro movimento — ' +
      'buscar um sentido, ou consegue ficar com a pergunta aberta sem precisar fechá-la?',
  },

  // ─── FAMÍLIA E PAPÉIS ─────────────────────────────────────────────────────

  {
    id: 'chesterton_feminism_paradox',
    theme: 'familia_e_papeis',
    targets: ['progressive', 'christian'],
    author: 'G.K. Chesterton',
    work: 'O que há de errado com o mundo',
    year: '1910',
    argument:
      'Chesterton argumenta que o feminismo moderno, ao libertar a mulher do lar para o mercado, ' +
      'não a libertou — apenas trocou um senhor (o marido) por outro (o empregador). ' +
      'A domesticidade, diz ele, era o único domínio onde a mulher governava com autonomia real.',
    tension:
      'O argumento não é conservador por nostalgia — é uma crítica ao capitalismo embutida numa posição ' +
      'que parece reacionária. Obriga tanto progressistas quanto conservadores a pensar mais fundo.',
    socratic_question:
      'A liberdade que o mercado de trabalho oferece à mulher é autonomia real ou apenas ' +
      'uma forma diferente de dependência? Como você distingue as duas?',
  },

  {
    id: 'paul_ephesians_mutual',
    theme: 'familia_e_papeis',
    targets: ['christian'],
    author: 'Apóstolo Paulo',
    work: 'Carta aos Efésios 5:22-33',
    year: 'c. 60 d.C.',
    argument:
      'O texto que ordena submissão da esposa ao marido é precedido por "submetam-se uns aos outros" (v.21) ' +
      'e imediatamente seguido de uma exigência ainda maior ao marido: amar a esposa como Cristo amou a igreja — ' +
      'isto é, dar a vida por ela. O texto é uma estrutura de sacrifício mútuo, não de hierarquia unilateral.',
    tension:
      'Cristãos que citam a submissão feminina sem citar o custo masculino equivalente ' +
      'estão lendo metade do texto e ignorando a outra — exatamente o tipo de seletividade que o sistema aponta.',
    socratic_question:
      'Você está disposto a carregar o peso completo do que esse texto exige de você, ' +
      'ou está mais familiarizado com a parte que se aplica ao outro?',
  },

  // ─── LIBERDADE E IDENTIDADE ───────────────────────────────────────────────

  {
    id: 'scruton_identity_heritage',
    theme: 'liberdade_e_identidade',
    targets: ['progressive', 'secular_moralist'],
    author: 'Roger Scruton',
    work: 'O Rosto de Deus / Conservadorismo',
    year: '2012',
    argument:
      'Scruton argumenta que identidade sem herança é identidade sem substância. ' +
      'O "eu autêntico" que se reinventa completamente, rejeitando família, tradição e lugar, ' +
      'não é mais livre — é mais vazio. A liberdade real é exercida dentro de vínculos, não apesar deles.',
    tension:
      'O progressista que rejeita toda tradição como opressão precisa explicar ' +
      'em que ancorar a identidade que sobra.',
    socratic_question:
      'Das heranças que você recebeu — família, cultura, fé, comunidade — ' +
      'quais você rejeitou por serem genuinamente ruins, e quais rejeitou por serem inconvenientes?',
  },

  {
    id: 'frankl_freedom_responsibility',
    theme: 'liberdade_e_identidade',
    targets: ['progressive', 'secular_moralist', 'universal'],
    author: 'Viktor Frankl',
    work: 'Em Busca de Sentido',
    year: '1946',
    argument:
      'Frankl, sobrevivente de Auschwitz, argumenta que a liberdade humana não é liberdade de circunstâncias, ' +
      'mas liberdade de escolher a própria resposta a elas. ' +
      'Ele propõe que a Estátua da Liberdade na costa Leste deveria ser complementada por ' +
      'uma Estátua da Responsabilidade na costa Oeste.',
    tension:
      'Quem reivindica liberdade sem responsabilidade equivalente está pedindo metade da condição humana.',
    socratic_question:
      'Quando você reivindica o direito de ser quem é, você carrega igualmente ' +
      'a responsabilidade pelo impacto disso nas pessoas ao seu redor?',
  },

  // ─── JUSTIÇA E PERDÃO ─────────────────────────────────────────────────────

  {
    id: 'arendt_forgiveness_politics',
    theme: 'justica_e_perdao',
    targets: ['christian', 'secular_moralist', 'universal'],
    author: 'Hannah Arendt',
    work: 'A Condição Humana',
    year: '1958',
    argument:
      'Arendt argumenta que o perdão é o único ato capaz de quebrar a cadeia infinita de consequências ' +
      'de um erro — mas que perdão não significa impunidade. ' +
      'É possível perdoar o agente sem absolver o ato. ' +
      'Sem essa distinção, ou você se destrói no ressentimento ou você normaliza o erro.',
    tension:
      'O crente que não perdoa aplica só parte da sua teologia. ' +
      'O secular que confunde perdão com fraqueza perde a ferramenta mais poderosa de libertação pessoal.',
    socratic_question:
      'Quando você não perdoa alguém, quem está pagando o custo maior — você ou ela?',
  },

  // ─── DESAPEGO E RESIGNAÇÃO ────────────────────────────────────────────────

  {
    id: 'nietzsche_buddhism_nihilism',
    theme: 'desapego_e_resignacao',
    targets: ['buddhist'],
    author: 'Friedrich Nietzsche',
    work: 'A Vontade de Poder / Além do Bem e do Mal',
    year: '1886',
    argument:
      'Nietzsche via o budismo com respeito e suspeita simultâneos. ' +
      'Respeito porque é honesto sobre o sofrimento. Suspeita porque o desapego ' +
      'pode ser uma forma sofisticada de escapismo — a vontade de potência disfarçada de iluminação.',
    tension:
      'O praticante budista precisa distinguir entre desapego genuíno ' +
      'e resignação emocional que usa vocabulário espiritual.',
    socratic_question:
      'Quando você pratica desapego, você está genuinamente livre do resultado, ' +
      'ou está protegendo a si mesmo da dor de querer e não ter?',
  },

  {
    id: 'marcus_aurelius_action',
    theme: 'desapego_e_resignacao',
    targets: ['stoic', 'buddhist'],
    author: 'Marco Aurélio',
    work: 'Meditações',
    year: 'c. 170 d.C.',
    argument:
      'O estoicismo de Marco Aurélio não é passividade. É ação máxima dentro do que depende de você, ' +
      'combinada com indiferença ao que não depende. ' +
      'Ele governou um império enquanto praticava desapego — não se retirou para uma caverna.',
    tension:
      'O estoico que usa "isso não depende de mim" para evitar ação difícil ' +
      'está corrompendo a filosofia que diz seguir.',
    socratic_question:
      'O que na sua vida você está rotulando de "fora do meu controle" ' +
      'que na verdade está apenas fora da sua zona de conforto?',
  },

  // ─── VERDADE E CONVENIÊNCIA ───────────────────────────────────────────────

  {
    id: 'solzhenitsyn_lie',
    theme: 'verdade_e_convenencia',
    targets: ['universal'],
    author: 'Aleksandr Soljenítsin',
    work: 'Discurso do Nobel / Não Viver pela Mentira',
    year: '1970',
    argument:
      'Soljenítsin argumenta que a cumplicidade com a mentira — mesmo o silêncio conveniente — ' +
      'é uma escolha moral. "Não viver pela mentira" não exige heroísmo: ' +
      'exige apenas recusar-se a repetir o que você sabe que é falso.',
    tension:
      'Toda tradição séria exige veracidade. Mas a maioria das pessoas omite verdades ' +
      'por medo de rejeição, conflito ou custo social — e chama isso de "tato".',
    socratic_question:
      'Tem alguma verdade que você sabe, que importa para alguém próximo, ' +
      'que você está adiando dizer? Qual é o custo real de continuar adiando?',
  },

  {
    id: 'pascal_wager_honest',
    theme: 'verdade_e_convenencia',
    targets: ['christian', 'secular_moralist'],
    author: 'Blaise Pascal',
    work: 'Pensamentos',
    year: '1670',
    argument:
      'A aposta de Pascal é conhecida como argumento para a fé. ' +
      'Menos citado: Pascal também diz que a maioria das pessoas não crê ou descrê por razão — ' +
      'mas por conveniência social, medo, e costume. ' +
      '"A maioria dos cristãos não acredita no cristianismo — age como se acreditasse."',
    tension:
      'Tanto o crente por costume quanto o ateu por rebeldia estão evitando o mesmo trabalho: ' +
      'examinar genuinamente o que acreditam e por quê.',
    socratic_question:
      'Se você soubesse que não haveria consequência social nenhuma — nem aprovação nem rejeição — ' +
      'você acreditaria no mesmo que acredita hoje?',
  },

  // ─── PROGRESSO E TRADIÇÃO ─────────────────────────────────────────────────

  {
    id: 'chesterton_fence',
    theme: 'progresso_e_tradicao',
    targets: ['progressive', 'universal'],
    author: 'G.K. Chesterton',
    work: 'The Thing',
    year: '1929',
    argument:
      'Se você encontra uma cerca no meio do campo e não sabe por que foi construída, ' +
      'não a derrube — descubra primeiro. ' +
      'Tradições sobrevivem porque resolveram problemas que talvez você tenha esquecido. ' +
      'Destruir sem compreender é arrogância disfarçada de progresso.',
    tension:
      'O progressista que rejeita tradições sem entendê-las comete o mesmo erro ' +
      'que o conservador que as mantém sem revisá-las.',
    socratic_question:
      'Das tradições que você rejeita, quantas você entende bem o suficiente ' +
      'para criticar com precisão — e quantas você rejeita porque são associadas ' +
      'a pessoas de quem discorda?',
  },

  {
    id: 'burke_reform_continuity',
    theme: 'progresso_e_tradicao',
    targets: ['progressive', 'conservative'],
    author: 'Edmund Burke',
    work: 'Reflexões sobre a Revolução na França',
    year: '1790',
    argument:
      'Burke argumenta que mudança social sem continuidade é destruição, não progresso. ' +
      'A sociedade é um contrato entre os mortos, os vivos e os ainda não nascidos. ' +
      'Reformar sem respeitar essa herança é hipotecar o futuro para pagar a ideologia presente.',
    tension:
      'O progressista ignora os mortos. O conservador ignora os não nascidos. ' +
      'Ambos rompem o contrato por razões opostas.',
    socratic_question:
      'Nas mudanças que você defende, o que você está preservando além do que está transformando?',
  },
];

/**
 * Busca contrapontos relevantes para o contexto atual
 */
export function findFrictionEntries(
  themes: FrictionTheme[],
  tradition: string,
  limit = 2
): FrictionEntry[] {
  const scored = FRICTION_LIBRARY.map(entry => {
    let score = 0;
    if (themes.includes(entry.theme)) score += 2;
    if (entry.targets.includes(tradition as FrictionTradition)) score += 2;
    if (entry.targets.includes('universal')) score += 1;
    return { entry, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}