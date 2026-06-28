# Local Models Setup Guide

Configure and use local LLMs with free-code via LM Studio, Ollama, or other OpenAI-compatible servers.

---

## Quick Start

### 1. Start your local model server

#### LM Studio

1. Download [LM Studio](https://lmstudio.ai)
2. Load a model
3. Start the local server (default: `http://localhost:1234/v1`)

#### Ollama

```bash
ollama pull mistral  # or any model
ollama serve
# Runs on http://localhost:11434
```

### 2. Create `~/.free-code/agent/models.json`

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lmstudio",
      "models": [
        { "id": "model-name-from-server" }
      ]
    }
  }
}
```

### 3. Verify the setup

```bash
free-code --list-models | grep lmstudio
```

### 4. Use your local model

```bash
free-code --provider lmstudio --model model-name-from-server
```

---

## Detailed Setup by Server

### LM Studio

**Installation:**

1. Download from [lmstudio.ai](https://lmstudio.ai)
2. Install and launch
3. In the app: **Search** → find a model → **Download**
4. After download: **Select a model** → **Start Server** (default port: 1234)

**Get the exact model ID:**

```bash
curl http://localhost:1234/v1/models
```

Look for the `id` field in the JSON response.

**Configuration (models.json):**

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lmstudio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "lmstudio/mistral-7b" }
      ]
    }
  }
}
```

**Usage:**

```bash
free-code --provider lmstudio --model lmstudio/mistral-7b
```

### Ollama

**Installation:**

```bash
# macOS
brew install ollama

# Linux / Windows / Docker
# Download from https://ollama.ai
```

**Download a model:**

```bash
ollama pull mistral
ollama pull llama2
ollama pull neural-chat
```

**Start the server:**

```bash
ollama serve
# Runs on http://localhost:11434 by default
```

**Get available models:**

```bash
curl http://localhost:11434/api/tags
```

**Configuration (models.json):**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "mistral" },
        { "id": "llama2" }
      ]
    }
  }
}
```

**Usage:**

```bash
free-code --provider ollama --model mistral
```

### Text Generation WebUI (oobabooga)

**Installation & setup:**

```bash
git clone https://github.com/oobabooga/text-generation-webui
cd text-generation-webui
pip install -r requirements.txt
python server.py --listen --api
```

Runs on `http://localhost:5000` by default.

**Configuration (models.json):**

```json
{
  "providers": {
    "textgen": {
      "baseUrl": "http://localhost:5000/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        { "id": "text-generation-webui" }
      ]
    }
  }
}
```

### vLLM

**Installation:**

```bash
pip install vllm
```

**Start the server:**

```bash
python -m vllm.entrypoints.openai.api_server --model mistralai/Mistral-7B-v0.1
```

Runs on `http://localhost:8000` by default.

**Configuration (models.json):**

```json
{
  "providers": {
    "vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        { "id": "mistralai/Mistral-7B-v0.1" }
      ]
    }
  }
}
```

### LocalAI

**Installation:**

```bash
docker run -p 8080:8080 -ti localai/localai:latest-amd64
```

Or build from source: [github.com/mudler/LocalAI](https://github.com/mudler/LocalAI)

**Configuration (models.json):**

```json
{
  "providers": {
    "localai": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        { "id": "gpt-3.5-turbo" }
      ]
    }
  }
}
```

---

## Configuration Reference

### Full models.json schema

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "http://localhost:PORT/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key-or-dummy",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "model-id-from-api",
          "name": "Display Name (optional)"
        }
      ]
    }
  }
}
```

### Fields explained

| Field | Type | Purpose |
|-------|------|---------|
| `baseUrl` | string | OpenAI API base URL (usually ends in `/v1`) |
| `api` | string | Always `"openai-completions"` for local models |
| `apiKey` | string | Any string (can be `"dummy"` or `"local"`) |
| `supportsDeveloperRole` | bool | Does the model support the `developer` role? |
| `supportsReasoningEffort` | bool | Does the model support `reasoning_effort`? |
| `id` | string | **Must match the API response** from `/v1/models` |
| `name` | string | Optional: display name in free-code UI |

---

## Testing your setup

### Test the server is running

```bash
curl http://localhost:1234/v1/models  # LM Studio
curl http://localhost:11434/api/tags  # Ollama
curl http://localhost:8000/v1/models  # vLLM
```

### Verify free-code can see the model

```bash
free-code --list-models
```

Look for your provider in the list.

### Test a conversation

```bash
free-code --provider lmstudio --model your-model-id
```

Type a message and press Enter. The agent should respond using your local model.

---

## Troubleshooting

### "Connection refused"

The server isn't running or on the wrong port:

```bash
netstat -tulpn | grep 1234  # Check if port is listening
lsof -i :1234               # Alternative check
```

Restart your server or adjust `baseUrl` in `models.json`.

### "Model not found"

The model ID in `models.json` doesn't match the server's actual model ID.

Get the correct ID:

```bash
curl http://localhost:1234/v1/models | jq '.data[].id'  # LM Studio
```

Update `models.json` with the exact ID.

### "Invalid request format"

The local server might not support the request format free-code sends. Try:

1. Update the server to the latest version
2. Check server logs for errors
3. Test with `curl` to ensure the server is working

### Slow responses

Local models are slower than cloud APIs. This is normal. For faster iteration during development, consider using a cloud provider as fallback.

### "Out of memory"

Local models need RAM:

- **7B models**: ~8GB VRAM
- **13B models**: ~16GB VRAM
- **70B models**: ~40GB VRAM (or use quantized versions)

If you're running out of memory, try:

1. A smaller model (e.g., 7B instead of 13B)
2. A quantized version (e.g., GGUF format in Ollama)
3. Reduce batch size or context length in your server config

---

## Setting a local model as default

Edit `~/.free-code/agent/settings.json`:

```json
{
  "defaultProvider": "lmstudio",
  "defaultModel": "lmstudio/mistral-7b"
}
```

Now `free-code` starts with your local model without needing flags.

---

## Using local models in VS Code / Cursor plugin

The plugin respects `~/.free-code/agent/models.json` automatically. Just configure it once and select your local model in the plugin's model picker.

**Configure via plugin settings** if you want a default:

In **Cursor** → **Settings...** (`⌘,`) → search `free-code`:

```json
{
  "free-code.provider": "lmstudio",
  "free-code.model": "lmstudio/mistral-7b"
}
```

---

## Performance tips

1. **Use quantized models** (smaller, faster) — Ollama defaults to these
2. **Increase server batch size** for better throughput
3. **GPU acceleration** — enable CUDA/Metal in your server config
4. **Keep context window small** — reduces memory and latency
5. **Test locally first** — before switching to a cloud provider

---

## Resources

- **LM Studio**: https://lmstudio.ai
- **Ollama**: https://ollama.ai
- **vLLM**: https://github.com/lm-sys/vllm
- **LocalAI**: https://github.com/mudler/LocalAI
- **Text Generation WebUI**: https://github.com/oobabooga/text-generation-webui
- **OpenAI API Spec**: https://platform.openai.com/docs/api-reference

---

## Saved configurations

### LM Studio — Gemma 4 (pablo)

Models loaded in LM Studio locally. Server must be running on `http://localhost:1234`.

```json
{
  "providers": {
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "google/gemma-4-26b-a4b",
          "name": "Gemma 4 26B (LM Studio)",
          "contextWindow": 32768,
          "maxTokens": 16384,
          "reasoning": true
        },
        {
          "id": "google/gemma-4-e2b",
          "name": "Gemma 4 E2B (LM Studio)",
          "contextWindow": 32768,
          "maxTokens": 16384,
          "reasoning": true
        }
      ]
    }
  }
}
```

Para restaurar: copia este bloque en `~/.free-code/agent/models.json`.

---

See also: [free-code-local-setup.md](free-code-local-setup.md) for broader configuration options.
