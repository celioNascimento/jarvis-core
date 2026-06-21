import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAMINHO_ARQUIVO = join(__dirname, "lev-train.jsonl");

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY || !OPENROUTER_API_KEY) {
  throw new Error(
    "Faltam env vars. Confirme SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY e OPENROUTER_API_KEY no .env.local"
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texto,
    }),
  });

  if (!res.ok) {
    const erro = await res.text();
    throw new Error(`Erro HTTP ${res.status} da OpenAI (embeddings): ${erro}`);
  }

  const data = await res.json();

  if (!data.data?.[0]?.embedding) {
    throw new Error(`Resposta inesperada da OpenAI (embeddings): ${JSON.stringify(data)}`);
  }

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
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

  if (!res.ok) {
    const erro = await res.text();
    throw new Error(`Erro HTTP ${res.status} da OpenRouter: ${erro}`);
  }

  const data = await res.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(`Resposta inesperada da OpenRouter: ${JSON.stringify(data)}`);
  }

  const conteudo = data.choices[0].message.content.trim();

  try {
    return JSON.parse(conteudo);
  } catch {
    throw new Error(`Falha ao parsear classificação: ${conteudo}`);
  }
}

async function obterLinhasJaInseridas(): Promise<Set<number>> {
  const { data, error } = await supabase
    .schema("jarvis")
    .from("few_shot_examples")
    .select("source_line");

  if (error) {
    console.error("Erro ao verificar linhas já inseridas:", error);
    return new Set();
  }

  return new Set(data.map((d) => d.source_line));
}

function dormir(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ingerir() {
  const linhas = readFileSync(CAMINHO_ARQUIVO, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrainingLine);

  console.log(`${linhas.length} exemplos encontrados em ${CAMINHO_ARQUIVO}.`);

  const jaInseridas = await obterLinhasJaInseridas();
  if (jaInseridas.size > 0) {
    console.log(`${jaInseridas.size} linhas já inseridas anteriormente — serão puladas.`);
  }

  let sucesso = 0;
  let falhas = 0;

  for (const [i, linha] of linhas.entries()) {
    if (jaInseridas.has(i)) continue;

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
        console.error(`Erro ao inserir linha ${i}:`, error.message);
        falhas++;
      } else {
        console.log(`✓ Linha ${i} — estado: ${classificacao.emotional_state}, tags: ${classificacao.tags.join(", ")}`);
        sucesso++;
      }
    } catch (err) {
      console.error(`Falha na linha ${i}:`, err instanceof Error ? err.message : err);
      falhas++;
    }

    await dormir(300);
  }

  console.log(`\nIngestão concluída. Sucesso: ${sucesso} | Falhas: ${falhas}`);
}

ingerir();