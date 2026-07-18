use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct RuntimeState {
    server: Mutex<Option<Arc<AppServer>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexRuntimeStatus {
    available: bool,
    source: Option<&'static str>,
    path: Option<String>,
    version: Option<String>,
    compatible: bool,
    warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSkillFile {
    path: String,
    relative_path: String,
    file_name: String,
    default_name: String,
    description: String,
    supporting_markdown_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillBridgeConfig {
    source_path: String,
    name: String,
    enabled: bool,
}

impl AppServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let request_timeout = if method == "command/exec" {
            params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .map(|milliseconds| Duration::from_millis(milliseconds.saturating_add(30_000)))
                .unwrap_or_else(|| Duration::from_secs(330))
        } else {
            Duration::from_secs(120)
        };

        let message = json!({ "method": method, "id": id, "params": params });
        let mut stdin = self.stdin.lock().await;
        if let Err(error) = stdin.write_all(format!("{}\n", message).as_bytes()).await {
            self.alive.store(false, Ordering::Release);
            self.pending.lock().await.remove(&id);
            return Err(format!("Could not write to Codex App Server: {error}"));
        }
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush Codex App Server input: {error}"))?;
        drop(stdin);

        match timeout(request_timeout, receiver).await {
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
        self.alive.store(false, Ordering::Release);
        let _ = self.child.lock().await.kill().await;
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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

    let config_path = codex_home.join("config.toml");
    if tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
        return Ok(());
    }

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

    tokio::fs::write(config_path, config)
        .await
        .map_err(|error| format!("Could not write OpenKiwi runtime configuration: {error}"))
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

#[cfg(target_os = "macos")]
async fn find_with_login_shell() -> Option<PathBuf> {
    let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
    let output = Command::new(shell)
        .args(["-lc", "command -v codex"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|candidate| candidate.is_file())
}

#[cfg(not(target_os = "macos"))]
async fn find_with_login_shell() -> Option<PathBuf> {
    None
}

async fn resolve_codex_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };

    if let Some(override_path) = env::var_os("OPENKIWI_CODEX_PATH") {
        let override_path = PathBuf::from(override_path);
        return override_path.is_file().then_some(override_path).ok_or_else(|| {
            "OPENKIWI_CODEX_PATH does not point to a Codex executable. Update or remove it, then choose Try again.".into()
        });
    }

    if let Some(candidate) = find_on_path(executable_name) {
        push_candidate(&mut candidates, candidate);
    }

    #[cfg(target_os = "macos")]
    {
        push_candidate(
            &mut candidates,
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        push_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/codex"));
        push_candidate(&mut candidates, PathBuf::from("/usr/local/bin/codex"));
    }

    if let Ok(home) = app.path().home_dir() {
        #[cfg(target_os = "macos")]
        push_candidate(
            &mut candidates,
            home.join("Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        for relative in [
            ".local/bin/codex",
            ".cargo/bin/codex",
            ".npm-global/bin/codex",
            ".bun/bin/codex",
            ".volta/bin/codex",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }

    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell().await {
        return Ok(candidate);
    }

    Err("OpenKiwi could not find the Codex runtime. Install the Codex CLI or ChatGPT desktop app, then choose Try again. Advanced users can set OPENKIWI_CODEX_PATH to the Codex executable.".into())
}

fn runtime_source(path: &Path) -> &'static str {
    if path
        .to_string_lossy()
        .contains("ChatGPT.app/Contents/Resources/codex")
    {
        "ChatGPT app"
    } else if env::var_os("OPENKIWI_CODEX_PATH")
        .is_some_and(|configured| PathBuf::from(configured) == path)
    {
        "Custom path"
    } else {
        "Codex CLI"
    }
}

async fn runtime_version(path: &Path) -> Option<String> {
    let output = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn runtime_is_compatible(version: &str) -> bool {
    let number = version.split_whitespace().find(|part| {
        part.chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
    });
    let mut components = number.unwrap_or_default().split(['.', '-']);
    let major = components
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let minor = components
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    major > 0 || minor >= 145
}

#[tauri::command]
async fn codex_runtime_status(app: AppHandle) -> CodexRuntimeStatus {
    match resolve_codex_binary(&app).await {
        Ok(path) => {
            let version = runtime_version(&path).await;
            let compatible = version.as_deref().is_some_and(runtime_is_compatible);
            CodexRuntimeStatus {
                available: true,
                source: Some(runtime_source(&path)),
                path: Some(path.to_string_lossy().into_owned()),
                warning: (!compatible).then(|| "This Codex runtime predates OpenKiwi's tested App Server contract (0.145+). Update Codex before relying on advanced features.".to_string()),
                version,
                compatible,
            }
        }
        Err(_) => CodexRuntimeStatus {
            available: false,
            source: None,
            path: None,
            version: None,
            compatible: false,
            warning: None,
        },
    }
}

fn unix_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn state_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Could not create OpenKiwi app data: {error}"))?;
    Ok(app_data.join("openkiwi.sqlite3"))
}

fn open_state_db(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open OpenKiwi state database: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS audit_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               created_at INTEGER NOT NULL,
               kind TEXT NOT NULL,
               thread_id TEXT,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);",
        )
        .map_err(|error| format!("Could not initialize OpenKiwi state database: {error}"))?;
    Ok(connection)
}

#[tauri::command]
async fn state_read(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let path = state_db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_state_db(&path)?;
        let value = connection
            .query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .ok();
        value
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|error| format!("Stored OpenKiwi state is invalid: {error}"))
            })
            .transpose()
    })
    .await
    .map_err(|error| format!("State read task failed: {error}"))?
}

#[tauri::command]
async fn state_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let path = state_db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_state_db(&path)?;
        let json = serde_json::to_string(&value).map_err(|error| format!("Could not encode OpenKiwi state: {error}"))?;
        connection
            .execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, json, unix_timestamp_ms()],
            )
            .map_err(|error| format!("Could not save OpenKiwi state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("State write task failed: {error}"))?
}

#[tauri::command]
async fn audit_append(
    app: AppHandle,
    kind: String,
    thread_id: Option<String>,
    payload: Value,
) -> Result<(), String> {
    let path = state_db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_state_db(&path)?;
        let json = serde_json::to_string(&payload).map_err(|error| format!("Could not encode audit event: {error}"))?;
        connection
            .execute(
                "INSERT INTO audit_events(created_at, kind, thread_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![unix_timestamp_ms(), kind, thread_id, json],
            )
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Audit write task failed: {error}"))?
}

#[tauri::command]
async fn diagnostics_read(app: AppHandle) -> Result<Value, String> {
    let runtime = codex_runtime_status(app.clone()).await;
    let database = state_db_path(&app)?;
    let audit_path = database.clone();
    let audit = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let connection = open_state_db(&audit_path)?;
        let mut statement = connection
            .prepare("SELECT created_at, kind, thread_id, payload FROM audit_events ORDER BY created_at DESC LIMIT 200")
            .map_err(|error| format!("Could not read diagnostics audit history: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let payload: String = row.get(3)?;
                Ok(json!({
                    "createdAt": row.get::<_, i64>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "threadId": row.get::<_, Option<String>>(2)?,
                    "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)),
                }))
            })
            .map_err(|error| format!("Could not query diagnostics audit history: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode diagnostics audit history: {error}"))
    })
    .await
    .map_err(|error| format!("Diagnostics audit task failed: {error}"))??;
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "runtime": runtime,
        "stateDatabase": database,
        "platform": env::consts::OS,
        "architecture": env::consts::ARCH,
        "generatedAt": unix_timestamp_ms(),
        "auditEvents": audit,
    }))
}

#[tauri::command]
async fn diagnostics_export(app: AppHandle, path: String) -> Result<(), String> {
    let diagnostics = diagnostics_read(app).await?;
    let text = serde_json::to_string_pretty(&diagnostics)
        .map_err(|error| format!("Could not encode diagnostics: {error}"))?;
    tokio::fs::write(path, text)
        .await
        .map_err(|error| format!("Could not export diagnostics: {error}"))
}

const MAX_SKILL_FILE_BYTES: u64 = 1_048_576;
const MAX_SKILL_SCAN_DEPTH: usize = 8;
const MAX_SKILL_MARKDOWN_FILES: usize = 500;
const MAX_SKILL_MARKDOWN_BYTES: u64 = 16 * 1_048_576;

fn canonical_skill_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected skills path is not a folder.".into());
    }
    Ok(canonical)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

fn collect_skill_candidates(
    root: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH {
        return Ok(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_file() && is_markdown(&path) {
            let top_level_markdown = directory == root;
            let packaged_skill = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
            if top_level_markdown || packaged_skill {
                output.push(path);
            }
        } else if file_type.is_dir() {
            collect_skill_candidates(root, &path, depth + 1, output)?;
        }
    }
    Ok(())
}

fn split_skill_markdown(content: &str) -> (Option<String>, &str) {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (None, content);
    }
    let normalized = content.replace("\r\n", "\n");
    let Some(end) = normalized[4..].find("\n---\n").map(|index| index + 4) else {
        return (None, content);
    };
    let frontmatter = &normalized[4..end];
    let description = frontmatter.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("description") {
            return None;
        }
        let value = value.trim().trim_matches(['\'', '"']);
        (!value.is_empty()).then(|| value.to_string())
    });
    let body_offset = end + "\n---\n".len();
    let body = if content.contains("\r\n") {
        // Offset calculations above used normalized newlines. Find the second
        // delimiter in the original text instead so the returned slice is valid.
        let delimiter = "\r\n---\r\n";
        content
            .strip_prefix("---\r\n")
            .and_then(|rest| {
                rest.find(delimiter)
                    .map(|index| &rest[index + delimiter.len()..])
            })
            .unwrap_or(content)
    } else {
        content.get(body_offset..).unwrap_or(content)
    };
    (description, body)
}

fn skill_description(content: &str, fallback: &str) -> String {
    let (declared, body) = split_skill_markdown(content);
    if let Some(description) = declared {
        return description.chars().take(240).collect();
    }
    let paragraph = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("<!--"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if paragraph.is_empty() {
        format!("Instructions from {fallback}")
    } else {
        paragraph.chars().take(240).collect()
    }
}

fn skill_default_name(path: &Path) -> String {
    let is_package = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
    let raw = if is_package {
        path.parent().and_then(Path::file_name)
    } else {
        path.file_stem()
    };
    normalize_skill_name(raw.and_then(|value| value.to_str()).unwrap_or("skill"))
}

fn normalize_skill_name(value: &str) -> String {
    let mut output = String::new();
    let mut pending_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !output.is_empty() {
                output.push('-');
            }
            pending_dash = false;
            output.push(character);
        } else {
            pending_dash = true;
        }
        if output.len() >= 64 {
            break;
        }
    }
    output.trim_matches('-').to_string()
}

fn count_markdown_references(content: &str, source: &Path, folder: &Path) -> usize {
    let source_directory = source.parent().unwrap_or(folder);
    let canonical_folder = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf());
    let canonical_source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let mut remaining = content;
    let mut references = std::collections::HashSet::new();
    while let Some(start) = remaining.find("](") {
        remaining = &remaining[start + 2..];
        let Some(end) = remaining.find(')') else {
            break;
        };
        let target = remaining[..end].trim().trim_matches(['<', '>']);
        remaining = &remaining[end + 1..];
        let path_text = target.split(['#', '?']).next().unwrap_or_default().trim();
        if path_text.is_empty() || path_text.contains("://") || path_text.starts_with("mailto:") {
            continue;
        }
        let candidate = source_directory.join(path_text);
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if candidate.starts_with(&canonical_folder)
            && candidate.is_file()
            && is_markdown(&candidate)
            && candidate != canonical_source
        {
            references.insert(candidate);
        }
    }
    references.len()
}

fn scan_local_skills(folder: &Path) -> Result<Vec<LocalSkillFile>, String> {
    let mut candidates = Vec::new();
    collect_skill_candidates(folder, folder, 0, &mut candidates)?;
    let mut skills = Vec::new();
    for path in candidates.into_iter().take(MAX_SKILL_MARKDOWN_FILES) {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if metadata.len() > MAX_SKILL_FILE_BYTES {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md")
            .to_string();
        let supporting_markdown_count = count_markdown_references(&content, &path, folder);
        skills.push(LocalSkillFile {
            path: path.to_string_lossy().into_owned(),
            relative_path: path
                .strip_prefix(folder)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            file_name: file_name.clone(),
            default_name: skill_default_name(&path),
            description: skill_description(&content, &file_name),
            supporting_markdown_count,
        });
    }
    skills.sort_by(|left, right| {
        left.default_name
            .cmp(&right.default_name)
            .then(left.path.cmp(&right.path))
    });
    Ok(skills)
}

fn copy_markdown_tree(
    source_root: &Path,
    source_skill: &Path,
    destination: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH
        || *count >= MAX_SKILL_MARKDOWN_FILES
        || *bytes >= MAX_SKILL_MARKDOWN_BYTES
    {
        return Ok(());
    }
    let mut entries = fs::read_dir(source_root)
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            copy_markdown_tree(&path, source_skill, &target, depth + 1, count, bytes)?;
        } else if file_type.is_file() && is_markdown(&path) && path != source_skill {
            let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            if size > MAX_SKILL_FILE_BYTES
                || bytes.saturating_add(size) > MAX_SKILL_MARKDOWN_BYTES
                || *count >= MAX_SKILL_MARKDOWN_FILES
            {
                continue;
            }
            if target
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
            {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            }
            fs::copy(&path, &target)
                .map_err(|error| format!("Could not mirror {}: {error}", path.display()))?;
            *count += 1;
            *bytes += size;
        }
    }
    Ok(())
}

fn sync_skill_runtime_at(
    runtime_root: &Path,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<(), String> {
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    if runtime_root.exists() {
        fs::remove_dir_all(runtime_root)
            .map_err(|error| format!("Could not refresh the skill runtime: {error}"))?;
    }
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create the skill runtime: {error}"))?;

    let mut used_names = std::collections::HashSet::new();
    for config in configs.into_iter().filter(|config| config.enabled) {
        let source = PathBuf::from(&config.source_path)
            .canonicalize()
            .map_err(|error| format!("Could not open skill {}: {error}", config.source_path))?;
        if !source.starts_with(&folder) || !source.is_file() || !is_markdown(&source) {
            return Err(format!(
                "Skill source is outside the selected folder: {}",
                config.source_path
            ));
        }
        let name = normalize_skill_name(&config.name);
        if name.is_empty() {
            return Err(format!(
                "{} does not have a valid invocation name",
                source.display()
            ));
        }
        if !used_names.insert(name.clone()) {
            return Err(format!(
                "Two enabled skills use the invocation name `{name}`"
            ));
        }

        let content = fs::read_to_string(&source)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if content.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err(format!("{} is larger than 1 MB", source.display()));
        }
        let (declared_description, body) = split_skill_markdown(&content);
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md");
        let description =
            declared_description.unwrap_or_else(|| skill_description(body, file_name));
        let package = runtime_root.join(&name);
        fs::create_dir_all(&package)
            .map_err(|error| format!("Could not create skill `{name}`: {error}"))?;

        let reference_root = if file_name.eq_ignore_ascii_case("SKILL.md") {
            source.parent().unwrap_or(&folder)
        } else {
            &folder
        };
        let mut count = 0;
        let mut bytes = 0;
        copy_markdown_tree(reference_root, &source, &package, 0, &mut count, &mut bytes)?;

        let yaml_name = serde_json::to_string(&name).map_err(|error| error.to_string())?;
        let yaml_description =
            serde_json::to_string(&description.chars().take(500).collect::<String>())
                .map_err(|error| error.to_string())?;
        let bridge = format!(
            "---\nname: {yaml_name}\ndescription: {yaml_description}\n---\n\n<!-- Generated by OpenKiwi from {}. Edit the source file, not this bridge. -->\n\n{}\n",
            source.display(),
            body.trim_start(),
        );
        fs::write(package.join("SKILL.md"), bridge)
            .map_err(|error| format!("Could not prepare skill `{name}`: {error}"))?;
    }
    Ok(())
}

fn sync_skill_runtime(
    app: &AppHandle,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    let runtime_root = app_data.join("skill-runtime");
    sync_skill_runtime_at(&runtime_root, folder, configs)?;
    Ok(runtime_root)
}

#[tauri::command]
async fn local_skills_scan(folder: String) -> Result<Vec<LocalSkillFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        scan_local_skills(&folder)
    })
    .await
    .map_err(|error| format!("Skill scan failed: {error}"))?
}

#[tauri::command]
async fn local_skills_sync(
    app: AppHandle,
    folder: String,
    skills: Vec<SkillBridgeConfig>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        sync_skill_runtime(&app, &folder, skills).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill preparation failed: {error}"))?
}

fn available_import_path(folder: &Path, source_name: &str) -> PathBuf {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let extension = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let initial = folder.join(source_name);
    if !initial.exists() {
        return initial;
    }
    for index in 2..10_000 {
        let candidate = folder.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{stem}-imported.{extension}"))
}

#[tauri::command]
async fn local_skills_import(folder: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let mut imported = Vec::new();
        for raw in paths {
            let source = PathBuf::from(&raw)
                .canonicalize()
                .map_err(|error| format!("Could not open {raw}: {error}"))?;
            if !source.is_file() || !is_markdown(&source) {
                return Err(format!("Only Markdown files can be imported: {raw}"));
            }
            let size = fs::metadata(&source)
                .map(|metadata| metadata.len())
                .unwrap_or(MAX_SKILL_FILE_BYTES + 1);
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!("{} is larger than 1 MB", source.display()));
            }
            if source.parent().is_some_and(|parent| parent == folder) {
                imported.push(source.to_string_lossy().into_owned());
                continue;
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill.md");
            let destination = available_import_path(&folder, name);
            fs::copy(&source, &destination)
                .map_err(|error| format!("Could not import {}: {error}", source.display()))?;
            imported.push(destination.to_string_lossy().into_owned());
        }
        Ok(imported)
    })
    .await
    .map_err(|error| format!("Skill import failed: {error}"))?
}

#[tauri::command]
async fn local_skills_create(
    folder: String,
    name: String,
    instructions: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let invocation_name = normalize_skill_name(&name);
        if invocation_name.is_empty() {
            return Err("Enter a skill name containing letters or numbers.".into());
        }
        if instructions.trim().is_empty() {
            return Err("Enter instructions for the skill.".into());
        }
        if instructions.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err("Skill instructions must be smaller than 1 MB.".into());
        }
        let destination = available_import_path(&folder, &format!("{invocation_name}.md"));
        let title = name.trim();
        let content = format!("# {title}\n\n{}\n", instructions.trim());
        fs::write(&destination, content)
            .map_err(|error| format!("Could not create the skill: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill creation failed: {error}"))?
}

#[tauri::command]
async fn normal_chat_workspace(app: AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    let workspace = app_data.join("normal-chats");
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| format!("Could not create the normal chat workspace: {error}"))?;
    Ok(workspace.to_string_lossy().into_owned())
}

fn runtime_path(codex_binary: &Path, home: Option<&Path>) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut add = |path: PathBuf| {
        if !directories.contains(&path) {
            directories.push(path);
        }
    };

    if let Some(parent) = codex_binary.parent() {
        add(parent.to_path_buf());
        if parent.file_name().is_some_and(|name| name == "bin") {
            if let Some(runtime_root) = parent.parent() {
                add(runtime_root.join("codex-path"));
                add(runtime_root.join("codex-resources").join("zsh").join("bin"));
            }
        }
    }
    if let Some(current) = env::var_os("PATH") {
        for directory in env::split_paths(&current) {
            add(directory);
        }
    }
    for directory in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        add(PathBuf::from(directory));
    }
    if let Some(home) = home {
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
        ] {
            add(home.join(relative));
        }
    }

    env::join_paths(directories).ok()
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "openkiwi",
            "title": "OpenKiwi",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false,
            "mcpServerOpenaiFormElicitation": true
        }
    })
}

async fn spawn_server(app: &AppHandle) -> Result<Arc<AppServer>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let codex_home = app_data.join("codex-home");
    write_runtime_config(&codex_home).await?;

    let codex_binary = resolve_codex_binary(app).await?;
    let home = app.path().home_dir().ok();

    let mut command = Command::new(&codex_binary);
    command
        .arg("app-server")
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(path) = runtime_path(&codex_binary, home.as_deref()) {
        command.env("PATH", path);
    }

    if let Some(key) = openrouter_key() {
        command.env("OPENROUTER_API_KEY", key);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start the Codex runtime at `{}`: {error}",
            codex_binary.display()
        )
    })?;
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
    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_reader = alive.clone();

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

        alive_for_reader.store(false, Ordering::Release);
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
        alive,
    });

    server.request("initialize", initialize_params()).await?;
    server.notify("initialized", json!({})).await?;
    Ok(server)
}

async fn ensure_server(app: &AppHandle, state: &RuntimeState) -> Result<Arc<AppServer>, String> {
    let mut guard = state.server.lock().await;
    if let Some(server) = guard.as_ref() {
        if server.is_alive() {
            return Ok(server.clone());
        }
        let stale = guard.take();
        drop(guard);
        if let Some(stale) = stale {
            stale.shutdown().await;
        }
        guard = state.server.lock().await;
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
        "thread/unarchive",
        "thread/delete",
        "thread/search",
        "thread/settings/update",
        "thread/compact/start",
        "thread/backgroundTerminals/list",
        "thread/backgroundTerminals/clean",
        "thread/backgroundTerminals/terminate",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "review/start",
        "command/exec",
        "command/exec/write",
        "command/exec/resize",
        "command/exec/terminate",
        "process/spawn",
        "process/writeStdin",
        "process/resizePty",
        "process/kill",
        "skills/list",
        "skills/config/write",
        "skills/extraRoots/set",
        "mcpServerStatus/list",
        "mcpServer/oauth/login",
        "mcpServer/resource/read",
        "mcpServer/tool/call",
        "config/mcpServer/reload",
        "config/read",
        "config/value/write",
        "config/batchWrite",
        "modelProvider/capabilities/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "experimentalFeature/enablement/set",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/writeFile",
        "fs/readDirectory",
        "fs/getMetadata",
        "fuzzyFileSearch",
        "fuzzyFileSearch/sessionStart",
        "fuzzyFileSearch/sessionUpdate",
        "fuzzyFileSearch/sessionStop",
    ];
    // Methods that are safe to transparently re-send after the runtime is
    // respawned. Everything else (turn/start, command/exec, config writes, …)
    // may already have taken effect before the connection died, so an
    // automatic retry could run the action twice.
    const RETRYABLE_METHODS: &[&str] = &[
        "account/read",
        "account/rateLimits/read",
        "account/usage/read",
        "model/list",
        "thread/list",
        "thread/read",
        "thread/search",
        "skills/list",
        "mcpServerStatus/list",
        "config/read",
        "modelProvider/capabilities/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/readDirectory",
        "fs/getMetadata",
        "fuzzyFileSearch",
    ];
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "OpenKiwi's desktop bridge does not allow the RPC method `{method}`"
        ));
    }
    let server = ensure_server(&app, &state).await?;
    match server.request(&method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(error) if !server.is_alive() => {
            let mut guard = state.server.lock().await;
            if guard
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &server))
            {
                guard.take();
            }
            drop(guard);
            let recovered = ensure_server(&app, &state).await.map_err(|restart_error| {
                format!("{error}. OpenKiwi also could not restart the runtime: {restart_error}")
            })?;
            if RETRYABLE_METHODS.contains(&method.as_str()) {
                recovered.request(&method, params).await
            } else {
                Err(format!(
                    "{error}. The runtime was restarted; retry the action if it did not complete."
                ))
            }
        }
        Err(error) => Err(error),
    }
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            codex_runtime_status,
            state_read,
            state_write,
            audit_append,
            diagnostics_read,
            diagnostics_export,
            local_skills_scan,
            local_skills_sync,
            local_skills_import,
            local_skills_create,
            normal_chat_workspace,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_negotiates_fields_used_by_project_threads() {
        let params = initialize_params();
        assert_eq!(
            params.pointer("/capabilities/experimentalApi"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            params.pointer("/capabilities/mcpServerOpenaiFormElicitation"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            params.pointer("/capabilities/requestAttestation"),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn runtime_compatibility_accepts_tested_contract() {
        assert!(runtime_is_compatible("codex-cli 0.145.0-alpha.18"));
        assert!(!runtime_is_compatible("codex-cli 0.144.9"));
    }

    fn skill_test_directory(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "openkiwi-{label}-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        ))
    }

    #[test]
    fn local_skill_scan_uses_top_level_markdown_and_nested_skill_packages() {
        let root = skill_test_directory("skill-scan");
        fs::create_dir_all(root.join("references")).unwrap();
        fs::create_dir_all(root.join("packaged")).unwrap();
        fs::write(
            root.join("review.md"),
            "# Review\n\nReview changes carefully.\n\nRead [details](references/details.md).\n",
        )
        .unwrap();
        fs::write(
            root.join("references/details.md"),
            "# Details\n\nCheck edge cases.\n",
        )
        .unwrap();
        fs::write(root.join("packaged/SKILL.md"), "---\nname: ignored-source-name\ndescription: Package description\n---\n\nRun the package workflow.\n").unwrap();
        fs::write(root.join("packaged/guide.md"), "# Guide\n").unwrap();

        let skills = scan_local_skills(&root).unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.default_name.as_str())
                .collect::<Vec<_>>(),
            vec!["packaged", "review"]
        );
        assert_eq!(skills[0].description, "Package description");
        assert!(
            skills
                .iter()
                .find(|skill| skill.default_name == "review")
                .unwrap()
                .supporting_markdown_count
                >= 1
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_runtime_bridge_preserves_app_name_body_and_markdown_references() {
        let root = skill_test_directory("skill-runtime-source");
        let runtime = skill_test_directory("skill-runtime-output");
        fs::create_dir_all(root.join("references")).unwrap();
        let source = root.join("Release Notes.md");
        fs::write(&source, "---\nname: source-name\ndescription: Publish a careful release.\n---\n\n# Release\n\nRead [checks](references/checks.md), then publish.\n").unwrap();
        fs::write(
            root.join("references/checks.md"),
            "# Checks\n\nRun the tests.\n",
        )
        .unwrap();

        sync_skill_runtime_at(
            &runtime,
            &root,
            vec![SkillBridgeConfig {
                source_path: source.to_string_lossy().into_owned(),
                name: "ship-release".into(),
                enabled: true,
            }],
        )
        .unwrap();

        let bridge = fs::read_to_string(runtime.join("ship-release/SKILL.md")).unwrap();
        assert!(bridge.contains("name: \"ship-release\""));
        assert!(bridge.contains("description: \"Publish a careful release.\""));
        assert!(bridge.contains("# Release"));
        assert!(!bridge.contains("name: source-name"));
        assert!(runtime.join("ship-release/references/checks.md").is_file());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(runtime).unwrap();
    }
}
