import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET() {
  try {
    // 1. BUSCA LOGS NÃO PROCESSADOS (Limite de 10 por vez)
    const { data: logs, error: fetchError } = await supabase
      .from('brain')
      .select('*')
      .is('metadata->consolidated', null)
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError) throw new Error(`Erro Supabase: ${fetchError.message}`);
    if (!logs || logs.length === 0) {
      return NextResponse.json({ message: "Cérebro já está limpo. RAM vazia para consolidação." });
    }

    // 2. AGRUPAMENTO E METADADOS
    const projectTag = logs[0].project_tag || 'Geral';
    const batchText = logs.map(l => `[${l.created_at}] ${l.content}`).join('\n');
    const logIds = logs.map(l => l.id);
    const userId = logs[0].metadata?.user_id || 8275386115; // Fallback Celio

    // 3. O PROMPT DE "ALGORITMO DE MEMÓRIA"
    const summaryPrompt = `
      Aja como o núcleo de memória do Jarvis. 
      Analise estas anotações do projeto #${projectTag}:
      "${batchText}"
      
      TAREFA:
      1. Extraia decisões técnicas, regras de negócio e marcos familiares.
      2. Identifique os SUJEITOS (Quem fez o quê).
      3. Gere um resumo denso e técnico, preservando detalhes de UX e feedbacks.
    `;

    // Chamada para a IA (OpenRouter)
    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`, // Correção AQUI
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: summaryPrompt }]
      })
    });

    const aiData = await aiResponse.json();
    
    // Verificação de segurança da resposta da IA
    if (!aiData.choices || !aiData.choices[0]) {
      return NextResponse.json({ error: "Falha no OpenRouter", details: aiData }, { status: 502 });
    }
    const summary = aiData.choices[0].message.content;

    // 4. GERAÇÃO DO VETOR (Embedding OpenAI)
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, // OpenAI real mantida AQUI
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: summary })
    });
    
    const embData = await embRes.json();

    // Verificação de segurança do Embedding
    if (!embData.data || !embData.data[0]) {
      return NextResponse.json({ error: "Falha no Embedding OpenAI", details: embData }, { status: 502 });
    }
    const embedding = embData.data[0].embedding;

    // 5. PERSISTÊNCIA NO HD (Tabela Memories)
    const { error: memError } = await supabase.from('memories').insert({
      project_tag: projectTag,
      summary: summary,
      embedding: embedding,
      user_id: userId,
      brain_references: logIds
    });

    if (memError) throw new Error(`Erro ao salvar no HD: ${memError.message}`);

    // 6. LIMPEZA DA RAM (Marcar logs como consolidados)
    const { error: updateError } = await supabase.from('brain')
      .update({ 
        metadata: { 
          ...logs[0].metadata, // Mantém metadados antigos
          consolidated: true, 
          consolidated_at: new Date().toISOString() 
        } 
      })
      .in('id', logIds);

    if (updateError) throw new Error(`Erro ao limpar RAM: ${updateError.message}`);

    return NextResponse.json({ 
      status: "Sucesso", 
      projeto: projectTag, 
      resumo_gerado: summary,
      logs_processados: logIds.length
    });

  } catch (error: any) {
    console.error("ERRO CONSOLIDATE:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}