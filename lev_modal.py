import modal
import subprocess

APP_NAME = "lev-orchestrator"
MODEL_NAME = "celioNascimento/Lev-LoRA-Orquestrador-Merged"
VLLM_PORT = 8000

# Imagem com vLLM e Hugging Face Hub
vllm_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.6.3", "huggingface_hub")
)

app = modal.App(APP_NAME)

# Volume para cachear os pesos do modelo e acelerar o cold start
hf_cache_vol = modal.Volume.from_name("lev-hf-cache", create_if_missing=True)

@app.function(
    image=vllm_image,
    gpu="T4", # GPU de 24GB
    timeout=15 * 60,
    scaledown_window=5 * 60, # Desliga após 5 min sem uso
    volumes={"/root/.cache/huggingface": hf_cache_vol},
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
@modal.concurrent(max_inputs=10) # Permite requisições simultâneas
@modal.web_server(port=VLLM_PORT, startup_timeout=15 * 60)
def serve():
    # Inicia o servidor vLLM compatível com OpenAI
    subprocess.Popen([
        "vllm", "serve", MODEL_NAME,
        "--served-model-name", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--max-model-len", "4096",
        "--api-key", "lev-secret-key", # Chave simples para proteger o endpoint
    ])