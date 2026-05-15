// lib/chat/pipeline/extractors/projects.extractor.ts
import { supabase, callOpenRouter } from '@/lib/jarvis';

export async function extractProjeto(userId: string, userMessage: string): Promise<void> {
  const prompt = [
    { role: 'system', content: 'Você é um catalogador de projetos. Responda apenas com JSON estruturado.' },
    {
      role: 'user',
      content: `Extraia projetos ou ideias da mensagem: "${userMessage}".
      Retorne: {"projetos": [{"nome": "Nome Curto/Sigla", "tag": "slug_sem_espacos", "descricao": "Descrição estendida", "status": "ideia|em_desenvolvimento", "contexto_tecnico": null}]}`
    }
  ];

  try {
    const raw = await callOpenRouter(prompt as any, "google/gemini-2.0-flash-001", 0.1, 4);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!data?.projetos) return;

    for (const proj of data.projetos) {
      if (!proj.nome || !proj.tag) continue;

      const { data: existing } = await supabase.from('projects')
        .select('description')
        .eq('user_id', userId).eq('tag', proj.tag).maybeSingle();

      const payload: Record<string, any> = {
        user_id: userId, tag: proj.tag.toLowerCase(), name: proj.nome,
        updated_at: new Date().toISOString(),
      };

      if (proj.descricao && (!existing?.description || proj.descricao.length > existing.description.length)) {
        payload.description = proj.descricao;
      }
      if (proj.contexto_tecnico) payload.context_technical = proj.contexto_tecnico;
      if (proj.status) payload.status = proj.status;

      await supabase.from('projects').upsert(payload, { onConflict: 'user_id,tag' });
    }
  } catch (e) {
    console.error('[Extrator/Projetos] Erro:', e);
  }
}