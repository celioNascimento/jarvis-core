import json

proibidas = [
    "como posso ajudar", "É importante", "é difícil lidar", 
    "é natural se sentir", "reconhecer", "jornada", "processo",
    "sinto muito", "é compreensível", "passo a passo"
]

arquivo_entrada = 'lev-train-final.jsonl'
arquivo_saida = 'lev-train-limpo.jsonl'

total_original, total_mantido = 0, 0

with open(arquivo_saida, 'w', encoding='utf-8') as f_out:
    with open(arquivo_entrada, 'r', encoding='utf-8') as f_in:
        for linha in f_in:
            if not linha.strip(): continue
            total_original += 1
            msg = json.loads(linha)
            resposta = msg['messages'][-1]['content'].lower()
            
            # Se a resposta tem frases de coach, descartamos
            if any(p in resposta for p in proibidas):
                continue
            
            total_mantido += 1
            f_out.write(linha)

print(f"Original: {total_original} | Mantidos: {total_mantido} | Removidos: {total_original - total_mantido}")