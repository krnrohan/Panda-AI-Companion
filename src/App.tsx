import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createWorker, type Worker } from "tesseract.js";

type ChatMessage = { role: "user" | "panda"; text: string; proactive?: boolean };
type Capture = { data_url: string; app_name: string; capture_wait_ms: number; encode_ms: number; queued_frames_dropped: number; source_width: number; source_height: number; image_width: number; image_height: number; image_bytes: number };
type Session = "off" | "live" | "paused";
type Provider = "openai" | "ollama";
type OllamaModel = { name: string };
type DxgiMonitor = { index: number; name: string; width: number; height: number; primary: boolean };
type DxgiPreview = { dataUrl: string; width: number; height: number };
type PerformanceMode = "responsive" | "balanced" | "batterySaver";
type LiveStage = "capturing" | "analyzing" | "responding" | "paused" | "stopped";
type OllamaEvent = { kind: "delta" | "firstToken" | "metrics"; text?: string; elapsedMs?: number; timings?: OllamaTimings };
type OllamaTimings = { httpMs: number | null; modelLoadMs: number | null; promptEvalMs: number | null; inferenceMs: number | null };
type PerformanceMetrics = { captureWallMs: number | null; nativeCaptureWaitMs: number | null; encodeMs: number | null; ocrInitMs: number | null; ocrMs: number | null; changeDetectMs: number | null; firstTokenMs: number | null; httpMs: number | null; modelLoadMs: number | null; promptEvalMs: number | null; inferenceMs: number | null; responseWallMs: number | null; uiUpdateMs: number | null; requestsPerMinute: number; queuedFramesDropped: number; imageSize: string; sampleIntervalMs: number };

const HISTORY_KEY = "panda-chat-history";
const EXCLUSION_KEY = "panda-excluded-apps";
const PROVIDER_KEY = "panda-ai-provider";
const OLLAMA_MODEL_KEY = "panda-ollama-model";
const DEFAULT_OLLAMA_MODEL = "qwen3.5:2b";
const PERFORMANCE_KEY = "panda-performance-mode";
const PERFORMANCE_PRESETS: Record<PerformanceMode, { label: string; intervalMs: number; maxAdaptiveMs: number; maxResolution: number }> = {
  responsive: { label: "Responsive", intervalMs: 4_000, maxAdaptiveMs: 18_000, maxResolution: 1280 },
  balanced: { label: "Balanced", intervalMs: 8_000, maxAdaptiveMs: 30_000, maxResolution: 1600 },
  batterySaver: { label: "Battery Saver", intervalMs: 18_000, maxAdaptiveMs: 45_000, maxResolution: 1024 },
};
const EMPTY_METRICS: PerformanceMetrics = { captureWallMs: null, nativeCaptureWaitMs: null, encodeMs: null, ocrInitMs: null, ocrMs: null, changeDetectMs: null, firstTokenMs: null, httpMs: null, modelLoadMs: null, promptEvalMs: null, inferenceMs: null, responseWallMs: null, uiUpdateMs: null, requestsPerMinute: 0, queuedFramesDropped: 0, imageSize: "—", sampleIntervalMs: 0 };
const loadHistory = (): ChatMessage[] => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]").slice(-80); } catch { return []; }
};

function PandaMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? "panda-mark small" : "panda-mark"} viewBox="0 0 100 100" aria-label="Panda">
    <circle cx="23" cy="24" r="17" fill="#262626" /><circle cx="77" cy="24" r="17" fill="#262626" />
    <ellipse cx="50" cy="54" rx="39" ry="35" fill="#fff" />
    <ellipse cx="35" cy="48" rx="10" ry="14" transform="rotate(24 35 48)" fill="#262626" />
    <ellipse cx="65" cy="48" rx="10" ry="14" transform="rotate(-24 65 48)" fill="#262626" />
    <circle cx="37" cy="48" r="3.5" fill="#fff" /><circle cx="63" cy="48" r="3.5" fill="#fff" />
    <ellipse cx="50" cy="66" rx="7" ry="5" fill="#262626" /><path d="M42 73q8 8 16 0" fill="none" stroke="#262626" strokeWidth="3" strokeLinecap="round" />
    <ellipse cx="20" cy="59" rx="8" ry="10" transform="rotate(25 20 59)" fill="#f3a5a5" opacity=".75" />
    <ellipse cx="80" cy="59" rx="8" ry="10" transform="rotate(-25 80 59)" fill="#f3a5a5" opacity=".75" />
  </svg>;
}

export default function App() {
  const [session, setSession] = useState<Session>("off");
  const [hasKey, setHasKey] = useState(false);
  const [provider, setProvider] = useState<Provider>(() => localStorage.getItem(PROVIDER_KEY) === "openai" ? "openai" : "ollama");
  const providerRef = useRef<Provider>(provider);
  providerRef.current = provider;
  const [ollamaModel, setOllamaModel] = useState(() => localStorage.getItem(OLLAMA_MODEL_KEY) || DEFAULT_OLLAMA_MODEL);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaState, setOllamaState] = useState<"checking" | "online" | "offline">("checking");
  const [ollamaError, setOllamaError] = useState("");
  const [ollamaVision, setOllamaVision] = useState<boolean | null>(null);
  const [ollamaRefresh, setOllamaRefresh] = useState(0);
  const [keyDraft, setKeyDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dxgiMonitors, setDxgiMonitors] = useState<DxgiMonitor[]>([]);
  const [dxgiMonitorIndex, setDxgiMonitorIndex] = useState<number | null>(null);
  const [dxgiPreview, setDxgiPreview] = useState<DxgiPreview | null>(null);
  const [dxgiBusy, setDxgiBusy] = useState(false);
  const [dxgiError, setDxgiError] = useState("");
  const [dxgiAnswer, setDxgiAnswer] = useState("");
  const [dxgiAnswerMs, setDxgiAnswerMs] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(EXCLUSION_KEY) || "[]"); } catch { return []; }
  });
  const [excludedDraft, setExcludedDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Ready when you are");
  const [busy, setBusy] = useState(false);
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>(() => {
    const stored = localStorage.getItem(PERFORMANCE_KEY);
    return stored === "responsive" || stored === "batterySaver" ? stored : "balanced";
  });
  const [liveStage, setLiveStage] = useState<LiveStage>("stopped");
  const [sessionTransition, setSessionTransition] = useState(false);
  const [shortcutStatus, setShortcutStatus] = useState<{ registered: boolean; error: string | null } | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics>(EMPTY_METRICS);
  const [unread, setUnread] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [lastApp, setLastApp] = useState("");
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionEpochRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const ocrInitializationRef = useRef<Promise<Worker> | null>(null);
  const terminatedWorkersRef = useRef(new WeakSet<Worker>());
  const sampleTasksRef = useRef(new Set<Promise<void>>());
  const lastOcrRef = useRef("");
  const lastImageRef = useRef<number[] | null>(null);
  const lastProactiveAt = useRef(0);
  const busyRef = useRef(false);
  const sampleBusyRef = useRef(false);
  const userRequestPendingRef = useRef(false);
  const adaptiveDelayRef = useRef(PERFORMANCE_PRESETS.balanced.intervalMs);
  const requestTimesRef = useRef<number[]>([]);
  const pendingChangeRef = useRef<{ since: number } | null>(null);
  const lastSuggestionRef = useRef("");
  const lastAppRef = useRef("");
  const localModelInstalled = ollamaModels.some((item) => item.name === ollamaModel);
  const localProviderReady = ollamaState === "online" && localModelInstalled && ollamaVision === true;

  const selectProvider = (next: Provider) => {
    providerRef.current = next;
    localStorage.setItem(PROVIDER_KEY, next);
    setProvider(next);
  };

  async function refreshDxgiMonitors() {
    setDxgiBusy(true); setDxgiError(""); setDxgiPreview(null); setDxgiAnswer("");
    try {
      const items = await invoke<DxgiMonitor[]>("enumerate_dxgi_monitors");
      setDxgiMonitors(items);
      setDxgiMonitorIndex((current) => items.some((item) => item.index === current) ? current : items.find((item) => item.primary)?.index ?? items[0]?.index ?? null);
    } catch (error) { setDxgiMonitors([]); setDxgiMonitorIndex(null); setDxgiError(errorText(error)); }
    finally { setDxgiBusy(false); }
  }

  async function captureDxgiTestFrame() {
    if (dxgiMonitorIndex === null) return;
    setDxgiBusy(true); setDxgiError(""); setDxgiPreview(null); setDxgiAnswer("");
    try {
      const frame = await invoke<DxgiPreview>("capture_dxgi_frame", { monitorIndex: dxgiMonitorIndex });
      setDxgiPreview(frame);
    } catch (error) { setDxgiError(errorText(error)); }
    finally { setDxgiBusy(false); }
  }

  async function analyzeDxgiFrame() {
    if (!dxgiPreview || provider !== "ollama") { setDxgiError("Select Local Ollama and capture a frame first."); return; }
    setDxgiBusy(true); setDxgiError(""); setDxgiAnswer("");
    const started = performance.now();
    try {
      const result = await askProvider("ollama", ollamaModel, {
        question: "Describe the visible screen and identify any important text or issue.", imageDataUrl: dxgiPreview.dataUrl,
        screenText: null, history: [], routine: false, detailed: false, sessionEpoch: null,
      }, { isCurrent: () => true, onDelta: setDxgiAnswer, onFirstToken: () => {}, onTimings: () => {} });
      setDxgiAnswer(result.text);
      setDxgiAnswerMs(performance.now() - started);
    } catch (error) { setDxgiError(errorText(error)); }
    finally { setDxgiBusy(false); }
  }

  const append = useCallback((message: ChatMessage) => {
    setMessages((current) => {
      const next = [...current, message].slice(-80);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
    if (!chatOpen && message.role === "panda") setUnread(true);
  }, [chatOpen]);

  const terminateWorkerOnce = useCallback(async (worker: Worker) => {
    if (terminatedWorkersRef.current.has(worker)) return;
    terminatedWorkersRef.current.add(worker);
    await worker.terminate().catch(() => {});
  }, []);

  const ensureOcrWorker = useCallback(async (isCurrent: () => boolean): Promise<Worker | null> => {
    if (workerRef.current) return workerRef.current;
    let initializing = ocrInitializationRef.current;
    if (!initializing) {
      initializing = createOcrWorker();
      ocrInitializationRef.current = initializing;
    }
    let worker: Worker;
    try { worker = await initializing; }
    catch (error) {
      if (ocrInitializationRef.current === initializing) ocrInitializationRef.current = null;
      throw error;
    }
    if (ocrInitializationRef.current === initializing) ocrInitializationRef.current = null;
    if (!isCurrent()) { await terminateWorkerOnce(worker); return null; }
    workerRef.current = worker;
    return worker;
  }, [terminateWorkerOnce]);

  const stopOcrWork = useCallback(async () => {
    const initializing = ocrInitializationRef.current;
    ocrInitializationRef.current = null;
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) await terminateWorkerOnce(worker);
    if (initializing) {
      try { const created = await initializing; if (created !== worker) await terminateWorkerOnce(created); }
      catch { /* worker setup was interrupted */ }
    }
  }, [terminateWorkerOnce]);

  async function waitForSampleTasks() {
    await Promise.allSettled(Array.from(sampleTasksRef.current));
  }

  useEffect(() => {
    invoke<boolean>("has_api_key").then(setHasKey).catch(() => setStatus("Run this app inside its desktop window to connect secure storage."));
  }, []);

  useEffect(() => {
    invoke<{ registered: boolean; error: string | null }>("global_shortcut_status")
      .then(setShortcutStatus)
      .catch((error) => setShortcutStatus({ registered: false, error: errorText(error) }));
  }, []);

  useEffect(() => {
    localStorage.setItem(PROVIDER_KEY, provider);
    if (provider !== "ollama") return;
    let cancelled = false;
    setOllamaState("checking"); setOllamaError(""); setOllamaModels([]); setOllamaVision(null);
    invoke<OllamaModel[]>("ollama_status").then((models) => {
      if (cancelled) return;
      setOllamaModels(models); setOllamaState("online");
      if (!models.some((item) => item.name === ollamaModel)) setOllamaError(`Model ${ollamaModel} is not installed. Run: ollama pull ${ollamaModel}`);
    }).catch((error) => {
      if (cancelled) return;
      setOllamaState("offline"); setOllamaError(errorText(error));
    });
    return () => { cancelled = true; };
  }, [provider, ollamaRefresh]);

  useEffect(() => {
    localStorage.setItem(OLLAMA_MODEL_KEY, ollamaModel);
    if (provider !== "ollama" || ollamaState !== "online" || !localModelInstalled) return;
    let cancelled = false;
    setOllamaVision(null); setOllamaError("");
    invoke<{ vision: boolean }>("ollama_model_capabilities", { model: ollamaModel }).then((capabilities) => {
      if (cancelled) return;
      setOllamaVision(capabilities.vision);
      if (!capabilities.vision) setOllamaError(`${ollamaModel} is installed, but it does not support images. Select a vision-capable model for screen sharing.`);
    }).catch((error) => { if (!cancelled) { setOllamaVision(false); setOllamaError(errorText(error)); } });
    return () => { cancelled = true; };
  }, [provider, ollamaState, ollamaModels, ollamaModel, ollamaRefresh, localModelInstalled]);

  useEffect(() => { localStorage.setItem(PERFORMANCE_KEY, performanceMode); adaptiveDelayRef.current = PERFORMANCE_PRESETS[performanceMode].intervalMs; }, [performanceMode]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" }); }, [messages, busy]);
  useEffect(() => { localStorage.setItem(EXCLUSION_KEY, JSON.stringify(excluded)); }, [excluded]);
  useEffect(() => {
    if (session !== "live") {
      setLiveStage(session === "paused" ? "paused" : "stopped");
      return;
    }
    let cancelled = false;
    let timer = 0;
    let launchSample = () => {};
    const sessionEpoch = sessionEpochRef.current;
    if (sessionEpoch === null) { setSession("off"); setStatus("Screen session expired. Start sharing again."); return; }
    const isCurrentLive = () => !cancelled && sessionRef.current === "live" && sessionEpochRef.current === sessionEpoch;
    const preset = PERFORMANCE_PRESETS[performanceMode];
    const schedule = () => {
      if (!cancelled) timer = window.setTimeout(() => launchSample(), adaptiveDelayRef.current);
    };
    const sampleOnce = async () => {
      if (!isCurrentLive()) return;
      if (sampleBusyRef.current || busyRef.current || userRequestPendingRef.current) { schedule(); return; }
      sampleBusyRef.current = true;
      let requestWallMs = 0;
      try {
        setLiveStage("capturing");
        setStatus("Capturing a sampled screenshot…");
        const captureStarted = performance.now();
        const capture = await invoke<Capture>("capture_screen", { excludedApps: excluded, maxResolution: preset.maxResolution, sessionId: sessionEpoch });
        const captureWallMs = performance.now() - captureStarted;
        if (!isCurrentLive()) return;
        const previousApp = lastAppRef.current;
        lastAppRef.current = capture.app_name;
        setLastApp(capture.app_name);
        let worker = workerRef.current;
        if (!worker) {
          setLiveStage("analyzing");
          setStatus("Preparing local OCR…");
          const initStarted = performance.now();
          worker = await ensureOcrWorker(isCurrentLive);
          if (!worker) return;
          setMetrics((current) => ({ ...current, ocrInitMs: performance.now() - initStarted }));
        }
        const activeWorker = worker;
        setLiveStage("analyzing");
        setStatus("Analyzing the sampled screen locally…");
        const ocrStarted = performance.now();
        const result = await activeWorker!.recognize(capture.data_url);
        if (!isCurrentLive()) return;
        const recognized = (result.data.text || "").replace(/\s+/g, " ").trim().slice(0, 12_000);
        const ocrMs = performance.now() - ocrStarted;
        const changeStarted = performance.now();
        const appChanged = capture.app_name !== previousApp;
        const textChanged = recognized.length > 35 && recognized !== lastOcrRef.current;
        const visualSignature = await getVisualSignature(capture.data_url);
        if (!isCurrentLive()) return;
        const imageChanged = lastImageRef.current !== null && imageDelta(lastImageRef.current, visualSignature);
        const meaningful = appChanged || textChanged || imageChanged;
        const changeDetectMs = performance.now() - changeStarted;
        lastOcrRef.current = recognized;
        lastImageRef.current = visualSignature;
        if (meaningful) pendingChangeRef.current = { since: performance.now() };
        const eventMature = pendingChangeRef.current !== null && performance.now() - pendingChangeRef.current.since >= 700;
        setMetrics((current) => ({ ...current, captureWallMs, nativeCaptureWaitMs: capture.capture_wait_ms, encodeMs: capture.encode_ms, ocrMs, changeDetectMs, queuedFramesDropped: current.queuedFramesDropped + capture.queued_frames_dropped, imageSize: `${capture.image_width}×${capture.image_height} (${Math.round(capture.image_bytes / 1024)} KB)` }));
        const canAnalyze = provider === "ollama" ? localProviderReady : hasKey;
        if (eventMature && Date.now() - lastProactiveAt.current > 60_000 && canAnalyze && !busyRef.current && !userRequestPendingRef.current) {
          pendingChangeRef.current = null;
          lastProactiveAt.current = Date.now();
          busyRef.current = true;
          setBusy(true);
          setLiveStage("analyzing");
          setStatus("Analyzing a meaningful screen change…");
          const requestStarted = performance.now();
          requestTimesRef.current.push(Date.now());
          requestTimesRef.current = requestTimesRef.current.filter((time) => Date.now() - time < 60_000);
          setMetrics((current) => ({ ...current, requestsPerMinute: requestTimesRef.current.length }));
          setMessages((current) => [...current, { role: "panda" as const, text: "", proactive: true }].slice(-80));
          try {
            const answer = await askProvider(providerRef.current, ollamaModel, {
              question: "Look at this screen and its visible text. If there is a clear, timely way to help the user, offer one short, specific suggestion. If nothing needs attention, reply exactly NO_SUGGESTION.",
              imageDataUrl: capture.data_url,
              screenText: recognized,
              history: [],
              routine: true,
              detailed: false,
              sessionEpoch,
            }, {
              isCurrent: isCurrentLive,
              onDelta: (fullText) => { if (!isCurrentLive()) return; const uiStarted = performance.now(); setMessages((current) => {
                const next = [...current]; const last = next.length - 1;
                if (last >= 0 && next[last].role === "panda") next[last] = { ...next[last], text: fullText, proactive: true };
                return next;
              }); requestAnimationFrame(() => { if (isCurrentLive()) setMetrics((current) => ({ ...current, uiUpdateMs: performance.now() - uiStarted })); }); },
              onFirstToken: (ms) => { if (isCurrentLive()) { setLiveStage("responding"); setStatus("Responding…"); setMetrics((current) => ({ ...current, firstTokenMs: ms })); } },
              onTimings: (value) => { if (isCurrentLive()) setMetrics((current) => ({ ...current, httpMs: value.httpMs, modelLoadMs: value.modelLoadMs, promptEvalMs: value.promptEvalMs, inferenceMs: value.inferenceMs })); },
            });
            requestWallMs = performance.now() - requestStarted;
            if (!isCurrentLive()) return;
            const normalized = normalizeSuggestion(answer.text);
            if (!cancelled && normalized && normalized !== "no_suggestion" && normalized !== lastSuggestionRef.current) {
              lastSuggestionRef.current = normalized;
              setMessages((current) => {
                const next = [...current]; const last = next.length - 1;
                if (last >= 0 && next[last].role === "panda") next[last] = { ...next[last], text: answer.text, proactive: true };
                localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(-80)));
                return next.slice(-80);
              });
            } else {
              setMessages((current) => current.length && current[current.length - 1].role === "panda" && current[current.length - 1].proactive
                ? current.slice(0, -1) : current);
            }
          } catch (error) {
            if (isCurrentLive()) {
              setMessages((current) => current.length && current[current.length - 1].role === "panda" && current[current.length - 1].proactive ? current.slice(0, -1) : current);
              setStatus(`Suggestion skipped: ${errorText(error)}`);
            }
          }
          finally {
            requestWallMs = requestWallMs || performance.now() - requestStarted;
            busyRef.current = false;
            setBusy(false);
            if (isCurrentLive()) {
              setMetrics((current) => ({ ...current, responseWallMs: requestWallMs }));
              setLiveStage("capturing");
            }
          }
        }
        if (!busyRef.current && isCurrentLive()) { setLiveStage("capturing"); setStatus(`Live · sampled screenshots · ${capture.app_name}`); }
      } catch (error) {
        if (isCurrentLive()) {
          const message = errorText(error);
          if (message.toLowerCase().includes("excluded")) { sessionRef.current = "paused"; sessionEpochRef.current = null; setSession("paused"); setLiveStage("paused"); void stopOcrWork(); }
          else setLiveStage("capturing");
          setStatus(message);
        }
      } finally {
        sampleBusyRef.current = false;
        if (isCurrentLive()) {
          const adaptive = requestWallMs > 0
            ? Math.min(preset.maxAdaptiveMs, Math.max(preset.intervalMs, requestWallMs * 1.2))
            : Math.min(preset.maxAdaptiveMs, Math.max(preset.intervalMs, adaptiveDelayRef.current));
          adaptiveDelayRef.current = adaptive;
          setMetrics((current) => ({ ...current, sampleIntervalMs: adaptive }));
          schedule();
        }
      }
    };
    launchSample = () => {
      const task = sampleOnce();
      sampleTasksRef.current.add(task);
      void task.finally(() => sampleTasksRef.current.delete(task));
    };
    adaptiveDelayRef.current = Math.max(preset.intervalMs, Math.min(preset.maxAdaptiveMs, adaptiveDelayRef.current));
    launchSample();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [session, excluded, hasKey, provider, ollamaModel, localProviderReady, performanceMode, ensureOcrWorker, stopOcrWork]);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  async function saveKey() {
    const value = keyDraft.trim();
    if (!value) return;
    setBusy(true); setStatus("Checking your key…");
    try {
      await invoke("validate_api_key", { apiKey: value });
      await invoke("save_api_key", { apiKey: value });
      setHasKey(true); setKeyDraft(""); setStatus("API key saved securely");
    } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    try {
      if (sessionRef.current !== "off") await stopLive(); else await invoke("stop_capture");
      await invoke("remove_api_key"); setHasKey(false); sessionRef.current = "off"; sessionEpochRef.current = null; setSession("off"); setStatus("API key removed; sharing stopped");
    }
    catch (error) { setStatus(errorText(error)); }
  }

  async function submitQuestion() {
    const question = draft.trim();
    if (!question || busy || busyRef.current) return;
    const detailed = /\b(detailed|step by step|deep dive|analy[sz]e in depth|explain fully)\b/i.test(question);
    const startedLive = sessionRef.current === "live";
    const sessionEpoch = startedLive ? sessionEpochRef.current : null;
    const isCurrentRequest = () => !startedLive || (sessionRef.current === "live" && sessionEpochRef.current === sessionEpoch);
    setDraft(""); append({ role: "user", text: question }); setBusy(true); busyRef.current = true; userRequestPendingRef.current = true;
    try {
      while (sampleBusyRef.current) await new Promise((resolve) => window.setTimeout(resolve, 25));
      if (!isCurrentRequest()) return;
      let capture: Capture | null = null;
      let text = "";
      if (sessionRef.current === "live") {
        setLiveStage("capturing"); setStatus("Capturing a fresh screenshot for your question…");
        const captureStarted = performance.now();
        capture = await invoke<Capture>("capture_screen", { excludedApps: excluded, maxResolution: PERFORMANCE_PRESETS[performanceMode].maxResolution, sessionId: sessionEpoch });
        if (!isCurrentRequest()) return;
        const captureWallMs = performance.now() - captureStarted;
        if (!workerRef.current) {
          const initStarted = performance.now();
          const worker = await ensureOcrWorker(isCurrentRequest);
          if (!worker) return;
          setMetrics((current) => ({ ...current, ocrInitMs: performance.now() - initStarted }));
        }
        setLiveStage("analyzing");
        const ocrStarted = performance.now();
        const activeWorker = workerRef.current;
        if (!activeWorker) return;
        text = (await activeWorker.recognize(capture.data_url)).data.text.replace(/\s+/g, " ").slice(0, 12_000);
        if (!isCurrentRequest()) return;
        setMetrics((current) => ({ ...current, captureWallMs, nativeCaptureWaitMs: capture!.capture_wait_ms, encodeMs: capture!.encode_ms, ocrMs: performance.now() - ocrStarted, queuedFramesDropped: current.queuedFramesDropped + capture!.queued_frames_dropped, imageSize: `${capture!.image_width}×${capture!.image_height} (${Math.round(capture!.image_bytes / 1024)} KB)` }));
      }
      if (!isCurrentRequest()) return;
      setLiveStage("responding"); setStatus("Responding…");
      setMessages((current) => [...current, { role: "panda" as const, text: "" }].slice(-80));
      requestTimesRef.current.push(Date.now());
      requestTimesRef.current = requestTimesRef.current.filter((time) => Date.now() - time < 60_000);
      setMetrics((current) => ({ ...current, requestsPerMinute: requestTimesRef.current.length }));
      const responseStarted = performance.now();
      const response = await askProvider(providerRef.current, ollamaModel, {
        question,
        imageDataUrl: capture?.data_url ?? null,
        screenText: text || null,
        history: messages.slice(-12),
        routine: false,
        detailed,
        sessionEpoch,
      }, {
        isCurrent: isCurrentRequest,
        onDelta: (fullText) => {
          if (!isCurrentRequest()) return;
          const uiStarted = performance.now();
          setMessages((current) => {
            const next = [...current];
            const last = next.length - 1;
            if (last >= 0 && next[last].role === "panda") next[last] = { ...next[last], text: fullText };
            return next;
          });
          requestAnimationFrame(() => { if (isCurrentRequest()) setMetrics((current) => ({ ...current, uiUpdateMs: performance.now() - uiStarted })); });
        },
        onFirstToken: (ms) => { if (isCurrentRequest()) setMetrics((current) => ({ ...current, firstTokenMs: ms })); },
        onTimings: (value) => { if (isCurrentRequest()) setMetrics((current) => ({ ...current, httpMs: value.httpMs, modelLoadMs: value.modelLoadMs, promptEvalMs: value.promptEvalMs, inferenceMs: value.inferenceMs })); },
      });
      if (!isCurrentRequest()) return;
      setMessages((current) => {
        const next = [...current];
        const last = next.length - 1;
        if (last >= 0 && next[last].role === "panda") next[last] = { ...next[last], text: response.text };
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(-80)));
        return next;
      });
      setMetrics((current) => ({ ...current, responseWallMs: performance.now() - responseStarted }));
      setStatus(sessionRef.current === "live" ? `Live · ${capture?.app_name ?? lastAppRef.current}` : sessionRef.current === "paused" ? "Sharing paused" : "Ready when you are");
    } catch (error) {
  const message = `I couldn’t finish that: ${errorText(error)}`;
      if (!isCurrentRequest()) return;
      setMessages((current) => {
        const next = [...current];
        const last = next.length - 1;
        if (last >= 0 && next[last].role === "panda" && !next[last].text) next[last] = { ...next[last], text: message };
        else next.push({ role: "panda", text: message });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(-80)));
        return next.slice(-80);
      });
      setStatus(sessionRef.current === "live" ? `Live · sampled screenshots · ${lastAppRef.current}` : sessionRef.current === "paused" ? "Sharing paused" : "Ready when you are");
    }
    finally {
      setBusy(false); busyRef.current = false; userRequestPendingRef.current = false;
      if (sessionRef.current === "off") setLiveStage("stopped");
      else if (sessionRef.current === "paused") setLiveStage("paused");
      else setLiveStage("capturing");
    }
  }

  async function toggleLive() {
    if (session === "live") {
      setSessionTransition(true);
      sessionRef.current = "paused"; sessionEpochRef.current = null;
      setSession("paused"); setLiveStage("paused"); setBusy(false); setStatus("Sharing paused");
      setMessages((current) => current.filter((message) => !(message.role === "panda" && !message.text)));
      try {
        const nativeStop = invoke("stop_capture").catch((error) => setStatus(`Paused · ${errorText(error)}`));
        await Promise.all([nativeStop, stopOcrWork(), waitForSampleTasks()]);
      } finally { setSessionTransition(false); }
      return;
    }
    if (session === "paused") {
      if (sessionTransition) return;
      setSessionTransition(true);
      setStatus("Choose a screen or window to resume sharing…");
      try {
        const epoch = await invoke<number>("start_capture");
        sessionEpochRef.current = epoch; sessionRef.current = "live"; setSession("live"); setStatus("Resuming screen sharing…");
      }
      catch (error) { setStatus(errorText(error)); }
      finally { setSessionTransition(false); }
      return;
    }
    if (provider === "openai" && !hasKey) { setShowSettings(true); setStatus("Add your OpenAI API key to start a session"); return; }
    if (provider === "ollama" && !localProviderReady) { setShowSettings(true); setStatus(ollamaError || "Connect Ollama and choose an installed vision model in Settings"); return; }
    if (sessionTransition) return;
    setSessionTransition(true);
    setStatus("Choose a screen or window in the system picker…");
    try {
      const epoch = await invoke<number>("start_capture");
      sessionEpochRef.current = epoch; sessionRef.current = "live"; setSession("live"); setStatus("Screen sharing started");
    }
    catch (error) { setStatus(errorText(error)); }
    finally { setSessionTransition(false); }
  }

  async function stopLive() {
    if (sessionTransition) return;
    setSessionTransition(true);
    sessionRef.current = "off"; sessionEpochRef.current = null;
    setSession("off"); setLiveStage("stopped"); setBusy(false); setStatus("Screen sharing stopped");
    pendingChangeRef.current = null; lastImageRef.current = null; lastOcrRef.current = ""; lastAppRef.current = "";
    setMessages((current) => current.filter((message) => !(message.role === "panda" && !message.text)));
    try {
      const nativeStop = invoke("stop_capture").catch((error) => setStatus(`Stopped · ${errorText(error)}`));
      await Promise.all([nativeStop, stopOcrWork(), waitForSampleTasks()]);
    }
    finally { setSessionTransition(false); }
  }

  function addExclusion() {
    const names = excludedDraft.split(",").map((name) => name.trim()).filter(Boolean);
    setExcluded((current) => [...new Set([...current, ...names])]); setExcludedDraft("");
  }

  async function collapsePanda() {
    try { await invoke("set_compact", { compact: true }); setChatOpen(false); }
    catch (error) { setStatus(errorText(error)); }
  }

  async function expandPanda() {
    try { await invoke("set_compact", { compact: false }); setChatOpen(true); setUnread(false); }
    catch (error) { setStatus(errorText(error)); }
  }

  return <main className={`app-shell ${chatOpen ? "" : "compact"}`}>
    {chatOpen ? <>
    <header className="topbar" data-tauri-drag-region>
      <div className="brand"><PandaMark small /><span>panda</span><span className="brand-dot">●</span></div>
      <div className={`live-pill ${session} ${liveStage}`}><i />{session === "live" ? liveStage.toUpperCase() : session === "paused" ? "PAUSED" : busy ? "RESPONDING" : "STOPPED"}</div>
      <button className="icon-button settings-toggle" title="Settings" onClick={() => setShowSettings((value) => !value)}>⚙</button>
      <button className="icon-button close-button" title="Collapse to panda" onClick={() => void collapsePanda()}>−</button>
    </header>
    {shortcutStatus && !shortcutStatus.registered && <div className="shortcut-warning" role="status"><b>Global shortcut unavailable</b><span>{shortcutStatus.error || "Registration was denied."} Use the − button to collapse to panda, then click panda to reopen.</span></div>}

    {showSettings ? <section className="settings-panel">
      <div className="settings-heading"><div><span className="eyebrow">YOUR COMPANION</span><h2>Settings</h2></div><button className="icon-button" onClick={() => setShowSettings(false)}>×</button></div>
      <label className="field-label">AI provider</label>
      <select className="provider-select" value={provider} disabled={session !== "off" || busy || sessionTransition} onChange={(event) => selectProvider(event.target.value as Provider)}>
        <option value="openai">OpenAI API</option><option value="ollama">Local Ollama</option>
      </select>
      {session !== "off" && <p className="hint">Stop the live session before changing providers.</p>}
      {provider === "openai" ? <>
      <label className="field-label">OpenAI API key</label>
      {hasKey ? <div className="key-saved"><span><i className="secure-dot" /> Saved in secure system storage</span><button className="text-button danger" onClick={removeKey}>Remove</button></div> : <>
        <div className="key-entry"><input type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveKey()} placeholder="sk-…" autoComplete="off" spellCheck={false} /></div>
        <button className="primary-button full" disabled={busy || !keyDraft.trim()} onClick={() => void saveKey()}>{busy ? "Checking…" : "Save & verify key"}</button>
        <p className="hint">Your key stays in your computer’s secure credential store.</p>
      </>}
      </> : <div className="ollama-settings">
        <div className="ollama-status"><i className={ollamaState === "online" ? "secure-dot" : "status-dot"} />{ollamaState === "checking" ? "Checking local Ollama…" : ollamaState === "online" ? "Ollama is running at 127.0.0.1:11434" : "Ollama is not available"}<button className="text-button" onClick={() => setOllamaRefresh((value) => value + 1)}>Refresh</button></div>
        {ollamaState === "offline" && <p className="hint">Install Ollama for Windows from ollama.com/download/windows, launch it, then refresh here. Local mode does not need an OpenAI key.</p>}
        <label className="field-label">Installed model</label>
        <select className="provider-select" value={ollamaModel} onChange={(event) => setOllamaModel(event.target.value)}>
          {!localModelInstalled && <option value={ollamaModel}>{ollamaModel} · not installed</option>}
          {ollamaModels.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
        </select>
        {ollamaError && <p className="ollama-error">{ollamaError}</p>}
        {localModelInstalled && ollamaVision === true && <p className="hint">Vision ready · screen context stays on this computer and is sent only to Ollama.</p>}
        <p className="hint">For screen understanding, install a vision model such as <code>ollama pull qwen3.5:2b</code>. Chat works only with models installed in Ollama.</p>
      </div>}
      {navigator.userAgent.toLowerCase().includes("windows") && <div className="dxgi-test">
        <div className="divider" />
        <label className="field-label">Windows Screen Capture Test</label>
        <p className="hint">One-shot monitor capture for testing. No image is captured until you click Capture Test Frame.</p>
        <button className="text-button" disabled={dxgiBusy} onClick={() => void refreshDxgiMonitors()}>{dxgiBusy ? "Working…" : "Refresh Monitors"}</button>
        <select className="provider-select" aria-label="Monitor to capture" value={dxgiMonitorIndex ?? ""} onChange={(event) => setDxgiMonitorIndex(event.target.value ? Number(event.target.value) : null)}>
          <option value="">Select a monitor</option>
          {dxgiMonitors.map((monitor) => <option key={monitor.index} value={monitor.index}>{monitor.name} · {monitor.width}×{monitor.height}{monitor.primary ? " · Primary" : ""}</option>)}
        </select>
        <button className="primary-button full" disabled={dxgiBusy || dxgiMonitorIndex === null} onClick={() => void captureDxgiTestFrame()}>{dxgiBusy ? "Capturing…" : "Capture Test Frame"}</button>
        {dxgiError && <p className="ollama-error" role="alert">{dxgiError}</p>}
        {dxgiPreview && <div className="dxgi-preview"><img src={dxgiPreview.dataUrl} alt="Captured monitor preview" /><small>Captured image · {dxgiPreview.width}×{dxgiPreview.height}</small></div>}
        <button className="primary-button full" disabled={dxgiBusy || !dxgiPreview || provider !== "ollama" || !localModelInstalled} onClick={() => void analyzeDxgiFrame()}>{dxgiBusy ? "Analyzing…" : "Analyze Captured Frame"}</button>
        {provider !== "ollama" && <p className="hint">Select Local Ollama to analyze this frame privately.</p>}
        {dxgiAnswer && <div className="dxgi-answer"><b>Local Ollama · {ollamaModel}</b><p>{dxgiAnswer}</p>{dxgiAnswerMs !== null && <small>Completed in {formatMs(dxgiAnswerMs)}</small>}</div>}
      </div>}
      <div className="divider" />
      <label className="field-label">Live-session performance</label>
      <select className="provider-select" value={performanceMode} onChange={(event) => setPerformanceMode(event.target.value as PerformanceMode)}>
        <option value="responsive">Responsive · 4s sampling</option>
        <option value="balanced">Balanced · 8s sampling</option>
        <option value="batterySaver">Battery Saver · 18s sampling</option>
      </select>
      <p className="hint">Samples screenshots; this is not continuous video analysis. Slow model responses automatically lengthen the next sampling interval.</p>
      <div className="performance-metrics">
        <b>Recent pipeline timings</b>
        <span>Capture bridge <strong>{formatMs(metrics.captureWallMs)}</strong> · native frame wait {formatMs(metrics.nativeCaptureWaitMs)} · resize/encode {formatMs(metrics.encodeMs)}</span>
        <span>OCR init {formatMs(metrics.ocrInitMs)} · OCR {formatMs(metrics.ocrMs)} · local change check {formatMs(metrics.changeDetectMs)}</span>
        <span>Ollama first token {formatMs(metrics.firstTokenMs)} · HTTP headers {formatMs(metrics.httpMs)} · model load {formatMs(metrics.modelLoadMs)}</span>
        <span>Prompt eval {formatMs(metrics.promptEvalMs)} · generation {formatMs(metrics.inferenceMs)} · response {formatMs(metrics.responseWallMs)} · UI update {formatMs(metrics.uiUpdateMs)}</span>
        <span>Local requests/min {metrics.requestsPerMinute}</span>
        <span>Sample size {metrics.imageSize} · queued stale frames discarded {metrics.queuedFramesDropped} · next interval {formatMs(metrics.sampleIntervalMs)}</span>
      </div>
      <div className="divider" />
      <label className="field-label">Exclude apps from screen sharing</label>
      <p className="hint">Enter app names as they appear in the active app name. Use commas for multiple apps.</p>
      <div className="key-entry exclusion-entry"><input value={excludedDraft} onChange={(e) => setExcludedDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addExclusion()} placeholder="e.g. 1Password, Messages" /><button onClick={addExclusion}>Add</button></div>
      <div className="chips">{excluded.map((name) => <span className="chip" key={name}>{name}<button title={`Remove ${name}`} onClick={() => setExcluded((list) => list.filter((item) => item !== name))}>×</button></span>)}</div>
      <div className="privacy-note"><span>◉</span><p>{provider === "ollama" ? "Local mode sends prompts, approved live-session captures, and OCR only to Ollama at 127.0.0.1:11434. It never falls back to OpenAI." : "Screen images and recognized text are kept in memory only and sent to OpenAI only when you ask or a meaningful change needs a suggestion."}</p></div>
      {shortcutStatus?.registered && <div className="shortcut-note"><kbd>⌘ / Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>P</kbd><span>Toggle panda</span></div>}
    </section> : <>
      <section className="panda-stage">
        <div className="sparkle sparkle-one">✦</div><div className="sparkle sparkle-two">✦</div>
        <div className="panda-orb"><PandaMark /></div>
        <div className="stage-caption">{session === "live" ? "I’m here with you" : "Your little helper"}</div>
        <div className="status-line"><span className={session === "live" ? "status-pulse" : "status-dot"} />{status}</div>
        {session === "live" && <div className="shared-app">Sharing <b>{lastApp || "your screen"}</b></div>}
      </section>
      <div className="session-actions">
        <button className={`session-button ${session === "live" ? "active" : ""}`} disabled={sessionTransition || ((provider === "openai" && !hasKey || provider === "ollama" && !localProviderReady) && session === "off")} onClick={() => void toggleLive()}>
          <span className="screen-icon">{session === "live" ? "Ⅱ" : session === "paused" ? "▶" : "▣"}</span>
          {session === "live" ? "Pause sharing" : session === "paused" ? "Resume sharing" : "Start live session"}
        </button>
        {session !== "off" && <button className="stop-button" disabled={sessionTransition} onClick={() => void stopLive()}>Stop</button>}
      </div>

      <section className="chat-section">
        <div className="chat-heading"><div><span className="eyebrow">YOUR SPACE</span><h1>Ask panda</h1></div><button className="clear-button" title="Clear chat history" onClick={() => { setMessages([]); localStorage.removeItem(HISTORY_KEY); }}>Clear</button></div>
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? <div className="empty-chat"><span className="empty-icon">✧</span><p>Ask me anything.<br />I’ll help you figure it out.</p><div className="suggested-prompts">{["Help me understand this", "What should I do next?"] .map((text) => <button key={text} onClick={() => setDraft(text)}>{text}<span>↗</span></button>)}</div></div> : messages.map((message, index) => <article key={`${index}-${message.role}`} className={`message ${message.role}`}>
            {message.role === "panda" && <div className="message-avatar"><PandaMark small /></div>}
            <div className="message-content">{message.proactive && <span className="suggestion-label">A THOUGHT FOR YOU</span>}<p>{message.text}</p><small>{message.role === "user" ? "You" : "Panda"}</small></div>
          </article>)}
          {busy && <div className="typing"><PandaMark small /><span /><span /><span /></div>}
          <div ref={endRef} />
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void submitQuestion(); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask me anything…" disabled={busy || sessionTransition} aria-label="Message panda" />
          <button className="send-button" type="submit" disabled={busy || sessionTransition || !draft.trim()} aria-label="Send message">↑</button>
        </form>
        <p className="chat-footnote">{session === "live" ? "Analyzes sampled screenshots · not continuous video" : "Start a live session to share your screen"}</p>
      </section>
    </>}
    <footer className="app-footer"><span>made with a little care</span><span className="footer-heart">♥</span></footer>
    </> : <button className="collapsed-panda" data-tauri-drag-region title="Open panda chat" onClick={() => void expandPanda()}>
      <PandaMark /><span className={`collapsed-indicator ${session}`} />{unread && <span className="unread-dot" />}
    </button>}
  </main>;
}

function errorText(error: unknown) { return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong. Please try again."; }

type AskOptions = { question: string; imageDataUrl: string | null; screenText: string | null; history: ChatMessage[]; routine: boolean; detailed: boolean; sessionEpoch: number | null };
type AskHooks = { isCurrent: () => boolean; onDelta: (fullText: string) => void; onFirstToken: (ms: number) => void; onTimings: (value: OllamaTimings) => void };
async function askProvider(provider: Provider, model: string, options: AskOptions, hooks: AskHooks): Promise<{ text: string }> {
  const started = performance.now();
  const modelLabel = provider === "ollama" ? model : undefined;
  console.info("[Panda AI] request started", { provider, model: modelLabel });
  try {
    let result: { text: string };
    if (provider === "ollama") {
      const channel = new Channel<OllamaEvent>();
      let text = "";
      let flushTimer = 0;
      let completed = false;
      channel.onmessage = (event) => {
        if (completed) return;
        if (event.kind === "delta" && event.text) {
          text += event.text;
          if (!flushTimer) flushTimer = window.setTimeout(() => { flushTimer = 0; hooks.onDelta(text); }, 40);
        } else if (event.kind === "firstToken" && typeof event.elapsedMs === "number" && hooks.isCurrent()) hooks.onFirstToken(event.elapsedMs);
        else if (event.kind === "metrics" && event.timings && hooks.isCurrent()) hooks.onTimings(event.timings);
      };
      try {
        result = await invoke<{ text: string }>("ask_ollama", { ...options, model, onEvent: channel });
        completed = true;
        if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
        if (hooks.isCurrent()) hooks.onDelta(result.text);
      } catch (error) {
        completed = true;
        throw error;
      } finally { if (flushTimer) window.clearTimeout(flushTimer); }
    } else {
      result = await invoke<{ text: string }>("ask_openai", {
        question: options.question, imageDataUrl: options.imageDataUrl,
        screenText: options.screenText, history: options.history, sessionEpoch: options.sessionEpoch,
      });
    }
    console.info("[Panda AI] request completed", { provider, model: modelLabel, status: "success", elapsedMs: Math.round(performance.now() - started), responseChars: result.text.length });
    return result;
  } catch (error) {
    console.warn("[Panda AI] request completed", { provider, model: modelLabel, status: "error", elapsedMs: Math.round(performance.now() - started) });
    throw error;
  }
}

async function createOcrWorker() {
  return createWorker("eng", 1, {
    workerPath: new URL("tesseract.js/dist/worker.min.js", import.meta.url).href,
    corePath: new URL("tesseract.js-core/tesseract-core.wasm.js", import.meta.url).href,
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    gzip: true,
  });
}

function normalizeSuggestion(text: string) { return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " "); }
function formatMs(value: number | null) { return value === null ? "—" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`; }

async function getVisualSignature(dataUrl: string) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const signature = new Array<number>(pixels.length / 4);
  for (let index = 0; index < signature.length; index++) {
    const offset = index * 4;
    signature[index] = Math.round((pixels[offset] * 0.3 + pixels[offset + 1] * 0.59 + pixels[offset + 2] * 0.11) / 16);
  }
  return signature;
}

function imageDelta(previous: number[], current: number[]) {
  // Compare a tiny grayscale sample locally; never retain the previous screen image.
  const changed = previous.reduce((count, value, index) => count + (Math.abs(value - current[index]) >= 2 ? 1 : 0), 0);
  return changed / previous.length > 0.12;
}
