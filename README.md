# Hermes Prompt Autocomplete (`prompt-autocomplete`)

Zero-DOM-lag inline sentence autocomplete for the **Hermes Desktop** prompt composer with automatic **LTR (`→`)** and **RTL (`←`)** direction detection.

## Features

- **Implied LTR / RTL Direction Detection (No Manual Toggle)**:
  - Scans backwards from your caret for the last strong directional Unicode character (`[\u0590-\u08FF]` Hebrew/Arabic $\rightarrow$ **RTL** vs `[A-Za-z]` Latin $\rightarrow$ **LTR**).
  - **English / LTR**: Press **`→` (`ArrowRight`)** to accept the full sentence continuation, **`Ctrl + →`** to accept one word, or **`Tab`**.
  - **Hebrew / Arabic / RTL**: Press **`←` (`ArrowLeft`)** to accept the full sentence continuation, **`Ctrl + ←`** to accept one word, or **`Tab`**.
- **Zero Typing Lag**:
  - Never mutates the `contentEditable` DOM on keystrokes. Renders suggestions in `COMPOSER_AREAS.top` and commits accepted completions via `host.composer.setDraft()`.
- **Two-Tier Speed Architecture**:
  1. **Tier 1 (`< 1 ms` Local WebWorker)**: Off-main-thread Prefix & N-gram Trie pre-seeded from your local `state.db` prompt history plus built-in English & Hebrew developer phrases.
  2. **Tier 2 (`~500 ms` Fast Small-Model Completion)**: Routes novel prefixes through `agent.plugin_llm.PluginLlm` (using the registered `prompt_autocomplete` auxiliary task slot, or racing `qwen/qwen-2.5-7b-instruct`, `meta-llama/llama-3.1-8b-instruct`, `meta-llama/llama-4-scout`, and `google/gemini-3.5-flash-lite` when model override trust is enabled).

## Installation

```bash
hermes plugins install prompt-autocomplete
hermes plugins enable prompt-autocomplete
```

Optional — to enable the 4-model parallel fast race in `config.yaml`:

```yaml
plugins:
  entries:
    prompt-autocomplete:
      llm:
        allow_model_override: true
        allowed_models: ["*"]
```

## Disclosure (Catalog Rule 13)

- **Reads**: Reads up to 400 recent user prompt phrases from the active profile's `state.db` via `hermes_state.SessionDB` (`search_sessions`, `get_messages`) to seed the local in-memory WebWorker Trie. Never reads `.env` or credentials.
- **Network / LLM**: When the local WebWorker Trie has no match after a `90 ms` typing pause, sends the last 180 characters of the current draft line to the user's configured LLM provider via Hermes's host-owned `agent.plugin_llm.PluginLlm` facade (`max_tokens=10`).

## License

MIT — Copyright (c) 2026 Shachar Iphraimov (`iphraimov@gmail.com`)
