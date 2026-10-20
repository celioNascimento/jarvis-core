import json
import random

arquivo_emocional = 'lev-train-final.jsonl'
arquivo_agentico = 'lev-train-agentico.jsonl'
arquivo_final = 'lev-train-v3-orquestrador.jsonl'

todas_as_linhas = []

# Lê o emocional
with open(arquivo_emocional, 'r', encoding='utf-8') as f:
    for linha in f:
        if linha.strip(): todas_as_linhas.append(linha)

# Lê o agêntico
with open(arquivo_agentico, 'r', encoding='utf-8') as f:
    for linha in f:
        if linha.strip(): todas_as_linhas.append(linha)

# O SEGREDO: Embaralhar para o modelo não esquecer o emocional enquanto aprende ferramentas
random.seed(3407) # Semente para manter a reprodutibilidade
random.shuffle(todas_as_linhas)

with open(arquivo_final, 'w', encoding='utf-8') as f:
    for linha in todas_as_linhas:
        f.write(linha)

print(f"🎉 Dataset final criado! Total de exemplos: {len(todas_as_linhas)}")