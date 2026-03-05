// ============================================================
// SYNC: brain → user_profiles + children + relationships + L3
// 
// Como usar:
//   1. Copiar para scripts/syncBrain.ts no projeto
//   2. Rodar: npx ts-node scripts/syncBrain.ts
//
// O que faz:
//   - Lê toda a brain do usuário
//   - Extrai dados estruturados via IA (1 chamada)
//   - Povoa user_profiles, children, relationships
//   - Atualiza current_context (L3) com dossiê completo
//   - Marca onboarding como completed se tiver dados suficientes
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

const USER_ID   = '8595482774';
const USER_NAME = 'Celio';

// ─── 1. BUSCA BRAIN + L3 ATUAL ───────────────────────────────
async function fetchContext() {
  const { data: brain } = await supabase
    .from('brain')
    .select('content, metadata')
    .eq('user_id', USER_ID)
    .order('created_at', { ascending: true });

  const { data: user } = await supabase
    .from('users')
    .select('current_context')
    .eq('id', USER_ID)
    .single();

  return {
    brainText: (brain || []).map(b =>
      `${USER_NAME}: ${b.content}\nLev: ${b.metadata?.ai_reply || ''}`
    ).join('\n\n'),
    currentL3: user?.current_context || ''
  };
}

// ─── 2. EXTRAI DADOS VIA IA ──────────────────────────────────
async function extractFromBrain(brainText: string, currentL3: string): Promise<any> {
  const prompt = `
Você é um extrator de informações pessoais. Analise o histórico de conversa e o dossiê atual e extraia TODOS os dados mencionados.

[DOSSIÊ ATUAL]:
${currentL3}

[HISTÓRICO DE CONVERSA]:
${brainText}

Retorne APENAS um JSON válido com esta estrutura exata (null para campos não encontrados):
{
  "perfil": {
    "nome": "Celio Nascimento",
    "cidade": "Londrina",
    "cidade_origem": "Ibiporã",
    "nascimento": null,
    "profissao": null,
    "novo_emprego": "White Martins",
    "inicio_emprego": "2026-03-12",
    "tdah": true,
    "medico": "Dr. Adriano"
  },
  "esposa": {
    "nome": null,
    "aniversario": "08-05"
  },
  "filhos": [
    { "nome": "Miguel", "idade": 5 },
    { "nome": "Davi",   "idade": 3 },
    { "nome": "Pedro",  "idade": 19 }
  ],
  "rotina": {
    "despertar": "05:00",
    "academia_saida": "06:40",
    "trabalho_entrada": "08:00",
    "trabalho_saida": "17:50",
    "dormir": "21:00",
    "lembretes": ["roupa 18:30", "marmita 20:45"]
  },
  "preferencias": {
    "comunicacao": "informal e curta",
    "feira_produtor": "sábado, Rua São Vicente",
    "pastel_aeroporto": true,
    "filme_recente": "Detona Ralph"
  },
  "projetos": [
    {
      "nome": "Procuro Quem Faça",
      "status": "beta",
      "pendencia": "homologação fluxo reivindicação de perfil",
      "revisao_semanal": "sexta 18h"
    }
  ],
  "fe": null,
  "objetivos": null
}

Ajuste os valores com base no que encontrar no histórico e dossiê. Não invente — use null se não souber.
`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      max_tokens: 1200,
      temperature: 0.1, // baixo para extração precisa
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── 3. POVOA USER_PROFILES ──────────────────────────────────
async function syncUserProfile(extracted: any) {
  const p = extracted.perfil || {};
  const e = extracted.esposa || {};

  const profile: Record<string, any> = {
    user_id:      USER_ID,
    updated_at:   new Date().toISOString(),
  };

  if (p.cidade)         profile.city             = p.cidade;
  if (p.cidade_origem)  profile.birth_city        = p.cidade_origem;
  if (p.nascimento)     profile.birth_date        = p.nascimento;
  if (p.profissao)      profile.current_job       = p.profissao;
  if (p.novo_emprego)   profile.current_job       = p.novo_emprego;
  if (p.inicio_emprego) profile.job_start_date    = p.inicio_emprego;
  if (p.tdah)           profile.health_notes      = 'TDAH — acompanhamento com Dr. Adriano';
  if (e.nome)           profile.spouse_name       = e.nome;
  if (e.aniversario)    profile.spouse_birthday   = e.aniversario;
  if (p.medico)         profile.doctor            = p.medico;

  const { error } = await supabase
    .from('user_profiles')
    .upsert(profile, { onConflict: 'user_id' });

  if (error) console.error('[user_profiles] Erro:', error.message);
  else       console.log('[user_profiles] ✅ Sincronizado');
}

// ─── 4. POVOA CHILDREN ───────────────────────────────────────
async function syncChildren(extracted: any) {
  const filhos: any[] = extracted.filhos || [];
  if (!filhos.length) return;

  // Remove filhos antigos para evitar duplicata
  await supabase.from('children').delete().eq('parent_id', USER_ID);

  for (const filho of filhos) {
    if (!filho.nome) continue;

    const birthYear  = filho.idade
      ? new Date().getFullYear() - filho.idade
      : null;
    const birth_date = birthYear
      ? `${birthYear}-01-01`
      : null;

    const lifePhase =
      !filho.idade        ? 'child'       :
      filho.idade <= 3    ? 'baby'        :
      filho.idade <= 11   ? 'child'       :
      filho.idade <= 17   ? 'teen'        :
      filho.idade <= 24   ? 'young_adult' : 'adult';

    const { error } = await supabase.from('children').insert({
      parent_id:  USER_ID,
      name:       filho.nome,
      birth_date,
      life_phase: lifePhase,
      updated_at: new Date().toISOString(),
    });

    if (error) console.error(`[children] Erro ${filho.nome}:`, error.message);
    else       console.log(`[children] ✅ ${filho.nome} (${filho.idade} anos)`);
  }
}

// ─── 5. POVOA RELATIONSHIPS (esposa) ─────────────────────────
async function syncRelationships(extracted: any) {
  const esposa = extracted.esposa;
  if (!esposa?.nome) {
    console.log('[relationships] ⚠️  Nome da esposa não encontrado — pulando');
    return;
  }

  // Verifica se já existe
  const { data: existing } = await supabase
    .from('relationships')
    .select('id')
    .eq('user_id_a', USER_ID)
    .eq('relation_type', 'spouse')
    .single();

  if (existing) {
    console.log('[relationships] ✅ Esposa já registrada');
    return;
  }

  const { error } = await supabase.from('relationships').insert({
    user_id_a:     USER_ID,
    relation_type: 'spouse',
    nickname:      esposa.nome,
    metadata:      { birthday: esposa.aniversario },
    created_at:    new Date().toISOString(),
  });

  if (error) console.error('[relationships] Erro:', error.message);
  else       console.log(`[relationships] ✅ Esposa: ${esposa.nome}`);
}

// ─── 6. ATUALIZA L3 (current_context) ───────────────────────
async function syncL3(extracted: any) {
  const p  = extracted.perfil    || {};
  const e  = extracted.esposa    || {};
  const r  = extracted.rotina    || {};
  const pr = extracted.preferencias || {};

  const filhos = (extracted.filhos || [])
    .map((f: any) => `${f.nome} (${f.idade} anos)`)
    .join(', ');

  const projetos = (extracted.projetos || [])
    .map((j: any) => `- ${j.nome}: ${j.status}${j.pendencia ? ` — pendência: ${j.pendencia}` : ''}`)
    .join('\n');

  const lembretes = (r.lembretes || []).join(', ');

  const dossie = `## PERFIL PESSOAL
- Nome: ${p.nome || 'Celio Nascimento'}
- Localização: ${p.cidade || 'Londrina'}, PR${p.cidade_origem ? ` (nasceu em ${p.cidade_origem})` : ''}
- Esposa: ${e.nome || '(nome não informado)'} | Aniversário: 5 de agosto
- Filhos: ${filhos || 'Miguel (5), Davi (3), Pedro (19)'}
- TDAH: tratamento com ${p.medico || 'Dr. Adriano'}
- Emprego atual: ${p.novo_emprego || 'White Martins'} (início ${p.inicio_emprego || '12/03/2026'})

## ROTINA
- Despertar: ${r.despertar || '05:00'} (tende a procrastinar no sofá)
- Academia: saída ${r.academia_saida || '06:40'}–07:10, trajeto 20min
- Trabalho: ${r.trabalho_entrada || '08:00'}h → ${r.trabalho_saida || '17:50'}h
- Noite: roupa (18:30), PQF 1.5h, marmita (20:45), dormir ${r.dormir || '21:00'}–21:30
${lembretes ? `- Lembretes ativos: ${lembretes}` : ''}

## PROJETOS
${projetos || '- Procuro Quem Faça (PQF): beta — homologação pendente (reivindicação de perfil)'}
- Revisão semanal PQF: sextas 18h

## PREFERÊNCIAS E INTERESSES
- Comunicação: ${pr.comunicacao || 'informal e curta, sem framework rígido'}
- Feira do Produtor: ${pr.feira_produtor || 'sábados, Rua São Vicente'}; pastel perto do aeroporto
- Filme recente indicado: ${pr.filme_recente || 'Detona Ralph'}
${extracted.fe ? `- Fé: ${extracted.fe}` : ''}
${extracted.objetivos ? `- Objetivos: ${extracted.objetivos}` : ''}`.trim();

  const { error } = await supabase
    .from('users')
    .update({ current_context: dossie, updated_at: new Date().toISOString() })
    .eq('id', USER_ID);

  if (error) console.error('[L3] Erro:', error.message);
  else       console.log('[L3] ✅ Dossiê atualizado');
}

// ─── 7. ATUALIZA ONBOARDING ──────────────────────────────────
async function syncOnboarding(extracted: any) {
  const p = extracted.perfil || {};
  const collected: string[] = ['filhos'];
  if (p.cidade)        collected.push('cidade');
  if (p.profissao || p.novo_emprego) collected.push('profissao');
  if (p.nascimento)    collected.push('nascimento');
  if (p.cidade_origem) collected.push('familia_origem');
  if (extracted.rotina?.despertar) collected.push('rotina');
  if (extracted.fe)    collected.push('fe');
  if (extracted.objetivos) collected.push('objetivos');

  const allFields = ['nome','cidade','nascimento','familia_origem','profissao','rotina','fe','objetivos','filhos'];
  const pending   = allFields.filter(f => !collected.includes(f));

  const { error } = await supabase
    .from('onboarding_progress')
    .update({
      collected,
      pending,
      next_field:     pending[0] || null,
      collected_data: extracted,
      status:         pending.length <= 2 ? 'completed' : 'in_progress',
      updated_at:     new Date().toISOString(),
    })
    .eq('user_id', USER_ID);

  if (error) console.error('[onboarding] Erro:', error.message);
  else       console.log(`[onboarding] ✅ Coletados: ${collected.join(', ')} | Pendentes: ${pending.join(', ')}`);
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Iniciando sync brain → tabelas...\n');

  const { brainText, currentL3 } = await fetchContext();
  console.log(`📖 Brain: ${brainText.split('\n').length} linhas | L3: ${currentL3.length} chars\n`);

  console.log('🤖 Extraindo dados via IA...');
  const extracted = await extractFromBrain(brainText, currentL3);
  console.log('Extraído:', JSON.stringify(extracted, null, 2), '\n');

  await syncUserProfile(extracted);
  await syncChildren(extracted);
  await syncRelationships(extracted);
  await syncL3(extracted);
  await syncOnboarding(extracted);

  console.log('\n✅ Sync completo!');
}

main().catch(console.error);
