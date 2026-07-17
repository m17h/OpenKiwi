use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

const KEYRING_SERVICE: &str = "com.kiwi.harness";
const OPENROUTER_ACCOUNT: &str = "openrouter-api-key";

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct AppServer {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: PendingMap,
    next_id: AtomicI64,
}

#[derive(Default)]
struct RuntimeState {
    server: Mutex<Option<Arc<AppServer>>>,
}

impl AppServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let message = json!({ "method": method, "id": id, "params": params });
        let mut stdin = self.stdin.lock().await;
        if let Err(error) = stdin.write_all(format!("{}\n", message).as_bytes()).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("Could not write to Codex App Server: {error}"));
        }
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush Codex App Server input: {error}"))?;
        drop(stdin);

        match timeout(Duration::from_secs(120), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex App Server stopped before replying".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "Codex App Server timed out while handling {method}"
                ))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|error| format!("Could not write notification: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush notification: {error}"))
    }

    async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let message = json!({ "id": id, "result": result });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|error| format!("Could not write server response: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush server response: {error}"))
    }

    async fn shutdown(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}

fn openrouter_key() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, OPENROUTER_ACCOUNT).ok()?;
    entry
        .get_password()
        .ok()
        .filter(|value| !value.trim().is_empty())
}

async fn write_runtime_config(codex_home: &PathBuf) -> Result<(), String> {
    tokio::fs::create_dir_all(codex_home)
        .await
        .map_err(|error| format!("Could not create OpenKiwi runtime directory: {error}"))?;

    let config = r#"cli_auth_credentials_store = "keyring"
model_provider = "openai"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
developer_instructions = ""

[agents]
max_threads = 1
max_depth = 1

[features]
multi_agent = false

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Add your OpenRouter API key in OpenKiwi Settings."
wire_api = "responses"
"#;

    tokio::fs::write(codex_home.join("config.toml"), config)
        .await
        .map_err(|error| format!("Could not write OpenKiwi runtime configuration: {error}"))
}

async fn spawn_server(app: &AppHandle) -> Result<Arc<AppServer>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let codex_home = app_data.join("codex-home");
    write_runtime_config(&codex_home).await?;

    let mut command = Command::new("codex");
    command
        .arg("app-server")
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(key) = openrouter_key() {
        command.env("OPENROUTER_API_KEY", key);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start `codex app-server`: {error}. Install Codex CLI and make sure it is on PATH."))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex App Server did not expose stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex App Server did not expose stdout".to_string())?;
    let stderr = child.stderr.take();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_for_reader = pending.clone();
    let app_for_reader = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                let _ = app_for_reader.emit(
                    "codex-event",
                    json!({ "stream": "stderr", "line": format!("Invalid app-server message: {line}") }),
                );
                continue;
            };

            let is_response = message.get("id").is_some()
                && (message.get("result").is_some() || message.get("error").is_some());
            if is_response {
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    if let Some(sender) = pending_for_reader.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown Codex App Server error")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                }
            } else {
                let _ = app_for_reader.emit("codex-event", message);
            }
        }

        let mut pending = pending_for_reader.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err("Codex App Server connection closed".into()));
        }
        let _ = app_for_reader.emit(
            "codex-event",
            json!({ "stream": "stderr", "line": "Codex App Server connection closed" }),
        );
    });

    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ =
                    app_for_stderr.emit("codex-event", json!({ "stream": "stderr", "line": line }));
            }
        });
    }

    let server = Arc::new(AppServer {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending,
        next_id: AtomicI64::new(1),
    });

    server
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "openkiwi",
                    "title": "OpenKiwi",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await?;
    server.notify("initialized", json!({})).await?;
    Ok(server)
}

async fn ensure_server(app: &AppHandle, state: &RuntimeState) -> Result<Arc<AppServer>, String> {
    let mut guard = state.server.lock().await;
    if let Some(server) = guard.as_ref() {
        return Ok(server.clone());
    }

    let server = spawn_server(app).await?;
    *guard = Some(server.clone());
    Ok(server)
}

#[tauri::command]
async fn codex_rpc(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    const ALLOWED_METHODS: &[&str] = &[
        "account/read",
        "account/login/start",
        "account/logout",
        "account/rateLimits/read",
        "account/usage/read",
        "model/list",
        "thread/list",
        "thread/start",
        "thread/resume",
        "thread/read",
        "thread/fork",
        "thread/rollback",
        "thread/name/set",
        "thread/archive",
        "turn/start",
        "turn/interrupt",
        "review/start",
        "command/exec",
        "command/exec/terminate",
        "skills/list",
        "mcpServerStatus/list",
        "gitDiffToRemote",
        "fuzzyFileSearch",
    ];
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "OpenKiwi's desktop bridge does not allow the RPC method `{method}`"
        ));
    }
    let server = ensure_server(&app, &state).await?;
    server.request(&method, params).await
}

#[tauri::command]
async fn codex_respond(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    let server = ensure_server(&app, &state).await?;
    server.respond(id, result).await
}

#[tauri::command]
async fn save_openrouter_key(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    api_key: String,
) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, OPENROUTER_ACCOUNT)
        .map_err(|error| format!("Could not open the OS credential store: {error}"))?;
    if api_key.trim().is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry
            .set_password(api_key.trim())
            .map_err(|error| format!("Could not save the OpenRouter key: {error}"))?;
    }

    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

#[tauri::command]
fn has_openrouter_key() -> bool {
    openrouter_key().is_some()
}

#[tauri::command]
async fn list_openrouter_models() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create the OpenRouter catalog client: {error}"))?;
    let mut request = client
        .get("https://openrouter.ai/api/v1/models?supported_parameters=tools&limit=1000")
        .header("X-Title", "OpenKiwi");
    if let Some(key) = openrouter_key() {
        request = request.bearer_auth(key);
    }
    request
        .send()
        .await
        .map_err(|error| format!("Could not reach the OpenRouter model catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenRouter rejected the model catalog request: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read the OpenRouter model catalog: {error}"))
}

#[tauri::command]
async fn restart_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            codex_rpc,
            codex_respond,
            save_openrouter_key,
            has_openrouter_key,
            list_openrouter_models,
            restart_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenKiwi");
}
