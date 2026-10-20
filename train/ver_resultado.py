import json
import random

# Carrega todas as linhas do arquivo gerado
linhas = [json.loads(l) for l in open('lev-variacoes-meta.jsonl', encoding='utf-8')]

# Pega 3 exemplos aleatórios
amostras = random.sample(linhas, 3)

for i, ex in enumerate(amostras, 1):
    print("="*80)
    print(f"EXEMPLO {i} (Variação {ex['variant']} da linha {ex['source_line']})")
    # Pega as mensagens do sistema, usuário e assistente
    msgs = ex['messages']
    for m in msgs:
        if m['role'] == 'system':
            print(f"⚙️ SISTEMA: {m['content'][:150]}...") # Corta o texto do sistema
        elif m['role'] == 'user':
            print(f"👤 USUÁRIO: {m['content']}")
        elif m['role'] == 'assistant':
            print(f"🤖 LEV: {m['content']}")
    print()