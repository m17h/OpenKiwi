# OpenKiwi architecture

## Component map

```text
React webview
  ├─ projects + UI preferences (localStorage)
  ├─ chat/event rendering
  ├─ animated model/reasoning power rail
  └─ Studio: review, agents, terminal, history, context, usage, tools, and Git
          │ Tauri IPC (allowlisted commands)
          ▼
Rust desktop host
  ├─ OS credential store (OpenRouter key)
  ├─ isolated OpenKiwi app-data/Codex home
  ├─ JSON-RPC request correlation
  └─ child-process lifecycle
          │ JSONL over stdio
          ▼
Codex App Server
  ├─ ChatGPT browser authentication
  ├─ persisted threads and turns
  ├─ sandbox + approval enforcement
  ├─ opt-in direct child-agent orchestration
  ├─ coding tool loop
  └─ OpenAI or OpenRouter Responses transport
```

The control plane and execution plane remain separate. The React view never launches commands directly; it asks the Rust host, which talks to App Server. App Server owns the OS sandbox and pauses on approval requests.

## State ownership

| State | Owner | Location |
| --- | --- | --- |
| Project list | UI | Webview local storage |
| UI settings and visible prompt | UI | Webview local storage |
| OpenRouter API key | Native host | OS credential store |
| OpenRouter model catalog | Native host | Live tool-capable `/api/v1/models` response |
| ChatGPT login | App Server | OpenKiwi-specific `CODEX_HOME` credential storage |
| Threads and rollout history | App Server | OpenKiwi-specific `CODEX_HOME` |
| Active JSON-RPC requests | Native host | Memory only |
| Active approvals | UI + App Server | Memory only until answered |
| Checkpoint labels and review marks | UI | Webview local storage / memory |
| Terminal processes | App Server | Connection-scoped memory |
| Model catalog, usage, MCP and skill inventory | App Server | Refreshed runtime state |

OpenKiwi's private Codex home is under the platform Tauri app-data directory. The native host writes a controlled `config.toml` there on startup. Provider configuration cannot be overridden by project files.

## Thread creation contract

A new thread is created with:

- the selected project as `cwd`;
- the selected model/provider;
- the selected reasoning effort, including Ultra when eligible;
- the selected sandbox and approval policy;
- `baseInstructions` equal to the Settings prompt, including an explicit empty string;
- an empty `developerInstructions` value;
- project instruction loading disabled.
- sub-agent tools explicitly enabled or disabled, with a user-selected child cap and depth fixed at one.

These fields are set only when a thread is created. Existing threads retain their original prompt and provider context when resumed, which avoids silently rewriting conversation behavior.

## Sub-agent contract

OpenKiwi starts its private App Server with multi-agent support explicitly disabled, overriding the upstream default. A new thread can opt in through its config override:

- `features.multi_agent` mirrors the visible UI toggle;
- `agents.max_threads` is the exact concurrent child-agent limit selected by the user;
- `agents.max_depth = 1` permits only direct children;
- each child inherits the parent thread's sandbox and approval policy;
- no app-authored delegation instruction is added to the visible base or developer prompts.

The webview renders collaboration tool calls and child activity as structured timeline events. The Agent Studio can read child histories and interrupt individual children; the underlying App Server remains the owner of lifecycle and concurrency enforcement.

## Studio protocol map

| Surface | App Server/runtime contract |
| --- | --- |
| Review | `turn/diff/updated`, `gitDiffToRemote`, `review/start` |
| Agents | collaboration thread items, `thread/read`, `turn/interrupt` |
| Terminal | `command/exec`, streamed base64 output notifications, `command/exec/terminate` |
| History | `thread/fork`, `thread/rollback`; Git worktrees through sandboxed command execution |
| Context | `localImage` and explicit file mention inputs on `turn/start` |
| Usage | `thread/tokenUsage/updated`, `account/rateLimits/read` |
| Tools | `skills/list`, `mcpServerStatus/list` |
| Git | typed `git`/`gh` argv through `command/exec`; destructive tracked-file restore requires UI confirmation |

Standalone terminal and Git commands receive an explicit sandbox policy derived from the same Read only / Ask to act / Full access setting used by agent threads.

## Provider contract

### OpenAI

The native host starts App Server with a OpenKiwi-specific `CODEX_HOME`. The webview begins `account/login/start` with `type: "chatgpt"`, then opens the returned authorization URL. App Server owns the callback, token refresh, account state, and subscription rate-limit handling.

### OpenRouter

The native host defines a custom `openrouter` provider with:

```toml
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

The key comes from the OS credential store and is added only to the App Server child environment. Saving or replacing the key restarts App Server so the child receives the new credential.

## Protocol handling

The Rust host assigns numeric request IDs and stores one-shot response channels in a pending map. A stdout task parses JSONL:

- messages with `id` plus `result`/`error` resolve a pending client request;
- notifications and server-initiated requests are emitted to the webview;
- stderr is emitted only as diagnostic status text;
- connection loss fails all pending requests.

The webview handles streamed assistant deltas, completed items, command/file/sub-agent activities, live diffs, terminal bytes, token usage, account updates, turn lifecycle, and command/file approval requests.

## Deliberate constraints

- No remote App Server listener.
- Shell execution is available only through the allowlisted App Server terminal RPC and always carries the selected sandbox policy.
- No raw HTML/Markdown execution from model content.
- No automatic import of global Codex config, auth, skills, or project instructions.
- No silent provider fallback between OpenAI and OpenRouter.

## Planned hardening

- Bundle and hash a known App Server binary.
- Validate App Server version/protocol compatibility at startup.
- Move project and UI state to a native SQLite store with migrations.
- Add structured audit records for approvals and tool calls.
- Add a request-inspection mode backed by a test proxy or instrumented runtime.
- Add automated adversarial tests for malicious repository content and model output.
