# Environment Variables (Current Runtime Reference)

This reference is derived from current code paths in:

- `packages/coding-agent/src/**`
- `packages/ai/src/**` (provider/auth resolution used by coding-agent)
- `packages/utils/src/**` and `packages/tui/src/**` where those vars directly affect coding-agent runtime

It documents only active behavior.

## Resolution model and precedence

Most runtime lookups use `$env` from `@oh-my-pi/pi-utils` (`packages/utils/src/env.ts`).

`$env` loading order:

1. Existing process environment (`Bun.env`)
2. Project `.env` (`$PWD/.env`) for keys not already set
3. Agent `.env` (`~/.omp/agent/.env`, respecting `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`) for keys not already set
4. Config-root `.env` (`~/.omp/.env`, respecting `PI_CONFIG_DIR`) for keys not already set
5. Home `.env` (`~/.env`) for keys not already set

Additional rule inside each `.env` file: `OMP_*` keys are mirrored to `PI_*` keys in that parsed file.

---

## 1) Model/provider authentication

These are consumed via `getEnvApiKey()` (`packages/ai/src/stream.ts`) unless noted otherwise.

### Core provider credentials

| Variable                        | Used for                                         | Required when                                                  | Notes / precedence                                                                                  |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API auth                               | Using Anthropic with OAuth token auth                          | Takes precedence over `ANTHROPIC_API_KEY` for provider auth resolution                              |
| `ANTHROPIC_API_KEY`             | Anthropic API auth                               | Using Anthropic without OAuth token                            | Fallback after `ANTHROPIC_OAUTH_TOKEN`                                                              |
| `ANTHROPIC_FOUNDRY_API_KEY`     | Anthropic via Azure Foundry / enterprise gateway | `CLAUDE_CODE_USE_FOUNDRY` enabled                              | Takes precedence over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled  |
| `OPENAI_API_KEY`                | OpenAI auth                                      | Using OpenAI-family providers without explicit apiKey argument | Used by OpenAI Completions/Responses providers                                                      |
| `GEMINI_API_KEY`                | Google Gemini auth                               | Using `google` provider models                                 | Primary key for Gemini provider mapping                                                             |
| `GOOGLE_API_KEY`                | Gemini image tool auth fallback                  | Using `gemini_image` tool without `GEMINI_API_KEY`             | Used by coding-agent image tool fallback path                                                       |
| `GROQ_API_KEY`                  | Groq auth                                        | Using Groq models                                              |                                                                                                     |
| `CEREBRAS_API_KEY`              | Cerebras auth                                    | Using Cerebras models                                          |                                                                                                     |
| `FIREWORKS_API_KEY`             | Fireworks auth                                   | Using Fireworks models                                         |                                                                                                     |
| `TOGETHER_API_KEY`              | Together auth                                    | Using `together` provider                                      |                                                                                                     |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face auth                                | Using `huggingface` provider                                   | Primary Hugging Face token env var                                                                  |
| `HF_TOKEN`                      | Hugging Face auth                                | Using `huggingface` provider                                   | Fallback when `HUGGINGFACE_HUB_TOKEN` is unset                                                      |
| `SYNTHETIC_API_KEY`             | Synthetic auth                                   | Using Synthetic models                                         |                                                                                                     |
| `NVIDIA_API_KEY`                | NVIDIA auth                                      | Using `nvidia` provider                                        |                                                                                                     |
| `NANO_GPT_API_KEY`              | NanoGPT auth                                     | Using `nanogpt` provider                                       |                                                                                                     |
| `VENICE_API_KEY`                | Venice auth                                      | Using `venice` provider                                        |                                                                                                     |
| `LITELLM_API_KEY`               | LiteLLM auth                                     | Using `litellm` provider                                       | OpenAI-compatible LiteLLM proxy key                                                                 |
| `LM_STUDIO_API_KEY`             | LM Studio auth (optional)                        | Using `lm-studio` provider with authenticated hosts            | Local LM Studio usually runs without auth; any non-empty token works when a key is required         |
| `OLLAMA_API_KEY`                | Ollama auth (optional)                           | Using `ollama` provider with authenticated hosts               | Local Ollama usually runs without auth; any non-empty token works when a key is required            |
| `LLAMA_CPP_API_KEY`             | llama.cpp auth (optional)                        | Using `llama.cpp` provider with authenticated hosts            | Local llama.cpp usually runs without auth; any non-empty token works when a key is configured       |
| `XIAOMI_API_KEY`                | Xiaomi MiMo auth                                 | Using `xiaomi` provider                                        |                                                                                                     |
| `MOONSHOT_API_KEY`              | Moonshot auth                                    | Using `moonshot` provider                                      |                                                                                                     |
| `XAI_API_KEY`                   | xAI auth                                         | Using xAI models                                               |                                                                                                     |
| `OPENROUTER_API_KEY`            | OpenRouter auth                                  | Using OpenRouter models                                        | Also used by image tool when preferred/auto provider is OpenRouter                                  |
| `MISTRAL_API_KEY`               | Mistral auth                                     | Using Mistral models                                           |                                                                                                     |
| `ZAI_API_KEY`                   | z.ai auth                                        | Using z.ai models                                              | Also used by z.ai web search provider                                                               |
| `MINIMAX_API_KEY`               | MiniMax auth                                     | Using `minimax` provider                                       |                                                                                                     |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code auth                                | Using `minimax-code` provider                                  |                                                                                                     |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN auth                             | Using `minimax-code-cn` provider                               |                                                                                                     |
| `OPENCODE_API_KEY`              | OpenCode auth                                    | Using `opencode-go` / `opencode-zen` models                    |                                                                                                     |
| `QIANFAN_API_KEY`               | Qianfan auth                                     | Using `qianfan` provider                                       |                                                                                                     |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal auth                                 | Using `qwen-portal` with OAuth token                           | Takes precedence over `QWEN_PORTAL_API_KEY`                                                         |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal auth                                 | Using `qwen-portal` with API key                               | Fallback after `QWEN_OAUTH_TOKEN`                                                                   |
| `ZENMUX_API_KEY`                | ZenMux auth                                      | Using `zenmux` provider                                        | Used for ZenMux OpenAI and Anthropic-compatible routes                                              |
| `VLLM_API_KEY`                  | vLLM auth/discovery opt-in                       | Using `vllm` provider (local OpenAI-compatible servers)        | Any non-empty value works for no-auth local servers                                                 |
| `CURSOR_ACCESS_TOKEN`           | Cursor provider auth                             | Using Cursor provider                                          |                                                                                                     |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway auth                           | Using `vercel-ai-gateway` provider                             |                                                                                                     |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway auth                       | Using `cloudflare-ai-gateway` provider                         | Base URL must be configured as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan auth                         | Using `alibaba-coding-plan` provider                           |                                                                                                     |
| `DEEPSEEK_API_KEY`              | DeepSeek auth                                    | Using DeepSeek models                                          |                                                                                                     |
| `KILO_API_KEY`                  | Kilo auth                                        | Using Kilo models                                              |                                                                                                     |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud auth                                | Using `ollama-cloud` provider                                  |                                                                                                     |
| `GITLAB_TOKEN`                  | GitLab Duo auth                                  | Using `gitlab-duo` provider                                    |                                                                                                     |

### GitHub/Copilot token chains

| Variable               | Used for                                         | Chain                                                |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider auth                     | `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` |
| `GH_TOKEN`             | Copilot fallback; GitHub API auth in web scraper | In web scraper: `GITHUB_TOKEN` → `GH_TOKEN`          |
| `GITHUB_TOKEN`         | Copilot fallback; GitHub API auth in web scraper | In web scraper: checked before `GH_TOKEN`            |

---

## 2) Provider-specific runtime configuration

### Anthropic Foundry Gateway (Azure / enterprise proxy)

When `CLAUDE_CODE_USE_FOUNDRY` is enabled, Anthropic requests switch to Foundry mode:

- Base URL resolves from `FOUNDRY_BASE_URL` (fallback remains model/default base URL if unset).
- API key resolution for provider `anthropic` becomes:
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`.
- `ANTHROPIC_CUSTOM_HEADERS` is parsed as comma/newline-separated `key: value` pairs and merged into request headers.
- TLS client/server material can be injected from env values:
  `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`.
  Each accepts either:
  - a filesystem path to PEM content, or
  - inline PEM (including escaped `\n` sequences).

| Variable                    | Value type                                     | Behavior                                                                      |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `CLAUDE_CODE_USE_FOUNDRY`   | Boolean-like string (`1`, `true`, `yes`, `on`) | Enables Foundry mode for Anthropic provider                                   |
| `FOUNDRY_BASE_URL`          | URL string                                     | Anthropic endpoint base URL in Foundry mode                                   |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token string                                   | Used for `Authorization: Bearer <token>`                                      |
| `ANTHROPIC_CUSTOM_HEADERS`  | Header list string                             | Extra headers; format `header-a: value, header-b: value` or newline-separated |
| `NODE_EXTRA_CA_CERTS`       | PEM path or inline PEM                         | Extra CA chain for server certificate validation                              |
| `CLAUDE_CODE_CLIENT_CERT`   | PEM path or inline PEM                         | mTLS client certificate                                                       |
| `CLAUDE_CODE_CLIENT_KEY`    | PEM path or inline PEM                         | mTLS client private key (must be paired with cert)                            |

### Amazon Bedrock

| Variable                                                                        | Default / behavior                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                    | Primary region source                                                                         |
| `AWS_DEFAULT_REGION`                                                            | Fallback if `AWS_REGION` unset                                                                |
| `AWS_PROFILE`                                                                   | Enables named profile auth path                                                               |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                                   | Enables IAM key auth path                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK`                                                      | Enables bearer token auth path                                                                |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | Enables ECS task credential path                                                              |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                                  | Enables web identity auth path                                                                |
| `AWS_BEDROCK_SKIP_AUTH`                                                         | If `1`, injects dummy credentials (proxy/non-auth scenarios)                                  |
| `AWS_BEDROCK_FORCE_HTTP1`                                                       | If `1`, forces Node HTTP/1 request handler                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`                                      | Routes Bedrock runtime and AWS SSO credential calls through the configured proxy using HTTP/1 |
| `NO_PROXY`                                                                      | Excludes matching hosts from proxy routing when a proxy variable is configured                |

Region fallback in provider code: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

### Azure OpenAI Responses

| Variable                           | Default / behavior                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | Required unless API key passed as option                                    |
| `AZURE_OPENAI_API_VERSION`         | Default `v1`                                                                |
| `AZURE_OPENAI_BASE_URL`            | Direct base URL override                                                    |
| `AZURE_OPENAI_RESOURCE_NAME`       | Used to construct base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Optional mapping string: `modelId=deploymentName,model2=deployment2`        |

Base URL resolution: option `azureBaseUrl` → env `AZURE_OPENAI_BASE_URL` → option/env resource name → `model.baseUrl`.

### Google Vertex AI

| Variable                         | Required?                      | Notes                                                                                                                     |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes (unless passed in options) | Fallback: `GCLOUD_PROJECT`                                                                                                |
| `GCLOUD_PROJECT`                 | Fallback                       | Used as alternate project ID source                                                                                       |
| `GOOGLE_CLOUD_PROJECT_ID`        | OAuth login helper only        | Used by Gemini CLI OAuth project discovery                                                                                |
| `GOOGLE_CLOUD_LOCATION`          | Yes (unless passed in options) | No default in provider                                                                                                    |
| `GOOGLE_CLOUD_API_KEY`           | Conditional                    | Direct Vertex API-key auth; otherwise ADC fallback can authenticate when project and location are set                     |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional                    | If set, file must exist; otherwise ADC fallback path is checked (`~/.config/gcloud/application_default_credentials.json`) |

### Kimi

| Variable               | Default / behavior                                       |
| ---------------------- | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST` | Primary OAuth host override                              |
| `KIMI_OAUTH_HOST`      | Fallback OAuth host override                             |
| `KIMI_CODE_BASE_URL`   | Overrides Kimi usage endpoint base URL (`usage/kimi.ts`) |

OAuth host chain: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

### Gemini CLI compatibility

| Variable                   | Default / behavior                                              |
| -------------------------- | --------------------------------------------------------------- |
| `PI_AI_GEMINI_CLI_VERSION` | Overrides Gemini CLI user-agent version tag (`0.35.3` if unset) |

### OpenAI Codex responses (feature/debug controls)

| Variable                             | Behavior                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `PI_CODEX_DEBUG`                     | `1`/`true` enables Codex provider debug logging      |
| `PI_CODEX_WEBSOCKET`                 | `1`/`true` enables websocket transport preference    |
| `PI_CODEX_WEBSOCKET_V2`              | `1`/`true` enables websocket v2 path                 |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` | Positive integer override (default 300000)           |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET`    | Non-negative integer override (default 5)            |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS`  | Positive integer base backoff override (default 500) |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`   | Positive integer OpenAI stream idle timeout override |

### Cursor provider debug

| Variable           | Behavior                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `DEBUG_CURSOR`     | Enables provider debug logs; `2`/`verbose` for detailed payload snippets |
| `DEBUG_CURSOR_LOG` | Optional file path for JSONL debug log output                            |

### Prompt cache compatibility switch

| Variable             | Behavior                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | If `long`, enables long retention where supported (`anthropic`, `openai-responses`, Bedrock retention resolution) |

---

## 3) Web search subsystem

### Search provider credentials

| Variable                                            | Used by                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `EXA_API_KEY`                                       | Exa search provider and Exa MCP tools                         |
| `BRAVE_API_KEY`                                     | Brave search provider                                         |
| `PERPLEXITY_API_KEY`                                | Perplexity search provider API-key mode                       |
| `PERPLEXITY_COOKIES`                                | Perplexity cookie-auth search mode                            |
| `TAVILY_API_KEY`                                    | Tavily search provider                                        |
| `ZAI_API_KEY`                                       | z.ai search provider (also checks stored OAuth in `agent.db`) |
| `OPENAI_API_KEY` / Codex OAuth in DB                | Codex search provider availability/auth                       |
| `PI_CODEX_WEB_SEARCH_MODEL`                         | Codex search provider model override                          |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`   | Kimi/Moonshot search provider env auth                        |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot search endpoint override                        |
| `KAGI_API_KEY`                                      | Kagi search provider                                          |
| `JINA_API_KEY`                                      | Jina search provider                                          |
| `PARALLEL_API_KEY`                                  | Parallel search provider                                      |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`                 | SearXNG endpoint and bearer token                             |

### Anthropic web search auth chain

Anthropic web search uses `findAnthropicAuth()` from `packages/ai/src/utils/anthropic-auth.ts` in this order:

1. `ANTHROPIC_SEARCH_API_KEY` (+ optional `ANTHROPIC_SEARCH_BASE_URL`)
2. `ANTHROPIC_FOUNDRY_API_KEY` when `CLAUDE_CODE_USE_FOUNDRY` is enabled
3. Anthropic OAuth credentials from `agent.db` (must not expire within 5-minute buffer)
4. Anthropic API-key credentials from `agent.db`
5. Generic Anthropic env fallback: provider key (`ANTHROPIC_FOUNDRY_API_KEY` in Foundry mode, otherwise `ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`) + optional `ANTHROPIC_BASE_URL` (`FOUNDRY_BASE_URL` when Foundry mode is enabled)

Related vars:

| Variable                    | Default / behavior                                   |
| --------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_SEARCH_API_KEY`  | Highest-priority explicit search key                 |
| `ANTHROPIC_SEARCH_BASE_URL` | Defaults to `https://api.anthropic.com` when omitted |
| `ANTHROPIC_SEARCH_MODEL`    | Defaults to `claude-haiku-4-5`                       |
| `ANTHROPIC_BASE_URL`        | Generic fallback base URL for tier-4 auth path       |

### Perplexity OAuth flow behavior flag

| Variable            | Behavior                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `PI_AUTH_NO_BORROW` | If set, disables macOS native-app token borrowing path in Perplexity login flow |

---

## 4) Python tooling and kernel runtime

| Variable                  | Default / behavior                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PI_PY`                   | Python tool mode override: `0`/`bash`=`bash-only`, `1`/`py`=`ipy-only`, `mix`/`both`=`both`; invalid values ignored |
| `PI_PYTHON_SKIP_CHECK`    | If `1`, skips Python kernel availability checks/warm checks                                                         |
| `PI_PYTHON_GATEWAY_URL`   | If set, uses external kernel gateway instead of local shared gateway                                                |
| `PI_PYTHON_GATEWAY_TOKEN` | Optional auth token for external gateway (`Authorization: token <value>`)                                           |
| `PI_PYTHON_IPC_TRACE`     | If `1`, enables low-level IPC trace path in kernel module                                                           |
| `VIRTUAL_ENV`             | Highest-priority venv path for Python runtime resolution                                                            |

Extra conditional behavior:

- If `BUN_ENV=test` or `NODE_ENV=test`, Python availability checks are treated as OK and warming is skipped.
- Python env filtering denies common API keys and allows safe base vars + `LC_`, `XDG_`, `PI_` prefixes.

---

## 5) Agent/runtime behavior toggles

| Variable                     | Default / behavior                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`              | Ephemeral model-role override for `smol` (CLI `--smol` takes precedence)                           |
| `PI_SLOW_MODEL`              | Ephemeral model-role override for `slow` (CLI `--slow` takes precedence)                           |
| `PI_PLAN_MODEL`              | Ephemeral model-role override for `plan` (CLI `--plan` takes precedence)                           |
| `PI_NO_TITLE`                | If set (any non-empty value), disables auto session title generation on first user message         |
| `NULL_PROMPT`                | If `true`, system prompt builder returns empty string                                              |
| `PI_BLOCKED_AGENT`           | Blocks a specific subagent type in task tool                                                       |
| `PI_SUBPROCESS_CMD`          | Overrides subagent spawn command (`omp` / `omp.cmd` resolution bypass)                             |
| `PI_TASK_MAX_OUTPUT_BYTES`   | Max captured output bytes per subagent (default `500000`)                                          |
| `PI_TASK_MAX_OUTPUT_LINES`   | Max captured output lines per subagent (default `5000`)                                            |
| `PI_TIMING`                  | If `1`, enables startup/tool timing instrumentation logs                                           |
| `PI_DEBUG_STARTUP`           | Enables startup stage debug prints to stderr in multiple startup paths                             |
| `PI_PACKAGE_DIR`             | Overrides package asset base dir resolution (docs/examples/changelog path lookup)                  |
| `PI_DISABLE_LSPMUX`          | If `1`, disables lspmux detection/integration and forces direct LSP server spawning                |
| `PI_RPC_EMIT_TITLE`          | Boolean-like flag enabling title events in RPC mode                                                |
| `SMITHERY_URL`               | Smithery web URL override (default `https://smithery.ai`)                                          |
| `SMITHERY_API_URL`           | Smithery API base URL override (default `https://api.smithery.ai`)                                 |
| `PUPPETEER_EXECUTABLE_PATH`  | Browser tool Chromium executable override                                                          |
| `LM_STUDIO_BASE_URL`         | Default implicit LM Studio discovery base URL override (`http://127.0.0.1:1234/v1` if unset)       |
| `OLLAMA_BASE_URL`            | Default implicit Ollama discovery base URL override (`http://127.0.0.1:11434` if unset)            |
| `LLAMA_CPP_BASE_URL`         | Default implicit Llama.cpp discovery base URL override (`http://127.0.0.1:8080` if unset)          |
| `PI_EDIT_VARIANT`            | Forces edit tool variant when valid (`patch`, `replace`, `hashline`, `atom`, `vim`, `apply_patch`) |
| `PI_STRICT_EDIT_MODE`        | If truthy, disables automatic edit-mode fallback                                                   |
| `PI_FORCE_IMAGE_PROTOCOL`    | Forces supported image protocol (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) where used            |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | Allows SIXEL passthrough when `PI_FORCE_IMAGE_PROTOCOL=sixel`                                      |
| `PI_NO_PTY`                  | If `1`, disables interactive PTY path for bash tool                                                |

`PI_NO_PTY` is also set internally when CLI `--no-pty` is used.

---

## 6) Storage and config root paths

These are consumed via `@oh-my-pi/pi-utils/dirs` and affect where coding-agent stores data.

| Variable              | Default / behavior                                                            |
| --------------------- | ----------------------------------------------------------------------------- |
| `PI_CONFIG_DIR`       | Config root dirname under home (default `.omp`)                               |
| `PI_CODING_AGENT_DIR` | Full override for agent directory (default `~/<PI_CONFIG_DIR or .omp>/agent`) |
| `PWD`                 | Used when matching canonical current working directory in path helpers        |

---

## 7) Shell/tool execution environment

(From `packages/utils/src/procmgr.ts` and coding-agent bash tool integration.)

| Variable                   | Behavior                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `PI_BASH_NO_CI`            | Suppresses automatic `CI=true` injection into spawned shell env                |
| `CLAUDE_BASH_NO_CI`        | Legacy alias fallback for `PI_BASH_NO_CI`                                      |
| `PI_BASH_NO_LOGIN`         | Disables login-shell mode; shell args become `['-c']` instead of `['-l','-c']` |
| `CLAUDE_BASH_NO_LOGIN`     | Legacy alias fallback for `PI_BASH_NO_LOGIN`                                   |
| `PI_SHELL_PREFIX`          | Optional command prefix wrapper                                                |
| `CLAUDE_CODE_SHELL_PREFIX` | Legacy alias fallback for `PI_SHELL_PREFIX`                                    |
| `VISUAL`                   | Preferred external editor command                                              |
| `EDITOR`                   | Fallback external editor command                                               |

Current implementation: `PI_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` are active; when either is set, `getShellArgs()` returns `['-c']`.

---

## 8) UI/theme/session detection (auto-detected env)

These are read as runtime signals; they are usually set by the terminal/OS rather than manually configured.

| Variable                                                                                                           | Used for                                                  |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `COLORTERM`, `TERM`, `WT_SESSION`                                                                                  | Color capability detection (theme color mode)             |
| `COLORFGBG`                                                                                                        | Terminal background light/dark auto-detection             |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR`                                                        | Terminal identity in system prompt/context                |
| `KDE_FULL_SESSION`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `XDG_SESSION_DESKTOP`, `GDMSESSION`, `WINDOWMANAGER` | Desktop/window-manager detection in system prompt/context |
| `KITTY_WINDOW_ID`, `TMUX_PANE`, `TERM_SESSION_ID`, `WT_SESSION`                                                    | Stable per-terminal session breadcrumb IDs                |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM`                                                                         | System info diagnostics                                   |
| `APPDATA`, `XDG_CONFIG_HOME`                                                                                       | lspmux config path resolution                             |
| `HOME`                                                                                                             | Path shortening in MCP command UI                         |

---

## 9) TUI runtime flags (shared package, affects coding-agent UX)

| Variable                  | Behavior                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `PI_NOTIFICATIONS`        | `off` / `0` / `false` suppress desktop notifications                                  |
| `PI_TUI_WRITE_LOG`        | If set, logs TUI writes to file                                                       |
| `PI_HARDWARE_CURSOR`      | If `1`, enables hardware cursor mode                                                  |
| `PI_CLEAR_ON_SHRINK`      | If `1`, clears empty rows when content shrinks                                        |
| `PI_DEBUG_REDRAW`         | If `1`, enables redraw debug logging                                                  |
| `PI_TUI_DEBUG`            | If `1`, enables deep TUI debug dump path                                              |
| `PI_FORCE_IMAGE_PROTOCOL` | Forces terminal image protocol detection (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) |

---

## 10) Commit generation controls

| Variable                  | Behavior                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `PI_COMMIT_TEST_FALLBACK` | If `true` (case-insensitive), force commit fallback generation path |
| `PI_COMMIT_NO_FALLBACK`   | If `true`, disables fallback when agent returns no proposal         |
| `PI_COMMIT_MAP_REDUCE`    | If `false`, disables map-reduce commit analysis path                |
| `DEBUG`                   | If set, commit agent error stack traces are printed                 |

---

## Security-sensitive variables

Treat these as secrets; do not log or commit them:

- Provider/API keys and OAuth/bearer credentials (all `*_API_KEY`, `*_TOKEN`, OAuth access/refresh tokens)
- Cloud credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS` path may expose service-account material)
- Search/provider auth vars (`EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, Anthropic search keys)
- Foundry mTLS material (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS` when it points to private CA bundles)

Python runtime also explicitly strips many common key vars before spawning kernel subprocesses (`packages/coding-agent/src/ipy/runtime.ts`).
