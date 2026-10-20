import json

def analisar(arquivo):
    total, com_pergunta = 0, 0
    for l in open(arquivo, encoding='utf-8'):
        if not l.strip(): continue
        msg = json.loads(l)["messages"]
        resposta = msg[-1]["content"]
        total += 1
        if resposta.count("?") >= 1: 
            com_pergunta += 1
    
    print(f"Total de respostas: {total}")
    print(f"Com ≥1 pergunta: {com_pergunta} ({100*com_pergunta/total:.1f}%)")

analisar("lev-variacoes.jsonl")