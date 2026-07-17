import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type JsonObject = Record<string, unknown>;

export interface CodexEvent {
  method?: string;
  id?: number | string;
  params?: JsonObject;
  stream?: "stderr";
  line?: string;
}

export async function rpc<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
  return invoke<T>("codex_rpc", { method, params });
}

export async function respond(id: number | string, result: JsonObject): Promise<void> {
  await invoke("codex_respond", { id, result });
}

export async function onCodexEvent(handler: (event: CodexEvent) => void): Promise<UnlistenFn> {
  return listen<CodexEvent>("codex-event", ({ payload }) => handler(payload));
}

export async function saveOpenRouterKey(apiKey: string): Promise<void> {
  await invoke("save_openrouter_key", { apiKey });
}

export async function hasOpenRouterKey(): Promise<boolean> {
  return invoke<boolean>("has_openrouter_key");
}

export async function listOpenRouterModels<T>(): Promise<T> {
  return invoke<T>("list_openrouter_models");
}

export async function restartRuntime(): Promise<void> {
  await invoke("restart_runtime");
}
