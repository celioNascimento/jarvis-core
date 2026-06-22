import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAMINHO_ARQUIVO = join(__dirname, "lev-train.jsonl");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENAI_API_KEY; // chave OpenRouter (nome confuso no .env.local)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY_1; // chave real da OpenAI

const faltando = [
  !SUPABASE_URL && "SUPABASE_URL",
  !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
  !OPENROUTER_API_KEY && "OPENAI_API_KEY (chave OpenRouter)",
  !OPENAI_API_KEY && "OPENAI_API_KEY_1 (chave OpenAI)",
].filter(Boolean);

if (faltando.length > 0) {
  throw new Error(`Faltam estas env vars no .env.local: ${faltando.join(", ")}`);
}

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

interface TrainingLine {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

interface Classificacao {
  emotional_state: "estavel" | "estressado" | "vulneravel" | "critico";
  tags: string[];
}

// ── Retry genérico com backoff exponencial ─────────────────────────────────
// Tenta executar `fn`. Se falhar com um erro "transitório" (5xx, timeout,
// reset de conexão), espera um pouco e tenta de novo, até MAX_TENTATIVAS.
// Se falhar por outro motivo (ex: 401 de autenticação), desiste na hora —
// retry não resolve chave errada, só problema de rede momentâneo.

const MAX_TENTATIVAS = 4;

function ehErroTransitorio(mensagem: string): boolean {
  const m = mensagem.toLowerCase();
  return (
    m.includes("503") ||
    m.includes("502") ||
    m.includes("504") ||
    m.includes("connection") ||
    m.includes("timeout") ||
    m.includes("reset") ||
    m.includes("econnreset") ||
    m.includes("fetch failed")
  );
}

async function comRetry<T>(fn: () => Promise<T>, contexto: string): Promise<T> {
  let ultimoErro: unknown;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (!ehErroTransitorio(msg) || tentativa === MAX_TENTATIVAS) {
        throw err; // erro definitivo (ou esgotou tentativas) — propaga de verdade
      }

      const esperaMs = 1000 * 2 ** (tentativa - 1); // 1s, 2s, 4s, 8s...
      console.warn(
        `[Retry] ${contexto} falhou (tentativa ${tentativa}/${MAX_TENTATIVAS}): ${msg}. Tentando de novo em ${esperaMs}ms...`
      );
      await dormir(esperaMs);
    }
  }

  throw ultimoErro; // nunca deveria chegar aqui, mas TypeScript exige um retorno/throw
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
        comRetry(() => gerarEmbedding(user), `embedding da linha ${i}`),
        comRetry(() => classificarExemplo(user, assistant), `classificação da linha ${i}`),
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
      console.error(`Falha definitiva na linha ${i}:`, err instanceof Error ? err.message : err);
      falhas++;
    }

    await dormir(300);
  }

  console.log(`\nIngestão concluída. Sucesso: ${sucesso} | Falhas: ${falhas}`);
}

ingerir();