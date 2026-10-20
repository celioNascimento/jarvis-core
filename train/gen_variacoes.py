#!/usr/bin/env python3
"""Gera 5 variacoes da resposta do assistente (Lev) para cada linha de um .jsonl de fine-tuning.

Uso:
    pip install openai
    export OPENAI_API_KEY="sk-..."          (Windows PowerShell: $env:OPENAI_API_KEY="sk-...")
    python gen_variacoes.py --limit 15      # piloto: so as 15 primeiras linhas
    python gen_variacoes.py                 # roda tudo (retoma de onde parou se for interrompido)

Saidas:
    lev-variacoes.jsonl       -> formato limpo de treino ({"messages": [...]}), 5 registros por linha original
    lev-variacoes-meta.jsonl  -> mesmo conteudo + linha de origem e numero da variacao (para voce auditar)
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import threading
import time

from openai import OpenAI

# Preco por 1M tokens (input, output). Confira em platform.openai.com/docs/pricing
PRECOS = {
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o": (2.50, 10.00),
}

INSTRUCOES = """Você é um especialista em reescrever diálogos para treinar uma IA. 
Vou te passar uma conversa e a resposta ORIGINAL do Lev. 
Seu trabalho é gerar 5 variações da resposta do Lev, em português do Brasil. 

Atenção: O modelo atual tem o vício de terminar TODAS as respostas com perguntas. 
Seu objetivo é quebrar esse vício gerando diversidade de estrutura. 
REGRA DE OURO: NUNCA copie a resposta original palavra por palavra. O texto deve ser sempre reescrito.

Regras RÍGIDAS por variação (siga a ordem exata):
- Variação 1 (Reflexão SEM pergunta): Acolha o sentimento e devolva uma reflexão. PROIBIDO usar o ponto de interrogação (?).
- Variação 2 (Acolhimento puro SEM pergunta): Apenas valide o que a pessoa sentiu e encerre a fala de forma acolhedora. PROIBIDO usar o ponto de interrogação (?).
- Variação 3 (Direto com pergunta): Seja mais objetivo e direto, e termine com APENAS UMA pergunta.
- Variação 4 (Opinião própria SEM pergunta): Dê uma opinião sincera de amigo, sem fazer perguntas, podendo ser mais leve.
- Variação 5 (Curta e firme SEM pergunta): Responda de forma bem resumida, em uma ou duas frases. PROIBIDO usar o ponto de interrogação (?).

Regras de Conteúdo:
1. NUNCA invente fatos novos na história. Use apenas o contexto do usuário.
2. NÃO use tom de "coach" (ex: "Você é mais forte que isso"). Seja um amigo natural.
3. Se for uma crise (ex: falar em se matar, sumir), TODAS as variações devem manter a conduta de crise curta e mencionar o CVV 188 se o original mencionar.

Responda SOMENTE com JSON no formato:
{"variacoes": ["variação 1", "variação 2", "variação 3", "variação 4", "variação 5"]}"""


def ler_linhas(caminho):
    with open(caminho, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def indices_feitos(caminho_meta):
    feitos = set()
    if os.path.exists(caminho_meta):
        with open(caminho_meta, encoding="utf-8") as f:
            for l in f:
                if l.strip():
                    feitos.add(json.loads(l)["source_line"])
    return feitos


def montar_pedido(registro):
    msgs = registro["messages"]
    sistema = next(m["content"] for m in msgs if m["role"] == "system")
    usuario = next(m["content"] for m in msgs if m["role"] == "user")
    original = next(m["content"] for m in msgs if m["role"] == "assistant")
    return (
        f"PROMPT DE SISTEMA DA PERSONA:\n{sistema}\n\n"
        f"FALA DO USUARIO:\n{usuario}\n\n"
        f"RESPOSTA ORIGINAL DO LEV:\n{original}"
    ), original


def gerar(client, modelo, registro, tentativas=4):
    pedido, original = montar_pedido(registro)
    ultimo_erro = None
    for t in range(tentativas):
        try:
            r = client.chat.completions.create(
                model=modelo,
                temperature=0.9,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": INSTRUCOES},
                    {"role": "user", "content": pedido},
                ],
            )
            dados = json.loads(r.choices[0].message.content)
            vs = [v.strip() for v in dados["variacoes"] if isinstance(v, str) and v.strip()]
            if len(vs) != 5:
                raise ValueError(f"vieram {len(vs)} variacoes em vez de 5")
            if any(v == original.strip() for v in vs):
                raise ValueError("uma variacao ficou identica ao original")
            return vs, r.usage.prompt_tokens, r.usage.completion_tokens
        except Exception as e:  # rate limit, JSON invalido, etc.
            ultimo_erro = e
            time.sleep(2 ** t)
    raise RuntimeError(ultimo_erro)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--entrada", default="lev-train.jsonl")
    ap.add_argument("--saida", default="lev-variacoes.jsonl")
    ap.add_argument("--meta", default="lev-variacoes-meta.jsonl")
    ap.add_argument("--modelo", default="gpt-4.1-mini")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("Defina a variavel de ambiente OPENAI_API_KEY antes de rodar.")

    client = OpenAI()
    linhas = ler_linhas(args.entrada)
    fim = len(linhas) if args.limit is None else min(len(linhas), args.offset + args.limit)
    feitos = indices_feitos(args.meta)
    fila = [i for i in range(args.offset, fim) if i not in feitos]
    print(f"{len(linhas)} linhas no arquivo | {len(feitos)} ja feitas | {len(fila)} a processar | modelo {args.modelo}")

    lock = threading.Lock()
    tot_in = tot_out = ok = falhas = 0
    p_in, p_out = PRECOS.get(args.modelo, (0, 0))

    def tarefa(i):
        return i, gerar(client, args.modelo, linhas[i])

    with open(args.saida, "a", encoding="utf-8") as fs, open(args.meta, "a", encoding="utf-8") as fm, \
            cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futuros = {ex.submit(tarefa, i): i for i in fila}
        for fut in cf.as_completed(futuros):
            i = futuros[fut]
            try:
                _, (vs, tin, tout) = fut.result()
            except Exception as e:
                falhas += 1
                print(f"[falha] linha {i}: {e}", file=sys.stderr)
                continue
            msgs = linhas[i]["messages"]
            with lock:
                for n, v in enumerate(vs, 1):
                    novo = {"messages": [m if m["role"] != "assistant" else {"role": "assistant", "content": v} for m in msgs]}
                    fs.write(json.dumps(novo, ensure_ascii=False) + "\n")
                    fm.write(json.dumps({"source_line": i, "variant": n, **novo}, ensure_ascii=False) + "\n")
                fs.flush()
                fm.flush()
                tot_in += tin
                tot_out += tout
                ok += 1
                if ok % 20 == 0:
                    custo = tot_in / 1e6 * p_in + tot_out / 1e6 * p_out
                    print(f"{ok}/{len(fila)} feitas | custo ate agora ~US$ {custo:.3f}")

    custo = tot_in / 1e6 * p_in + tot_out / 1e6 * p_out
    print(f"\nConcluido: {ok} linhas ok, {falhas} falhas. Tokens: {tot_in} in / {tot_out} out | custo ~US$ {custo:.3f}")
    if falhas:
        print("Rode o script de novo: ele retoma e tenta so as linhas que faltam.")


if __name__ == "__main__":
    main()