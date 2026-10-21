import os
import modal
import subprocess

APP_NAME = "lev-orchestrator"
MODEL_NAME = "celioNascimento/Lev-LoRA-Orquestrador-Merged"
VLLM_PORT = 8000

# Usando imagem com CUDA devel e versões compatíveis do vLLM e Transformers
vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.12")
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .pip_install(
        "vllm==0.8.5.post1",
        "transformers==4.51.3",
        "huggingface_hub"
    )
)

app = modal.App(APP_NAME)
hf_cache_vol = modal.Volume.from_name("lev-hf-cache", create_if_missing=True)

@app.function(
    image=vllm_image,
    gpu="L4",
    timeout=20 * 60,
    scaledown_window=20 * 60,
    volumes={"/root/.cache/huggingface": hf_cache_vol},
    secrets=[
        modal.Secret.from_name("huggingface-secret"),
        # Secret com a variável LEV_API_KEY (a mesma chave vai em MODAL_API_KEY no app).
        modal.Secret.from_name("lev-api-key"),
    ],
)
@modal.concurrent(max_inputs=10)
@modal.web_server(port=VLLM_PORT, startup_timeout=20 * 60)
def serve():
    subprocess.Popen([
        "vllm", "serve", MODEL_NAME,
        "--served-model-name", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--max-model-len", "8192",
        "--api-key", os.environ["LEV_API_KEY"],
        "--enforce-eager",
        "--enable-auto-tool-choice",      # Permite que o vLLM leia as ferramentas
        "--tool-call-parser", "hermes",   # Ensina a ler o formato JSON do Qwen
        # Forçando rope_scaling nulo por segurança
        "--hf-overrides", '{"rope_scaling": null}'
    ])