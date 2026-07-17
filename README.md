# OpenKiwi

OpenKiwi is a fast, local-first desktop coding harness with a user-owned instruction prompt. It supports OpenAI through an official ChatGPT subscription sign-in flow and OpenRouter through a user-supplied API key.

This repository contains a runnable desktop coding environment: projects, persistent threads, streamed agent events, three permission modes, provider setup, approval dialogs, an explicit empty-by-default instruction prompt, opt-in harness-level sub-agents, animated model controls, and an integrated workspace studio.

## Why this architecture

- **Tauri 2** keeps the native shell small and puts filesystem/process access behind Rust.
- **React + TypeScript** makes a polished, responsive thread UI straightforward.
- **Codex App Server** is the official open-source protocol for rich Codex clients. It provides ChatGPT sign-in, thread persistence, streaming, approvals, sandboxing, and model-provider support.
- **OpenRouter** is configured as a Responses-compatible model provider, so both providers use one event and tool model.

## Run it

Requirements:

- Node.js 20 or newer
- Rust stable
- A recent `codex` CLI available on `PATH`

```bash
npm install
npm run desktop
```

Useful checks:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

## Provider setup

### OpenAI subscription

Open **Settings → OpenAI → Sign in**. OpenKiwi starts the official Codex browser login through App Server. The resulting login is stored inside OpenKiwi's isolated Codex home rather than modifying the user's normal `~/.codex` state.

### OpenRouter

Open **Settings → OpenRouter** and save an API key. The composer then exposes a searchable picker backed by OpenRouter's live tool-capable model catalog, plus direct `provider/model` entry for new or private slugs. OpenKiwi stores the key in the operating system credential store and exposes it only to the local App Server child process.

OpenRouter's Responses API is currently beta, so compatibility can change upstream.

## Prompt transparency

For each new thread, OpenKiwi:

1. Sends the visible Settings prompt as App Server's explicit `baseInstructions` override. The default is the empty string.
2. Sends an empty app developer-instruction override.
3. Runs App Server with a private config that disables `AGENTS.md`/project-document instruction loading.
4. Renders model output as escaped text rather than executable HTML.

This means **OpenKiwi adds no secret instruction text**. It does not mean the entire inference stack is literally prompt-free: model providers can enforce platform policies, and a coding engine must still provide tool schemas and runtime metadata. A future wire-audit view should make those non-instruction request fields inspectable too.

The relevant OpenAI Codex source path treats `baseInstructions` as the highest-priority override and sends the empty value through to the Responses request. This behavior should be covered by an integration test whenever the bundled/pinned runtime work lands.

## Permissions

| OpenKiwi mode | Sandbox | Approval policy | Intended use |
| --- | --- | --- | --- |
| Read only | `read-only` | `never` | Inspect and explain without edits |
| Ask to act | `workspace-write` | `on-request` | Normal coding with approval for elevated actions |
| Full access | `danger-full-access` | `never` | Trusted projects where speed is preferred over isolation |

Approval requests are delivered as App Server server-initiated RPC calls and must be answered in OpenKiwi's modal before work continues.

## Sub-agents

Sub-agents are disabled by default. For a new thread, use the composer toggle or **Settings → Sub-agents** and choose a maximum concurrency from 1–24. When enabled, OpenKiwi exposes the App Server's native collaboration tools and lets the model decide whether delegation is useful.

- The selected maximum counts concurrently active child agents, not the root agent.
- Children inherit the root thread's sandbox and approval policy.
- Nesting is fixed at depth one, so children cannot spawn grandchildren.
- The setting is captured at thread creation and cannot silently change an existing thread.
- Spawn, interaction, wait, close, and interruption activity appears in the thread timeline.

OpenKiwi does not add a hidden instruction telling the model to delegate. The toggle controls tool availability at the harness layer.

## Model and reasoning control

When OpenAI subscription auth is selected, the composer exposes the current GPT-5.6 family as a branded animated control:

- **Sol** (`gpt-5.6-sol`) uses orange and targets detail, judgment, and polish.
- **Terra** (`gpt-5.6-terra`) uses light green and is the everyday workhorse.
- **Luna** (`gpt-5.6-luna`) uses light blue and favors clear, fast, repeatable work.

When OpenRouter is selected, the composer uses a compact searchable catalog with provider, context-window, and reasoning-capability metadata. A separate five-level reasoning slider is persisted and forwarded with thread and turn requests when the selected route supports reasoning.
- The reasoning rail maps Light, Medium, High, Extra High, and Max to the runtime's supported reasoning-effort values.
- The **Ultra** lever maps to Ultra reasoning, explicitly enables sub-agent access, and switches the control into an animated purple powered-up state. Account and model eligibility still come from App Server's model catalog.

Model and effort are sent as real thread/turn overrides. They are not presentation-only aliases.

## Workspace Studio

The right-side Studio contains eight integrated surfaces:

1. **Review** — live turn/Git diff, per-hunk review marks, whole-diff approval state, and an App Server review turn.
2. **Agents** — observed child threads, current status, child-thread inspection, and interruption.
3. **Terminal** — streamed project shell output with cancellation and the selected permission sandbox.
4. **History** — local checkpoints, App Server thread forks, conversation rollback, and real Git worktree creation.
5. **Context** — file mentions and native local-image inputs attached to the next turn.
6. **Usage** — token/context telemetry, account rate limits, and a visible request-field audit.
7. **Tools** — isolated-runtime skill inventory, MCP status/tool counts, and permission-boundary guidance.
8. **Git** — status, diff, stage, tracked-file revert confirmation, commits, PR comments, CI checks, and draft PR creation.

The review approval and checkpoint records are UI review state. Conversation rollback intentionally does not claim to revert filesystem changes; file rollback remains an explicit Git action.

## Security boundaries

- The webview can call only a small allowlist of App Server RPC methods.
- The packaged app has a restrictive Content Security Policy and no external font dependency.
- OpenRouter credentials use the OS keychain/keyring.
- ChatGPT credentials use Codex's isolated credential store.
- Model content is not rendered as HTML.
- App Server uses stdio and is never exposed as a network listener.

## Current scope and next milestones

The foundation is intentionally local-first and conservative. Before calling it a production release, the next milestones are:

1. Pin and bundle a tested Codex runtime instead of relying on the system `codex` binary.
2. Add protocol fixtures and end-to-end tests for login, thread resume, approvals, cancellation, and both providers.
3. Add protocol-level fixtures for every Studio action and adversarial tests for terminal/Git inputs.
4. Add durable native audit storage, richer per-line diff comments, and project-wide thread search.
5. Add code signing, auto-update, crash recovery, and cross-platform packaging.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component and state model.

## Upstream references

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Codex open-source repository](https://github.com/openai/codex)
- [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication)
- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview)
