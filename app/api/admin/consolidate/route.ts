import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET() {
  try {
    // 1. BUSCA LOGS NÃO PROCESSADOS (Limite de 10 por vez para segurança)
    const { data: logs, error: fetchError } = await supabase
      .from('brain')
      .select('*')
      .is('metadata->consolidated', null)
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError || !logs || logs.length === 0) {
      return NextResponse.json({ message: "Cérebro já está limpo ou erro na busca." });
    }

    // 2. AGRUPAMENTO POR PROJETO/CONTEXTO
    // Aqui o Jarvis entende se é #PQF, #ExpertFrotas ou "Vida Pessoal"
    const projectTag = logs[0].project_tag || 'Geral';
    const batchText = logs.map(l => `[${l.created_at}] ${l.content}`).join('\n');
    const logIds = logs.map(l => l.id);
    const userId = logs[0].metadata?.user_id || 8275386115; // Seu ID como fallback inicial

    // 3. O PROMPT DE "ALGORITMO DE MEMÓRIA"
    const summaryPrompt = `
      Aja como o núcleo de memória do Jarvis. 
      Analise estas anotações do projeto #${projectTag}:
      "${batchText}"
      
      TAREFA:
      1. Extraia decisões técnicas, regras de negócio e marcos familiares.
      2. Identifique os SUJEITOS (Quem fez o quê).
      3. Gere um resumo denso, mas sem 'encher linguiça'.
      4. Se houver detalhes de UX ou feedbacks do Celio, MANTENHA O RIGOR no registro.
    `;

    // Chamada para o "Escritor de Memórias" (Claude ou Gemini)
    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: summaryPrompt }]
      })
    });

    const aiData = await aiResponse.json();
    const summary = aiData.choices[0].message.content;

    // 4. GERAÇÃO DO VETOR (O "Endereço" no HD)
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: summary })
    });
    const embedding = (await embRes.json()).data[0].embedding;

    // 5. PERSISTÊNCIA NO HD E LIMPEZA DA RAM
    const { error: memError } = await supabase.from('memories').insert({
      project_tag: projectTag,
      summary: summary,
      embedding: embedding,
      user_id: userId,
      brain_references: logIds
    });

    if (memError) throw memError;

    // Marca no Brain que esses logs já viraram memória
    await supabase.from('brain')
      .update({ metadata: { consolidated: true, consolidated_at: new Date().toISOString() } })
      .in('id', logIds);

    return NextResponse.json({ 
      status: "Sucesso", 
      projeto: projectTag, 
      resumo_gerado: summary 
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}