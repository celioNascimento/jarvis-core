import { supabase, callOpenRouter } from '@/lib/jarvis';

// ============================================================
// lib/onboarding.ts
// Motor de onboarding conversacional
//
// Funciona em paralelo à conversa normal — o Lev responde
// normalmente e quando surge uma deixa natural, coleta info
// sem parecer formulário
// ============================================================

export interface OnboardingState {
  status: 'in_progress' | 'paused' | 'completed' | 'skipped';
  collected: string[];
  pending: string[];
  next_field: string | null;
  collected_data: Record<string, any>;
  interruptions: number;
}

// Campos do onboarding em ordem de prioridade
const ONBOARDING_FIELDS = [
  'nome',
  'cidade',
  'nascimento',
  'familia_origem',
  'filhos',
  'profissao',
  'rotina',
  'fe',
  'objetivos'
];

// ============================================================
// Busca o estado atual do onboarding
// ============================================================
export async function getOnboardingState(userId: string): Promise<OnboardingState | null> {
  try {
    const { data } = await supabase
      .from('onboarding_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!data) return null;
    return data as OnboardingState;

  } catch {
    return null;
  }
}

// ============================================================
// Inicializa o onboarding para um novo usuário
// ============================================================
export async function initOnboarding(userId: string): Promise<OnboardingState> {
  const initial: Partial<OnboardingState> = {
    status: 'in_progress',
    collected: [],
    pending: [...ONBOARDING_FIELDS],
    next_field: 'nome',
    collected_data: {},
    interruptions: 0
  };

  await supabase
    .from('onboarding_progress')
    .upsert({ user_id: userId, ...initial })
    .eq('user_id', userId);

  return initial as OnboardingState;
}

// ============================================================
// Processa a mensagem e extrai informações de onboarding
// Chamado após a resposta da IA — analisa o que foi dito
// e salva o que foi coletado naturalmente
// ============================================================
export async function processOnboardingFromMessage(
  userId: string,
  userMessage: string,
  aiReply: string,
  state: OnboardingState
): Promise<OnboardingState> {

  if (state.status === 'completed' || state.status === 'skipped') return state;

  // Usa a IA para extrair informações da mensagem
  const extractPrompt = `
Analise esta mensagem e extraia informações pessoais mencionadas.
Retorne APENAS um JSON válido, sem explicações.

MENSAGEM DO USUÁRIO: "${userMessage}"
RESPOSTA DO ASSISTENTE: "${aiReply}"

CAMPOS QUE ESTAMOS COLETANDO: ${state.pending.join(', ')}

Extraia APENAS o que foi mencionado explicitamente. Retorne:
{
  "extraido": {
    "filhos": [{"nome": "...", "idade": 5}, {"nome": "...", "idade": 3}],
    "cidade": "...",
    "nome": "...",
    "nascimento": "...",
    "profissao": "...",
    "fe": "...",
    "familia_origem": "...",
    "rotina": "...",
    "objetivos": "..."
  },
  "campos_coletados": ["filhos"]
}

Retorne apenas os campos que foram CLARAMENTE mencionados.
Se nenhum campo foi mencionado, retorne: {"extraido": {}, "campos_coletados": []}
`;

  try {
    const raw = await callOpenRouter(extractPrompt);
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.campos_coletados?.length) return state;

    // Atualiza o estado com o que foi coletado
    const newCollected = [...new Set([...state.collected, ...parsed.campos_coletados])];
    const newPending = state.pending.filter(f => !newCollected.includes(f));
    const newData = { ...state.collected_data, ...parsed.extraido };

    const updatedState: OnboardingState = {
      ...state,
      collected: newCollected,
      pending: newPending,
      next_field: newPending[0] || null,
      collected_data: newData,
      status: newPending.length === 0 ? 'completed' : 'in_progress'
    };

    // Salva no banco
    await supabase
      .from('onboarding_progress')
      .update({
        collected: updatedState.collected,
        pending: updatedState.pending,
        next_field: updatedState.next_field,
        collected_data: updatedState.collected_data,
        status: updatedState.status,
        updated_at: new Date().toISOString(),
        ...(updatedState.status === 'completed'
          ? { completed_at: new Date().toISOString() }
          : {})
      })
      .eq('user_id', userId);

    // Se coletou algo, salva no user_profiles também
    if (parsed.campos_coletados.length > 0) {
      await syncToUserProfile(userId, parsed.extraido);
    }

    // Se completou, consolida no dossiê L3
    if (updatedState.status === 'completed') {
      await consolidateOnboardingToDossie(userId, updatedState.collected_data);
    }

    console.log(`[Onboarding] Coletou: ${parsed.campos_coletados.join(', ')} | Falta: ${newPending.join(', ')}`);
    return updatedState;

  } catch (e) {
    console.error('[Onboarding] Erro ao extrair:', e);
    return state;
  }
}

// ============================================================
// Gera o bloco de onboarding para o prompt do webhook
// Instrui o Lev a aproveitar deixas naturais
// ============================================================
export function buildOnboardingBlock(state: OnboardingState): string {
  if (state.status === 'completed' || state.status === 'skipped') return '';

  const collected = state.collected.length > 0
    ? `Já sei: ${state.collected.join(', ')}`
    : 'Ainda não coletei nenhuma informação';

  const pending = state.pending.length > 0
    ? `Ainda preciso saber: ${state.pending.join(', ')}`
    : '';

  const nextHint = getNextFieldHint(state.next_field);

  return `
[MODO ONBOARDING ATIVO]
${collected}
${pending}

PRÓXIMA INFORMAÇÃO A COLETAR: ${state.next_field || 'nenhuma'}
${nextHint}

REGRAS DO ONBOARDING:
- Responda normalmente primeiro. O onboarding é SECUNDÁRIO.
- Se a conversa criar uma abertura natural, colete a próxima informação.
- NUNCA interrompa uma conversa em andamento para perguntar sobre onboarding.
- Se o usuário mencionar algo da lista "ainda preciso saber", registre sem perguntar explicitamente.
- Máximo de UMA coleta por resposta.
- Se já souber algo, NUNCA pergunte de novo.
`.trim();
}

// ============================================================
// Dicas de como coletar cada campo naturalmente
// ============================================================
function getNextFieldHint(field: string | null): string {
  const hints: Record<string, string> = {
    'nome':
      'Se ainda não sei o nome, apresente-se e pergunte como a pessoa quer ser chamada.',
    'cidade':
      'Se surgir contexto geográfico (clima, trânsito, lugar), pergunte onde mora.',
    'nascimento':
      'Se falar de idade, aniversário ou memória de infância, pergunte quando nasceu.',
    'filhos':
      'Se mencionar crianças, escola, brincadeiras — pergunte se tem filhos e quantos.',
    'familia_origem':
      'Se falar de família, pais, infância — pergunte de onde é a família.',
    'profissao':
      'Se falar de trabalho, rotina, dinheiro — pergunte o que faz.',
    'rotina':
      'Após saber a profissão, pergunte como é o dia a dia.',
    'fe':
      'No final da entrevista, pergunte suavemente: "Fé faz parte da sua vida de alguma forma?"',
    'objetivos':
      'Se falar de planos, sonhos, futuro — pergunte o que quer conquistar.',
  };
  return field ? (hints[field] || '') : '';
}

// ============================================================
// Sincroniza dados coletados com user_profiles
// ============================================================
async function syncToUserProfile(userId: string, data: Record<string, any>) {
  const profileUpdate: Record<string, any> = {};

  if (data.cidade)         profileUpdate.city = data.cidade;
  if (data.nascimento)     profileUpdate.birth_date = data.nascimento;
  if (data.profissao)      profileUpdate.current_job = data.profissao;
  if (data.fe)             profileUpdate.faith_profile = parseFaithProfile(data.fe);
  if (data.familia_origem) profileUpdate.birth_city = data.familia_origem;

  if (Object.keys(profileUpdate).length === 0) return;

  profileUpdate.updated_at = new Date().toISOString();

  await supabase
    .from('user_profiles')
    .upsert({ user_id: userId, ...profileUpdate })
    .eq('user_id', userId);

  // Salva filhos se mencionados
  if (data.filhos && Array.isArray(data.filhos)) {
    for (const filho of data.filhos) {
      if (!filho.nome && !filho.idade) continue;

      const lifePhase = getLifePhase(filho.idade);

      await supabase.from('children').upsert({
        parent_id: userId,
        name: filho.nome || 'Filho(a)',
        birth_date: filho.idade
          ? new Date(new Date().getFullYear() - filho.idade, 0, 1).toISOString().split('T')[0]
          : null,
        life_phase: lifePhase,
        updated_at: new Date().toISOString()
      });
    }
  }
}

// ============================================================
// Consolida dados do onboarding no dossiê L3 ao completar
// ============================================================
async function consolidateOnboardingToDossie(
  userId: string,
  data: Record<string, any>
) {
  const prompt = `
Você é o assistente Lev. Com base nas informações coletadas durante o onboarding,
escreva um dossiê pessoal completo e natural sobre o usuário.

Use 3ª pessoa. Seja descritivo mas conciso. Máximo 500 palavras.
Inclua: quem é, família, trabalho, rotina, valores e objetivos.

DADOS COLETADOS:
${JSON.stringify(data, null, 2)}

Retorne APENAS o texto do dossiê, sem título, sem explicações.
`;

  const dossie = await callOpenRouter(prompt);

  await supabase
    .from('users')
    .update({
      current_context: dossie,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId);

  console.log('[Onboarding] Dossiê L3 consolidado com sucesso.');
}

// ============================================================
// HELPERS
// ============================================================
function parseFaithProfile(fe: string): string {
  const f = fe.toLowerCase();
  if (f.includes('cristão') || f.includes('cristã') || f.includes('evangélico') ||
      f.includes('católico') || f.includes('jesus') || f.includes('igreja')) {
    return 'christian_declared';
  }
  if (f.includes('não') || f.includes('nenhuma') || f.includes('ateu')) {
    return 'none';
  }
  return 'open';
}

function getLifePhase(age: number | null): string {
  if (!age) return 'child';
  if (age <= 3)  return 'baby';
  if (age <= 11) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 24) return 'young_adult';
  return 'adult';
}
