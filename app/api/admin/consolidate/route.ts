import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'jarvis' } }
);

export async function GET() {
  try {
    // 1. BUSCA LOGS DA RAM (Brain)
    const { data: logs, error: fetchError } = await supabase
      .from('brain')
      .select('*')
      .is('metadata->consolidated', null)
      .order('created_at', { ascending: true })
      .limit(10);

    if (fetchError) throw new Error(`Erro Supabase: ${fetchError.message}`);
    if (!logs || logs.length === 0) {
      return NextResponse.json({ message: "RAM limpa. Nada para consolidar." });
    }

    const projectTag = logs[0].project_tag || 'Geral';
    const batchText = logs.map(l => `[${l.created_at}] ${l.content}`).join('\n');
    const logIds = logs.map(l => l.id);
    const userId = logs[0].metadata?.user_id || 8275386115;

    // 2. RESUMO COM IA (OpenRouter/Gemini)
    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [{ 
          role: "system", 
          content: "Você é o núcleo de memória do Jarvis. Extraia decisões, sujeitos e detalhes técnicos (UX/Frotas) em um resumo denso para o HD vetorial." 
        }, { 
          role: "user", 
          content: `Consolide estas notas de #${projectTag}:\n${batchText}` 
        }]
      })
    });

    const aiData = await aiResponse.json();
    if (!aiData.choices?.[0]) throw new Error("Falha no resumo da IA");
    const summary = aiData.choices[0].message.content;

    // 3. GERAÇÃO DE VETOR (Google Gemini Embedding - Custo Zero)
    const embRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GOOGLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: { parts: [{ text: summary }] }
      })
    });
    
    const embData = await embRes.json();
    if (!embData.embedding?.values) {
      return NextResponse.json({ error: "Falha no Embedding Google", details: embData }, { status: 502 });
    }
    const embedding = embData.embedding.values;

    // 4. PERSISTÊNCIA NO HD
    const { error: memError } = await supabase.from('memories').insert({
      project_tag: projectTag,
      summary: summary,
      embedding: embedding,
      user_id: userId,
      brain_references: logIds
    });

    if (memError) throw new Error(`Erro HD: ${memError.message}`);

    // 5. MARCAR COMO PROCESSADO
    await supabase.from('brain')
      .update({ metadata: { ...logs[0].metadata, consolidated: true, consolidated_at: new Date().toISOString() } })
      .in('id', logIds);

    return NextResponse.json({ 
      status: "Sucesso!", 
      projeto: projectTag, 
      resumo: summary 
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}