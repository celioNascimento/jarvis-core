import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface TrainingLine {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

interface Classificacao {
  emotional_state: "estavel" | "estressado" | "vulneravel" | "critico";
  tags: string[];
}

async function gerarEmbedding(texto: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texto,
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function classificarExemplo(
  userMessage: string,
  assistantResponse: string
): Promise<Classificacao> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      messages: [
        {
          role: "system",
          content: `Classifique a interação abaixo. Responda APENAS com JSON, sem markdown, sem preâmbulo.

Formato exato:
{"emotional_state":"estavel|estressado|vulneravel|critico","tags":["tag1","tag2"]}

Critérios de emotional_state:
- estavel: conversa neutra, técnica, sem carga emocional relevante
- estressado: sobrecarga, ansiedade situacional, pressão (ex: prazos, trabalho)
- vulneravel: fragilidade emocional mais profunda, autoestima, relacionamentos
- critico: risco, crise severa, ideação suicida, desespero extremo

Tags: escolha 2-4 palavras-chave do tema/abordagem (ex: "trabalho", "acolhimento", "organizacao", "tecnico", "relacionamento", "autoestima", "prazo", "decisao").`,
        },
        {
          role: "user",
          content: `Usuário: ${userMessage}\n\nLev: ${assistantResponse}`,
        },
      ],
    }),
  });

  const data = await res.json();
  const conteudo = data.choices[0].message.content.trim();

  try {
    return JSON.parse(conteudo);
  } catch {
    console.warn("Falha ao parsear classificação, usando fallback:", conteudo);
    return { emotional_state: "estavel", tags: [] };
  }
}

async function ingerir() {
  const linhas = readFileSync("lev-train.jsonl", "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrainingLine);

  console.log(`${linhas.length} exemplos encontrados. Iniciando ingestão...`);

  for (const [i, linha] of linhas.entries()) {
    const system = linha.messages.find((m) => m.role === "system")?.content ?? "";
    const user = linha.messages.find((m) => m.role === "user")?.content ?? "";
    const assistant = linha.messages.find((m) => m.role === "assistant")?.content ?? "";

    if (!user || !assistant) {
      console.warn(`Linha ${i} sem user/assistant completo, pulando.`);
      continue;
    }

    try {
      const [embedding, classificacao] = await Promise.all([
        gerarEmbedding(user),
        classificarExemplo(user, assistant),
      ]);

      const { error } = await supabase.schema("jarvis").from("few_shot_examples").insert({
        system_prompt: system,
        user_message: user,
        assistant_response: assistant,
        embedding,
        emotional_state: classificacao.emotional_state,
        tags: classificacao.tags,
        source_line: i,
      });

      if (error) {
        console.error(`Erro na linha ${i}:`, error);
      } else {
        console.log(`✓ Linha ${i} — estado: ${classificacao.emotional_state}, tags: ${classificacao.tags.join(", ")}`);
      }
    } catch (err) {
      console.error(`Falha na linha ${i}:`, err);
    }

    // pequeno delay pra não estourar rate limit
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("Ingestão concluída.");
}

ingerir();