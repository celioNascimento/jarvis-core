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
      .limit(15); // Aumentei o limite, já que sua cota agora permite

    if (fetchError) throw new Error(`Erro Supabase: ${fetchError.message}`);
    if (!logs || logs.length === 0) {
      return NextResponse.json({ message: "RAM limpa. Jarvis está com o dia em dia." });
    }

    const projectTag = logs[0].project_tag || 'Geral';
    const batchText = logs.map(l => `[${l.created_at}] ${l.content}`).join('\n');
    const logIds = logs.map(l => l.id);
    const userId = logs[0].metadata?.user_id || 8275386115;

    // 2. RESUMO COM IA (Agora com Gemini 2.0 Flash Liberado)
    const summaryPrompt = {
      contents: [{
        parts: [{
          text: `Você é o núcleo de memória do Jarvis. Analise estas anotações de #${projectTag} e extraia decisões técnicas e sujeitos (quem fez o quê). Gere um resumo denso para o HD vetorial preservando o rigor de cada detalhe técnico e UX:\n${batchText}`
        }]
      }]
    };

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryPrompt)
    });

    const aiData = await aiRes.json();
    
    if (aiData.error) {
      return NextResponse.json({ error: "Erro Google AI", details: aiData.error.message }, { status: 502 });
    }

    const summary = aiData.candidates?.[0]?.content?.parts?.[0]?.text;

    // 3. GERAÇÃO DE VETOR (Embedding)
    const embRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GOOGLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: { parts: [{ text: summary }] }
      })
    });
    
    const embData = await embRes.json();
    const embedding = embData.embedding?.values;

    if (!embedding) throw new Error("Falha ao gerar Embedding.");

    // 4. PERSISTÊNCIA NO HD (Tabela Memories)
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
      .update({ metadata: { ...logs[0].metadata, consolidated: true, consolidated_at: new Date().toISOString() } })
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