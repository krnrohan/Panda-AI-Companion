use scrcap::CaptureDescriptor;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
#[cfg(target_os = "windows")]
use windows_capture::{dxgi_duplication_api::DxgiDuplicationApi, encoder::ImageFormat, monitor::Monitor};
#[cfg(target_os = "macos")]
use objc::class;

const KEYRING_SERVICE: &str = "com.pandacompany.companion";
const KEYRING_USER: &str = "openai-api-key";

#[derive(Default)]
struct AppState {
    capture: Arc<Mutex<CaptureSession>>,
    ollama: Arc<OllamaRequestState>,
    shortcut: Arc<Mutex<GlobalShortcutStatus>>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GlobalShortcutStatus { registered: bool, error: Option<String> }

impl GlobalShortcutStatus {
    fn from_registration(result: Result<(), String>) -> Self {
        match result {
            Ok(()) => Self { registered: true, error: None },
            Err(error) => Self { registered: false, error: Some(error) },
        }
    }
}

#[derive(Default)]
struct CaptureSession { capture: Option<scrcap::CaptureDesc>, epoch: u64, active: bool }

fn session_accepts_capture(session: &CaptureSession, epoch: u64) -> bool { session.active && session.epoch == epoch }

#[derive(Default)]
struct OllamaRequestState {
    active: Mutex<Option<ActiveOllamaRequest>>,
    next_id: AtomicU64,
}

struct ActiveOllamaRequest { id: u64, cancel: tokio::sync::watch::Sender<bool>, done: tokio::sync::watch::Receiver<bool> }

struct OllamaRequestGuard { state: Arc<OllamaRequestState>, id: u64, done: tokio::sync::watch::Sender<bool> }

impl Drop for OllamaRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active.lock() {
            if active.as_ref().is_some_and(|request| request.id == self.id) { *active = None; }
        }
        self.done.send_replace(true);
    }
}

fn request_cancelled_error() -> String { "The request was cancelled because the live session stopped or paused.".into() }

fn register_ollama_request(state: &AppState, session_epoch: Option<u64>) -> Result<(OllamaRequestGuard, tokio::sync::watch::Receiver<bool>), String> {
    // Always acquire the session lock before the request lock. Stop uses the same order,
    // so it cannot slip between the epoch check and request registration.
    let session = state.capture.lock().map_err(|_| "Screen session state is unavailable.".to_string())?;
    if let Some(epoch) = session_epoch {
        if !session_accepts_capture(&session, epoch) { return Err(request_cancelled_error()); }
    }
    let mut active = state.ollama.active.lock().map_err(|_| "Local model request state is unavailable.".to_string())?;
    if active.is_some() { return Err("An AI request is already running. Wait for it to finish; no request was queued.".into()); }
    let id = state.ollama.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    let (done, done_receiver) = tokio::sync::watch::channel(false);
    *active = Some(ActiveOllamaRequest { id, cancel, done: done_receiver });
    Ok((OllamaRequestGuard { state: state.ollama.clone(), id, done }, receiver))
}

async fn cancellable<F, T>(cancel: &mut tokio::sync::watch::Receiver<bool>, future: F) -> Result<T, String>
where F: std::future::Future<Output = T> {
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(request_cancelled_error()),
        result = future => Ok(result),
    }
}

#[derive(Serialize)]
struct ApiResult {
    text: String,
}

#[derive(Deserialize)]
struct ChatTurn { role: String, text: String }

#[derive(Deserialize)]
struct ResponseBody {
    output: Option<Vec<OutputItem>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct OutputItem {
    content: Option<Vec<OutputContent>>,
}

#[derive(Deserialize)]
struct OutputContent {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

#[derive(Deserialize)]
struct OllamaTags { models: Vec<OllamaTagModel> }

#[derive(Deserialize, Serialize)]
struct OllamaTagModel { name: String }

#[derive(Deserialize)]
struct OllamaShow { capabilities: Option<Vec<String>> }

#[derive(Deserialize, Clone)]
struct OllamaChatResponse {
    message: Option<OllamaChatMessage>,
    error: Option<String>,
    #[serde(default)] done: bool,
    done_reason: Option<String>,
    load_duration: Option<u64>,
    prompt_eval_duration: Option<u64>,
    eval_duration: Option<u64>,
}

#[derive(Deserialize, Clone)]
struct OllamaChatMessage { content: Option<String>, #[allow(dead_code)] thinking: Option<String> }

#[derive(Default)]
struct OllamaAccumulator { content: String, saw_thinking: bool, final_chunk: Option<OllamaChatResponse> }

impl OllamaAccumulator {
    fn push(&mut self, event: OllamaChatResponse) -> Result<Option<String>, String> {
        if let Some(error) = event.error.clone() { return Err(error); }
        let text = event.message.as_ref().and_then(|message| message.content.as_deref()).unwrap_or_default().to_string();
        self.saw_thinking |= event.message.as_ref().and_then(|message| message.thinking.as_deref()).is_some_and(|value| !value.trim().is_empty());
        if event.done { self.final_chunk = Some(event.clone()); }
        if text.is_empty() { return Ok(None); }
        self.content.push_str(&text);
        Ok(Some(text))
    }

    fn finish(self) -> Result<(String, OllamaChatResponse), String> {
        let final_chunk = self.final_chunk.ok_or_else(|| "Ollama ended the response before its done marker. Try again.".to_string())?;
        if self.content.trim().is_empty() {
            let reason = final_chunk.done_reason.as_deref().unwrap_or("unknown");
            let message = if self.saw_thinking { "Ollama produced internal reasoning but no user-facing answer. Try a shorter question or ask for a concise answer." }
                else if reason == "length" { "Ollama reached its output limit without producing an answer. Try a shorter question." }
                else { "Ollama completed the request without assistant message content. Check that the model is loaded correctly, then retry." };
            return Err(message.into());
        }
        Ok((self.content, final_chunk))
    }
}

fn parse_ollama_response(body: &[u8], error_message: &str) -> Result<OllamaChatResponse, String> {
    serde_json::from_slice(body).map_err(|_| error_message.to_string())
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OllamaTimings {
    http_ms: Option<f64>,
    model_load_ms: Option<f64>,
    prompt_eval_ms: Option<f64>,
    inference_ms: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OllamaStreamEvent { kind: &'static str, text: Option<String>, elapsed_ms: Option<f64>, timings: Option<OllamaTimings> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCapabilities { vision: bool, thinking: bool }

#[derive(Serialize)]
struct CapturedScreen {
    data_url: String,
    app_name: String,
    capture_wait_ms: f64,
    encode_ms: f64,
    queued_frames_dropped: u32,
    source_width: u32,
    source_height: u32,
    image_width: u32,
    image_height: u32,
    image_bytes: usize,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DxgiMonitorInfo { index: usize, name: String, width: u32, height: u32, primary: bool }

#[cfg(target_os = "windows")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DxgiFrame { data_url: String, width: u32, height: u32 }

#[cfg(target_os = "windows")]
#[tauri::command]
fn enumerate_dxgi_monitors() -> Result<Vec<DxgiMonitorInfo>, String> {
    let monitors = Monitor::enumerate().map_err(|e| format!("DXGI monitor enumeration failed: {e:?}"))?;
    let primary = Monitor::primary().ok().and_then(|m| m.index().ok());
    monitors.into_iter().map(|m| Ok(DxgiMonitorInfo {
        index: m.index().map_err(|e| format!("Could not read monitor index: {e:?}"))?,
        name: m.name().map_err(|e| format!("Could not read monitor name: {e:?}"))?,
        width: m.width().map_err(|e| format!("Could not read monitor width: {e:?}"))?,
        height: m.height().map_err(|e| format!("Could not read monitor height: {e:?}"))?,
        primary: Some(m.index().map_err(|e| format!("Could not read monitor index: {e:?}"))?) == primary,
    })).collect()
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn capture_dxgi_frame(monitor_index: usize) -> Result<DxgiFrame, String> {
    tokio::task::spawn_blocking(move || {
        let monitors = Monitor::enumerate().map_err(|e| format!("DXGI EnumDisplayMonitors failed: {e:?}"))?;
        if !monitors.iter().any(|m| m.index().ok() == Some(monitor_index)) {
            return Err(format!("Monitor index {monitor_index} is no longer available. Refresh monitors and select one."));
        }
        let monitor = Monitor::from_index(monitor_index).map_err(|e| format!("DXGI Monitor::from_index({monitor_index}) failed: {e:?}"))?;
        let width = monitor.width().map_err(|e| format!("DXGI monitor width query failed: {e:?}"))?;
        let height = monitor.height().map_err(|e| format!("DXGI monitor height query failed: {e:?}"))?;
        let mut duplication = DxgiDuplicationApi::new(monitor).map_err(|e| format!("DXGI duplication initialization failed: {e:?}"))?;
        let mut frame = duplication.acquire_next_frame(1500).map_err(|e| format!("DXGI acquire_next_frame timed out or failed: {e:?}"))?;
        let path = std::env::temp_dir().join(format!("panda-dxgi-{}.png", std::process::id()));
        frame.save_as_image(&path, ImageFormat::Png).map_err(|e| format!("DXGI PNG conversion failed: {e:?}"))?;
        let bytes = std::fs::read(&path).map_err(|e| format!("Could not read captured PNG: {e}"))?;
        let _ = std::fs::remove_file(&path);
        Ok(DxgiFrame { data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)), width, height })
    }).await.map_err(|e| format!("DXGI capture worker failed: {e}"))?
}

#[tauri::command]
async fn ollama_status() -> Result<Vec<OllamaTagModel>, String> {
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(5)).build()
        .map_err(|_| "Could not prepare a connection to local Ollama.".to_string())?;
    let response = client.get("http://127.0.0.1:11434/api/tags").send().await
        .map_err(|_| "Ollama is not responding at 127.0.0.1:11434. Start Ollama and refresh.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Ollama returned HTTP {} while listing models.", response.status()));
    }
    let tags: OllamaTags = response.json().await
        .map_err(|_| "Ollama returned an unreadable model list.".to_string())?;
    Ok(tags.models)
}

#[tauri::command]
async fn ollama_model_supports_vision(model: String) -> Result<bool, String> {
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(10)).build()
        .map_err(|_| "Could not prepare a connection to local Ollama.".to_string())?;
    let response = client.post("http://127.0.0.1:11434/api/show")
        .json(&serde_json::json!({"model": model})).send().await
        .map_err(|_| "Ollama is not responding. Start it and refresh the model list.".to_string())?;
    if response.status().as_u16() == 404 {
        return Err(format!("Model is unavailable. Install it with `ollama pull {model}`."));
    }
    if !response.status().is_success() {
        return Err(format!("Ollama could not inspect this model (HTTP {}).", response.status()));
    }
    let details: OllamaShow = response.json().await
        .map_err(|_| "Ollama returned unreadable model details.".to_string())?;
    Ok(details.capabilities.unwrap_or_default().iter().any(|capability| capability == "vision"))
}

async fn ollama_capabilities(model: &str) -> Result<ModelCapabilities, String> {
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(10)).build()
        .map_err(|_| "Could not prepare a connection to local Ollama.".to_string())?;
    let response = client.post("http://127.0.0.1:11434/api/show")
        .json(&serde_json::json!({"model": model})).send().await
        .map_err(|_| "Ollama is not responding. Start it and refresh the model list.".to_string())?;
    if response.status().as_u16() == 404 { return Err(format!("Model is unavailable. Install it with `ollama pull {model}`.")); }
    if !response.status().is_success() { return Err(format!("Ollama could not inspect this model (HTTP {}).", response.status())); }
    let details: OllamaShow = response.json().await.map_err(|_| "Ollama returned unreadable model details.".to_string())?;
    let caps = details.capabilities.unwrap_or_default();
    Ok(ModelCapabilities { vision: caps.iter().any(|cap| cap == "vision"), thinking: caps.iter().any(|cap| cap == "thinking") })
}

#[tauri::command]
async fn ollama_model_capabilities(model: String) -> Result<ModelCapabilities, String> { ollama_capabilities(&model).await }

#[tauri::command]
async fn ask_ollama(
    question: String,
    image_data_url: Option<String>,
    screen_text: Option<String>,
    history: Vec<ChatTurn>,
    model: String,
    session_epoch: Option<u64>,
    routine: bool,
    detailed: bool,
    on_event: Channel<OllamaStreamEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<ApiResult, String> {
    let (_request_guard, mut cancel_rx) = register_ollama_request(&state, session_epoch)?;
    let model_capabilities = cancellable(&mut cancel_rx, ollama_capabilities(&model)).await??;
    let image = if let Some(data_url) = image_data_url {
        if !model_capabilities.vision {
            return Err(format!("{model} does not support images. Select an installed vision model to use screen sharing."));
        }
        let encoded = data_url.strip_prefix("data:image/jpeg;base64,").or_else(|| data_url.strip_prefix("data:image/png;base64,"))
            .ok_or_else(|| "The captured image must be a base64 PNG or JPEG data URL.".to_string())?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded)
            .map_err(|_| "The captured image contains invalid base64 data.".to_string())?;
        if decoded.len() > 8 * 1024 * 1024 { return Err("This screenshot exceeds the 8 MB local model limit.".into()); }
        if !(decoded.starts_with(b"\x89PNG\r\n\x1a\n") || decoded.starts_with(&[0xff, 0xd8, 0xff])) {
            return Err("The image data does not match its PNG or JPEG format.".into());
        }
        Some(encoded.to_string())
    } else { None };

    let mut messages = history.iter().rev().take(12).collect::<Vec<_>>();
    messages.reverse();
    let mut turns = messages.into_iter().filter_map(|turn| {
        let role = match turn.role.as_str() { "user" => "user", "panda" => "assistant", _ => return None };
        Some(serde_json::json!({"role": role, "content": turn.text.chars().take(4000).collect::<String>()}))
    }).collect::<Vec<_>>();
    let mut prompt = question;
    if let Some(text) = screen_text.filter(|text| !text.trim().is_empty()) {
        prompt.push_str("\n\nText visible on the shared screen, extracted locally:\n");
        prompt.push_str(&text.chars().take(12_000).collect::<String>());
    }
    let mut user_turn = serde_json::json!({"role": "user", "content": prompt});
    let supports_thinking = model_capabilities.thinking;
    if let Some(image) = image {
        user_turn["images"] = serde_json::json!([image]);
    }
    turns.push(user_turn);

    let max_tokens = if routine { 96 } else if detailed { 768 } else { 256 };
    let mut payload = serde_json::json!({
        "model": model,
        "messages": turns,
        "stream": true,
        "keep_alive": "10m",
        "options": {"num_predict": max_tokens}
    });
    if supports_thinking && detailed { payload["think"] = serde_json::json!(true); }
    else if supports_thinking && (routine || !detailed) { payload["think"] = serde_json::json!(false); }

    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(300)).build()
        .map_err(|_| "Could not prepare a connection to local Ollama.".to_string())?;
    eprintln!("[Panda AI] provider=ollama model={model} request=started");
    let started = Instant::now();
    let response = match cancellable(&mut cancel_rx, client.post("http://127.0.0.1:11434/api/chat").json(&payload).send()).await? {
        Ok(response) => response,
        Err(_) => {
            eprintln!("[Panda AI] provider=ollama model={model} http_status=unavailable elapsed_ms={:.0}", started.elapsed().as_secs_f64() * 1000.0);
            return Err("Ollama stopped responding. Make sure it is running and the model is installed.".to_string());
        }
    };
    let http_ms = started.elapsed().as_secs_f64() * 1000.0;
    let status = response.status();
    eprintln!("[Panda AI] provider=ollama model={model} http_status={} headers_elapsed_ms={http_ms:.0}", status.as_u16());
    if !status.is_success() {
        let body = cancellable(&mut cancel_rx, response.text()).await?.unwrap_or_default();
        let message = serde_json::from_str::<OllamaChatResponse>(&body).ok().and_then(|parsed| parsed.error)
            .unwrap_or_else(|| format!("Ollama returned HTTP {status}."));
        if message.to_lowercase().contains("not found") { return Err(format!("Model is unavailable. Install it with `ollama pull {model}`.")); }
        return Err(message);
    }

    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let mut accumulator = OllamaAccumulator::default();
    if content_type.contains("application/json") && !content_type.contains("ndjson") {
        let bytes = cancellable(&mut cancel_rx, response.bytes()).await?.map_err(|_| "Ollama returned an unreadable response body.".to_string())?;
        let event = parse_ollama_response(&bytes, "Ollama returned malformed JSON instead of a chat response.")?;
        if let Some(text) = accumulator.push(event)? {
            on_event.send(OllamaStreamEvent { kind: "firstToken", text: None, elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.0), timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?;
            on_event.send(OllamaStreamEvent { kind: "delta", text: Some(text), elapsed_ms: None, timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?;
        }
    } else {
        let mut response = response;
        let mut buffer = Vec::<u8>::new();
        loop {
            let chunk = cancellable(&mut cancel_rx, response.chunk()).await?.map_err(|_| "Ollama's streaming response was interrupted.".to_string())?;
            let Some(chunk) = chunk else { break; };
            buffer.extend_from_slice(&chunk);
            if buffer.len() > 1_048_576 { return Err("Ollama sent an unexpectedly large response chunk.".into()); }
            while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                let mut line = buffer.drain(..=newline).collect::<Vec<_>>(); line.pop();
                if line.last() == Some(&b'\r') { line.pop(); }
                if line.iter().all(u8::is_ascii_whitespace) { continue; }
                let event = parse_ollama_response(&line, "Ollama returned malformed streaming JSON.")?;
                if let Some(text) = accumulator.push(event)? {
                    let first = accumulator.content == text;
                    if first { on_event.send(OllamaStreamEvent { kind: "firstToken", text: None, elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.0), timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?; }
                    on_event.send(OllamaStreamEvent { kind: "delta", text: Some(text), elapsed_ms: None, timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?;
                }
            }
        }
        if !buffer.iter().all(u8::is_ascii_whitespace) {
            let event = parse_ollama_response(&buffer, "Ollama returned a malformed or incomplete streaming response.")?;
            if let Some(text) = accumulator.push(event)? {
                let first = accumulator.content == text;
                if first { on_event.send(OllamaStreamEvent { kind: "firstToken", text: None, elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.0), timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?; }
                on_event.send(OllamaStreamEvent { kind: "delta", text: Some(text), elapsed_ms: None, timings: None }).map_err(|_| "The chat window closed before the response finished.".to_string())?;
            }
        }
    }
    let (answer, final_chunk) = accumulator.finish()?;
    let timings = OllamaTimings {
        http_ms: Some(http_ms),
        model_load_ms: final_chunk.load_duration.map(|ns| ns as f64 / 1_000_000.0),
        prompt_eval_ms: final_chunk.prompt_eval_duration.map(|ns| ns as f64 / 1_000_000.0),
        inference_ms: final_chunk.eval_duration.map(|ns| ns as f64 / 1_000_000.0),
    };
    on_event.send(OllamaStreamEvent { kind: "metrics", text: None, elapsed_ms: None, timings: Some(timings) })
        .map_err(|_| "The chat window closed before the response finished.".to_string())?;
    eprintln!("[Panda AI] provider=ollama model={model} http_status={} status=success elapsed_ms={:.0} response_chars={}", status.as_u16(), started.elapsed().as_secs_f64() * 1000.0, answer.chars().count());
    Ok(ApiResult { text: answer })
}

#[tauri::command]
fn has_api_key() -> bool {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.get_password())
        .is_ok()
}

#[tauri::command]
fn global_shortcut_status(state: tauri::State<'_, AppState>) -> Result<GlobalShortcutStatus, String> {
    state.shortcut.lock().map(|status| status.clone()).map_err(|_| "Shortcut status is unavailable.".to_string())
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let key = api_key.trim();
    if !key.starts_with("sk-") || key.len() < 20 {
        return Err("That does not look like an OpenAI API key.".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.set_password(key))
        .map_err(|_| "Could not save the key to the operating system's secure credential store.".to_string())
}

#[tauri::command]
fn remove_api_key() -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|entry| entry.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the saved API key.".into()),
    }
}

#[tauri::command]
async fn validate_api_key(api_key: String) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build()
        .map_err(|_| "Could not prepare the OpenAI connection.".to_string())?;
    let response = client.get("https://api.openai.com/v1/models")
        .bearer_auth(api_key.trim()).send().await
        .map_err(|_| "Could not reach OpenAI to verify the key.".to_string())?;
    if response.status().is_success() { Ok(()) }
    else if response.status().as_u16() == 401 { Err("OpenAI rejected this API key. Check it and try again.".into()) }
    else { Err(format!("OpenAI key check failed (HTTP {}).", response.status())) }
}

#[tauri::command]
async fn ask_openai(question: String, image_data_url: Option<String>, screen_text: Option<String>, history: Vec<ChatTurn>, session_epoch: Option<u64>, state: tauri::State<'_, AppState>) -> Result<ApiResult, String> {
    let (_request_guard, mut cancel_rx) = register_ollama_request(&state, session_epoch)?;
    let started = Instant::now();
    let api_key = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.get_password())
        .map_err(|_| {
            eprintln!("[Panda AI] provider=openai status=missing_key elapsed_ms={:.0}", started.elapsed().as_secs_f64() * 1000.0);
            "Add your OpenAI API key in settings before chatting.".to_string()
        })?;

    let mut content = Vec::new();
    let mut prompt = question;
    if let Some(text) = screen_text.filter(|text| !text.trim().is_empty()) {
        prompt.push_str("\n\nText visible on the shared screen (extracted locally):\n");
        prompt.push_str(&text.chars().take(12_000).collect::<String>());
    }
    content.push(serde_json::json!({"type": "input_text", "text": prompt}));
    if let Some(data_url) = image_data_url {
        if let Some((mime, encoded)) = data_url.split_once(",") {
            let mime = mime.strip_prefix("data:").and_then(|v| v.strip_suffix(";base64")).unwrap_or("image/png");
            if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
                return Err("The captured image format is not supported.".into());
            }
            let bytes = STANDARD.decode(encoded).map_err(|_| "The captured image could not be read.".to_string())?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("This screenshot is too large to send. Try again with a smaller display.".into());
            }
            content.push(serde_json::json!({"type": "input_image", "image_url": format!("data:{mime};base64,{encoded}")}));
        }
    }

    let mut input = history.iter().rev().take(12).collect::<Vec<_>>();
    input.reverse();
    let mut turns = input.into_iter().filter_map(|turn| {
        let role = match turn.role.as_str() { "user" => "user", "panda" => "assistant", _ => return None };
        Some(serde_json::json!({"role": role, "content": [{"type": "input_text", "text": turn.text.chars().take(4000).collect::<String>()}]}))
    }).collect::<Vec<_>>();
    turns.push(serde_json::json!({"role": "user", "content": content}));
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(45)).build()
        .map_err(|_| "Could not prepare the OpenAI connection.".to_string())?;
    let response = cancellable(&mut cancel_rx, client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": "gpt-4.1-mini",
            "max_output_tokens": 700,
            "input": turns
        }))
        .send()).await?.map_err(|_| "Could not reach OpenAI. Check your connection and try again.".to_string())?;
    let status = response.status();
    eprintln!("[Panda AI] provider=openai http_status={} headers_elapsed_ms={:.0}", status.as_u16(), started.elapsed().as_secs_f64() * 1000.0);
    let body: ResponseBody = cancellable(&mut cancel_rx, response.json()).await?.map_err(|_| "OpenAI returned an unreadable response.".to_string())?;
    if !status.is_success() {
        let message = body.error.and_then(|error| error.message).unwrap_or_else(|| format!("OpenAI returned HTTP {status}."));
        return Err(message);
    }
    let text = body.output.unwrap_or_default().into_iter()
        .flat_map(|item| item.content.unwrap_or_default())
        .filter(|part| part.kind.as_deref() == Some("output_text"))
        .filter_map(|part| part.text)
        .collect::<Vec<_>>().join("\n");
    if text.is_empty() { return Err("OpenAI returned an empty answer. Try again.".into()); }
    eprintln!("[Panda AI] provider=openai http_status={} status=success elapsed_ms={:.0} response_chars={}", status.as_u16(), started.elapsed().as_secs_f64() * 1000.0, text.chars().count());
    Ok(ApiResult { text })
}

#[tauri::command]
async fn start_capture(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) -> Result<u64, String> {
    use scrcap::{CaptureConfig, Target, VideoConfig};
    #[cfg(target_os = "windows")]
    let target = {
        let hwnd = window.hwnd().map_err(|_| "Could not attach the Windows screen picker to Panda Companion.".to_string())?;
        Target::Pick(hwnd.0 as isize)
    };
    #[cfg(target_os = "macos")]
    let target = Target::Pick;

    stop_capture_inner(&state).await;
    let epoch = {
        let mut session = state.capture.lock().map_err(|_| "Screen session state is unavailable.".to_string())?;
        session.epoch = session.epoch.wrapping_add(1);
        session.active = false;
        session.epoch
    };
    let capture_result = tokio::task::spawn_blocking(move || CaptureConfig {
        video: VideoConfig { channel_capacity: 1, hide: vec![], target, fps: Some(1) },
        audio: None,
    }.create()).await.map_err(|_| "Screen sharing did not start.".to_string())?
      ;
    let capture = match capture_result {
        Ok(capture) => capture,
        Err(error) => return Err(screen_capture_start_error(error)),
    };
    let mut session = state.capture.lock().map_err(|_| "Screen session state is unavailable.".to_string())?;
    if session.epoch != epoch {
        drop(session);
        capture.terminate();
        return Err("Screen sharing was cancelled before it started.".into());
    }
    session.capture = Some(capture);
    session.active = true;
    Ok(epoch)
}

fn screen_capture_start_error(error: scrcap::error::CaptureError) -> String {
    if matches!(&error, scrcap::error::CaptureError::Cancelled) {
        return "Screen selection cancelled. Sharing remains stopped.".into();
    }
    let detail = format!("{error:?}");
    eprintln!("[Panda Capture] backend=scrcap error={detail}");
    format!("Screen sharing did not start: {detail}")
}

#[tauri::command]
async fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_capture_inner(&state).await;
    Ok(())
}

fn invalidate_capture(state: &AppState) -> (Option<scrcap::CaptureDesc>, Option<tokio::sync::watch::Receiver<bool>>) {
    let mut session = state.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    session.active = false;
    session.epoch = session.epoch.wrapping_add(1);
    let capture = session.capture.take();
    let active = state.ollama.active.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let done = active.as_ref().map(|request| {
        request.cancel.send_replace(true);
        request.done.clone()
    });
    drop(session);
    (capture, done)
}

fn stop_capture_without_wait(state: &AppState) {
    let (capture, _) = invalidate_capture(state);
    use scrcap::CaptureDescriptor as _;
    if let Some(capture) = capture { capture.terminate(); }
}

async fn stop_capture_inner(state: &AppState) {
    let (capture, mut done) = invalidate_capture(state);
    use scrcap::CaptureDescriptor as _;
    if let Some(capture) = capture { capture.terminate(); }
    if let Some(receiver) = done.as_mut() {
        if !*receiver.borrow() { let _ = receiver.changed().await; }
    }
}

#[tauri::command]
fn set_compact(window: tauri::WebviewWindow, compact: bool) -> Result<(), String> {
    let (width, height) = if compact { (88.0, 88.0) } else { (360.0, 600.0) };
    window.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "Could not resize Panda Companion.".to_string())
}

#[tauri::command]
fn foreground_app() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    { return windows_frontmost_app(); }
    #[cfg(target_os = "macos")]
    { return macos_frontmost_app(); }
    #[allow(unreachable_code)]
    Err("Screen capture is supported on macOS and Windows.".into())
}

#[tauri::command]
fn capture_screen(excluded_apps: Vec<String>, max_resolution: u32, session_id: u64, state: tauri::State<'_, AppState>) -> Result<CapturedScreen, String> {
    let capture_started = Instant::now();
    let app_name = foreground_app()?;
    if excluded_apps.iter().any(|name| name.eq_ignore_ascii_case(&app_name)) {
        stop_capture_without_wait(&state);
        return Err("Sharing is paused because this app is excluded.".into());
    }
    let frame_started = Instant::now();
    let session = state.capture.lock().map_err(|_| "Screen session state is unavailable.".to_string())?;
    if !session_accepts_capture(&session, session_id) { return Err("The screen session has stopped. Start sharing again before capturing.".into()); }
    let capture = session.capture.as_ref().ok_or_else(|| "Start a live session before capturing the screen.".to_string())?;
    let mut frames = capture.video().try_iter();
    let mut latest = frames.next().ok_or_else(|| "Waiting for a screen frame. Try again in a moment.".to_string())?;
    let mut queued_frames_dropped = 0u32;
    for frame in frames { latest = frame; queued_frames_dropped = queued_frames_dropped.saturating_add(1); }
    let frame = latest;
    let capture_wait_ms = frame_started.elapsed().as_secs_f64() * 1000.0;
    let app_after_capture = foreground_app()?;
    if excluded_apps.iter().any(|name| name.eq_ignore_ascii_case(&app_after_capture)) {
        drop(session);
        stop_capture_without_wait(&state);
        return Err("Sharing is paused because this app is excluded.".into());
    }
    if app_after_capture != app_name {
        return Err("The active app changed during capture. Try again.".into());
    }
    let (data_url, source_width, source_height, image_width, image_height, image_bytes) = encode_frame(frame, max_resolution.clamp(800, 1920))?;
    if !session.active || session.epoch != session_id { return Err("The screen session stopped while the screenshot was being processed.".into()); }
    let encode_ms = capture_started.elapsed().as_secs_f64() * 1000.0 - capture_wait_ms;
    Ok(CapturedScreen { data_url, app_name, capture_wait_ms, encode_ms, queued_frames_dropped, source_width, source_height, image_width, image_height, image_bytes })
}

fn encode_frame(frame: scrcap::VideoFrame, max_resolution: u32) -> Result<(String, u32, u32, u32, u32, usize), String> {
    let (width, height) = frame.size;
    let mut rgb = frame.vframe.chunks_exact(4).flat_map(|pixel| [pixel[2], pixel[1], pixel[0]]).collect::<Vec<_>>();
    let image = image::RgbImage::from_raw(width, height, std::mem::take(&mut rgb))
        .ok_or_else(|| "Could not read the captured pixels.".to_string())?;
    let resized = image::DynamicImage::ImageRgb8(image).thumbnail(max_resolution, max_resolution).to_rgb8();
    let (image_width, image_height) = resized.dimensions();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 76).encode_image(&resized)
        .map_err(|_| "Could not encode the screen image.".to_string())?;
    let image_bytes = bytes.len();
    Ok((format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)), width, height, image_width, image_height, image_bytes))
}

#[cfg(target_os = "windows")]
fn windows_frontmost_app() -> Result<String, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION}, UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId}};
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() { return Err("Could not determine the active app.".into()); }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() { return Err("Could not read the active app name.".into()); }
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if ok == 0 { return Err("Could not read the active app name.".into()); }
        let path = OsString::from_wide(&buffer[..size as usize]).to_string_lossy().to_string();
        Ok(std::path::Path::new(&path).file_stem().unwrap_or_default().to_string_lossy().to_string())
    }
}

#[cfg(target_os = "macos")]
fn macos_frontmost_app() -> Result<String, String> {
    use cocoa::base::nil;
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let workspace: *mut objc::runtime::Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut objc::runtime::Object = msg_send![workspace, frontmostApplication];
        if app == nil { return Err("Could not determine the active app.".into()); }
        let name: *mut objc::runtime::Object = msg_send![app, localizedName];
        let string = NSString::from_ptr(name);
        Ok(string.to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(true) { let _ = window.hide(); }
                        else { let _ = window.show(); let _ = window.set_focus(); }
                    }
                }
            })
            .build())
        .setup(|app| {
            let status = GlobalShortcutStatus::from_registration(
                app.global_shortcut().register("CommandOrControl+Shift+P").map_err(|error| error.to_string()),
            );
            if status.registered {
                eprintln!("Panda Companion global shortcut registered: CommandOrControl+Shift+P");
            } else if let Some(error) = status.error.as_deref() {
                eprintln!("Panda Companion global shortcut registration failed (CommandOrControl+Shift+P): {error}");
            }
            if let Ok(mut current) = app.state::<AppState>().shortcut.lock() { *current = status; }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![has_api_key, global_shortcut_status, save_api_key, remove_api_key, validate_api_key, ask_openai, ollama_status, ollama_model_supports_vision, ollama_model_capabilities, ask_ollama, foreground_app, start_capture, stop_capture, set_compact, capture_screen, enumerate_dxgi_monitors, capture_dxgi_frame])
        .run(tauri::generate_context!())
        .expect("error while running Panda Companion");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn denied_shortcut_is_reported_as_unavailable_not_active() {
        let status = GlobalShortcutStatus::from_registration(Err("Access is denied. (os error 5)".into()));
        assert!(!status.registered);
        assert_eq!(status.error.as_deref(), Some("Access is denied. (os error 5)"));
    }

    #[test]
    fn successful_shortcut_registration_is_reported_as_active() {
        let status = GlobalShortcutStatus::from_registration(Ok(()));
        assert!(status.registered);
        assert!(status.error.is_none());
    }

    #[test]
    fn dismissed_screen_picker_is_reported_as_cancelled_not_a_capture_failure() {
        assert_eq!(screen_capture_start_error(scrcap::error::CaptureError::Cancelled), "Screen selection cancelled. Sharing remains stopped.");
    }

    fn set_session(state: &AppState, epoch: u64, active: bool) {
        let mut session = state.capture.lock().unwrap();
        session.epoch = epoch;
        session.active = active;
    }

    #[test]
    fn streaming_ndjson_collects_content_and_keeps_thinking_separate() {
        let mut accumulator = OllamaAccumulator::default();
        let first: OllamaChatResponse = serde_json::from_str(r#"{"message":{"role":"assistant","content":"Hello","thinking":"private thought"},"done":false}"#).unwrap();
        let final_event: OllamaChatResponse = serde_json::from_str(r#"{"message":{"role":"assistant","content":" there."},"done":true,"done_reason":"stop"}"#).unwrap();
        assert_eq!(accumulator.push(first).unwrap().as_deref(), Some("Hello"));
        assert_eq!(accumulator.push(final_event).unwrap().as_deref(), Some(" there."));
        let (answer, done) = accumulator.finish().unwrap();
        assert_eq!(answer, "Hello there.");
        assert_eq!(done.done_reason.as_deref(), Some("stop"));
        assert!(!answer.contains("private thought"));
    }

    #[test]
    fn non_streaming_json_returns_message_content() {
        let event: OllamaChatResponse = serde_json::from_str(r#"{"message":{"role":"assistant","content":"A real answer"},"done":true,"done_reason":"stop"}"#).unwrap();
        let mut accumulator = OllamaAccumulator::default();
        accumulator.push(event).unwrap();
        assert_eq!(accumulator.finish().unwrap().0, "A real answer");
    }

    #[test]
    fn genuinely_empty_content_has_a_useful_diagnostic() {
        let event: OllamaChatResponse = serde_json::from_str(r#"{"message":{"role":"assistant","content":"","thinking":"reasoning only"},"done":true,"done_reason":"stop"}"#).unwrap();
        let mut accumulator = OllamaAccumulator::default();
        accumulator.push(event).unwrap();
        assert!(matches!(accumulator.finish(), Err(message) if message.contains("internal reasoning but no user-facing answer")));
    }

    #[test]
    fn malformed_response_json_is_rejected() {
        assert!(matches!(parse_ollama_response(br#"{"message": broken}"#, "malformed"), Err(message) if message.contains("malformed")));
    }

    #[tokio::test]
    async fn stop_cancels_an_active_request_and_rejects_old_epoch() {
        let state = AppState::default();
        set_session(&state, 7, true);
        let (guard, mut receiver) = register_ollama_request(&state, Some(7)).unwrap();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct DropFlag(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for DropFlag { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let request_dropped = dropped.clone();
        let request = tokio::spawn(async move {
            let _guard = guard;
            cancellable(&mut receiver, async move { let _drop_flag = DropFlag(request_dropped); std::future::pending::<()>().await }).await
        });
        tokio::task::yield_now().await;
        stop_capture_inner(&state).await;
        assert!(request.is_finished(), "Stop must wait until the request task has exited");
        assert!(dropped.load(Ordering::SeqCst), "the in-flight future must be dropped on cancellation");
        let result = tokio::time::timeout(Duration::from_secs(1), request).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err(), request_cancelled_error());
        assert!(!session_accepts_capture(&state.capture.lock().unwrap(), 7));
        assert!(register_ollama_request(&state, Some(7)).is_err());
    }

    #[tokio::test]
    async fn a_new_session_epoch_can_start_after_stop() {
        let state = AppState::default();
        set_session(&state, 3, true);
        let (guard, _) = register_ollama_request(&state, Some(3)).unwrap();
        drop(guard);
        stop_capture_inner(&state).await;
        let epoch = {
            let mut session = state.capture.lock().unwrap();
            assert!(!session_accepts_capture(&session, 3));
            session.active = true;
            session.epoch
        };
        assert_ne!(epoch, 3);
        assert!(session_accepts_capture(&state.capture.lock().unwrap(), epoch));
        let (guard, _) = register_ollama_request(&state, Some(epoch)).unwrap();
        drop(guard);
    }

    #[test]
    fn inference_gate_never_queues_a_second_request() {
        let state = AppState::default();
        let (_first_guard, _) = register_ollama_request(&state, None).unwrap();
        assert!(matches!(register_ollama_request(&state, None), Err(message) if message.contains("no request was queued")));
    }
}
