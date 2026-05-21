// lib/services/memory.service.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';

const MEMORIA_INVALIDA = [
  'Framework de 4 Etapas',
  'Como posso te ajudar a ser mais produtivo',
  'Olá! 👋',
  'Plano de Ação:',
  'Próximos Passos:',
];

function memoriaEhValida(texto: string): boolean {
  if (MEMORIA_INVALIDA.some(p => texto.includes(p))) return false;
  if (texto.trim().length < 100) return false;
  const linhas = texto.split('\n').filter(l => l.trim().length > 20);
  const unicas = new Set(linhas);
  if (linhas.length > 5 && unicas.size / linhas.length < 0.6) return false;
  return true;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    console.log('[Embedding] Gerando para:', text.substring(0, 60) + (text.length > 60 ? '...' : ''));

    if (!process.env.OPENAI_API_KEY) {
      console.error('[Embedding] OPENAI_API_KEY NÃO DEFINIDA!');
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
        "X-Title": process.env.NEXT_PUBLIC_APP_NAME || 'Jarvis AI',
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
        dimensions: 1536,
      })
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Embedding] Erro HTTP:', res.status, errorText);
      return null;
    }

    const json = await res.json();
    if (!json.data?.[0]?.embedding) return null;

    return json.data[0].embedding;
  } catch (e: any) {
    console.error("[Embedding] Exceção:", e?.message || e);
    return null;
  }
}

export async function compactMemory(userId: string, authorName: string): Promise<void> {
  try {
    const { data: rawBrain } = await supabase
      .from('brain')
      .select('content, metadata, created_at')
      .eq('user_id', userId)
      .neq('category', 'noise')
      .order('created_at', { ascending: true });

    if (!rawBrain || rawBrain.length < 20) return;

    const { data: userProfile } = await supabase
      .from('users')
      .select('current_context')
      .eq('id', userId)
      .maybeSingle();

    const oldContext = userProfile?.current_context || "Nenhum contexto prévio.";

    const SAUDACOES = [
      /^(olá|oi|e aí|fala|qual a boa|tudo bem|tudo bom|bom dia|boa tarde|boa noite|hey|opa|salve)[!?,. ]*/i,
      /^(ok|certo|entendido|perfeito|ótimo|show|vlw|valeu|obrigad)[!?,. ]*/i,
    ];

    const ehSaudacao = (texto: string) => SAUDACOES.some(r => r.test(texto.trim()));

    const entradasValidas = rawBrain.filter(m => {
      const reply = m.metadata?.ai_reply || '';
      if (ehSaudacao(m.content)) return false;
      return reply.trim().length > 20 && !MEMORIA_INVALIDA.some(p => reply.includes(p));
    });

    if (entradasValidas.length < 5) return;

    const brainText = entradasValidas.map(m =>
      `${authorName}: ${m.content}\nJarvis: ${(m.metadata?.ai_reply || '').replace(/\[.*?\]/g, '').trim()}`
    ).join('\n\n');

    const prompt = `
Você é o Gerente de Memória do Lev. Mantenha o Dossiê do usuário ${authorName} atualizado.
[DOSSIÊ ATUAL]:\n${oldContext}\n\n[NOVAS INTERAÇÕES]:\n${brainText}
TAREFA: Integre as novas informações ao Dossiê de forma densa e sem comentários. Retorne apenas o texto puro.`;

    const newContext = await callOpenRouter(prompt, "google/gemini-2.0-flash-001", 0.3);
    if (!memoriaEhValida(newContext)) return;

    const embedding = await generateEmbedding(newContext);

    if (embedding) {
      await supabase.from('users').update({ current_context: newContext }).eq('id', userId);
      
      import('@/lib/chat/l3-chunks').then(({ indexL3Chunks }) => {
        indexL3Chunks(Number(userId), newContext).catch(e => console.error(e));
      });
      
      await supabase.from('memories').insert([{
        summary: newContext,
        embedding,
        user_id: userId,
        relevance_score: 1.0,
        access_count: 0,
        decay_lambda: 0.005,
        emotional_weight: 0.5,
        metadata: { type: 'auto_consolidation', count: entradasValidas.length }
      }]);

      const lastProcessedDate = entradasValidas[entradasValidas.length - 1].created_at;
      await supabase.from('brain').delete().eq('user_id', userId).neq('category', 'noise').lte('created_at', lastProcessedDate);
    } 
  } catch (e: any) {
    console.error("[Memory] Erro crítico na compactação:", e);
  }
}

export async function reinforceMemory(memoryId: string): Promise<void> {
  try {
    const { data } = await supabase.from('memories').select('access_count, relevance_score').eq('id', memoryId).maybeSingle();
    if (!data) return;

    await supabase.from('memories').update({
      access_count: (data.access_count || 0) + 1,
      relevance_score: Math.min((data.relevance_score || 0) + 0.05, 1.0),
      updated_at: new Date().toISOString()
    }).eq('id', memoryId);
  } catch (e) {
    console.error("[Memory] Erro reinforceMemory:", e);
  }
}

export async function updateL3(userId: string): Promise<void> {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { 
      timeZone: 'America/Sao_Paulo' 
    }).format(new Date());

    // 1. Busca dados em paralelo para performance e rigor
    const [profRes, kidsRes, projRes, evRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('children').select('name, birth_date, life_phase, gender').eq('parent_id', userId),
      supabase.from('projects').select('name, description, status').eq('user_id', userId).limit(10),
      supabase.from('events').select('title, start_at, emotional_weight')
        .gte('start_at', today)
        .order('start_at', { ascending: true })
        .limit(15),
      supabase.from('users').select('current_context').eq('id', userId).single(),
    ]);

    const p = profRes.data;
    const kids = kidsRes.data || [];
    const proj = projRes.data || [];
    const evs = evRes.data || [];
    let ctx = userRes.data?.current_context || '';

    const patches: Record<string, string> = {};

    // 2. Mapeamento de Perfil (Rigidez na estrutura)
    if (p?.full_name) patches['Nome'] = p.preferred_name ? `${p.full_name} (prefere: ${p.preferred_name})` : p.full_name;
    if (p?.gender) patches['Gênero'] = p.gender;
    if (p?.birth_date) patches['Nascimento'] = p.birth_date;
    if (p?.city) patches['Mora em'] = `${p.city}${p.state ? `, ${p.state}` : ''}`;
    if (p?.current_job) patches['Cargo'] = `${p.current_job}${p.company ? ` @ ${p.company}` : ''}`;
    
    if (kids.length > 0) {
      patches['Filhos'] = kids.map(k => {
        const age = k.birth_date ? new Date().getFullYear() - new Date(k.birth_date).getFullYear() : null;
        return `${k.name}${age !== null ? ` (${age} anos)` : ''}`;
      }).join(', ');
    }

    // 3. Aplicação rigorosa dos patches no contexto
    for (const [key, val] of Object.entries(patches)) {
      const rx = new RegExp(`- ${key}: (.*)`, 'i');
      if (rx.test(ctx)) {
        ctx = ctx.replace(rx, `- ${key}: ${val}`);
      } else {
        ctx = `${ctx}\n- ${key}: ${val}`;
      }
    }

    // 4. Seção de Projetos
    if (proj.length > 0) {
      const block = proj.map(r => `- ${r.name}${r.status ? ` [${r.status}]` : ''}: ${r.description || ''}`).join('\n');
      const section = `## PROJETOS\n${block}`;
      ctx = ctx.replace(/## PROJETOS[\s\S]*?(?=\n##|$)/i, '').trim() + `\n\n${section}`;
    }

    // 5. Seção de Datas Importantes
    const highEvs = evs.filter(e => (e.emotional_weight || 0) >= 0.7);
    if (highEvs.length > 0) {
      const block = highEvs.map(e => `- ${e.title}: ${e.start_at}`).join('\n');
      const section = `## DATAS IMPORTANTES\n${block}`;
      ctx = ctx.replace(/## DATAS IMPORTANTES[\s\S]*?(?=\n##|$)/i, '').trim() + `\n\n${section}`;
    }

    // 6. Persistência final
    await supabase.from('users').update({ current_context: ctx.trim() }).eq('id', userId);
    console.log(`[MemoryService/updateL3] Contexto L3 consolidado para user ${userId}`);

  } catch (e) {
    console.error('[MemoryService/updateL3] Erro crítico na varredura:', e);
    throw e; // Mantendo o rigor: se falhou, o orquestrador precisa saber
  }
}
