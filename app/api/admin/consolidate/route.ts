import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET() {
  try {
    // 1. BUSCA LOGS NA RAM (Brain)
    const { data: logs, error: fetchError } = await supabase
      .from('brain')
      .select('*')
      .is('metadata->consolidated', null)
      .order('created_at', { ascending: true })
      .limit(20);

    if (fetchError) throw new Error(`Erro Supabase: ${fetchError.message}`);
    if (!logs || logs.length === 0) {
      return NextResponse.json({ message: "RAM limpa. O Jarvis está descansando." });
    }

    const projectTag = logs[0].project_tag || 'Geral';
    const batchText = logs.map(l => `[${l.created_at}] ${l.content}`).join('\n');
    const logIds = logs.map(l => l.id);
    const userId = logs[0].metadata?.user_id || 8275386115;

    // 2. RESUMO COM IA (Via OpenRouter)
    const summaryPrompt = `Você é o núcleo de memória do Jarvis. Analise estas anotações de #${projectTag} e extraia decisões técnicas e sujeitos. Gere um resumo denso para o HD vetorial preservando o rigor de cada detalhe técnico:\n${batchText}`;
    
    const summary = await callOpenRouter(summaryPrompt, "google/gemini-2.0-flash-001");
    if (!summary || summary.includes("❌")) throw new Error("Falha ao gerar resumo no OpenRouter.");

    // 3. GERAÇÃO DE VETOR (Via OpenRouter - Cano Único)
    const embedding = await generateEmbedding(summary);
    if (!embedding) throw new Error("Falha crítica ao gerar Embedding via OpenRouter.");

    // 4. PERSISTÊNCIA NO HD
    const { error: memError } = await supabase.from('memories').insert({
      project_tag: projectTag,
      summary: summary,
      embedding: embedding,
      user_id: userId,
      brain_references: logIds
    });

    if (memError) throw new Error(`Erro ao gravar no HD: ${memError.message}`);

    // 5. LIMPEZA DA RAM
    await supabase.from('brain')
      .update({ 
        metadata: { 
          ...logs[0].metadata, 
          consolidated: true, 
          consolidated_at: new Date().toISOString() 
        } 
      })
      .in('id', logIds);

    return NextResponse.json({ 
      status: "Sucesso!", 
      instancia: projectTag, 
      resumo: summary,
      processados: logIds.length
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ==========================================
// MOTORES UNIFICADOS (OpenRouter 100%)
// ==========================================

async function callOpenRouter(prompt: string, model: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model, 
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "❌ Erro no motor de IA.";
}

async function generateEmbedding(text: string) {
  // Roteamento do Embedding pela mesma porta do OpenRouter
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ 
      model: "openai/text-embedding-3-small", 
      input: text 
    })
  });
  
  const data = await res.json();
  
  if (data.error) {
    console.error("DEBUG OPENROUTER EMBEDDING:", data.error.message);
    return null;
  }
  
  return data.data?.[0]?.embedding;
}
