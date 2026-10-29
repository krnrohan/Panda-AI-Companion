# Panda Companion

A Tauri 2 desktop application for a floating panda companion. The shared interface is React + TypeScript; the native layer handles local and optional OpenAI chat, OS integration, and experimental screen capture.

## Run locally

Install Node.js, Rust, and the native Tauri prerequisites for the OS you are building on. Windows builds need Microsoft C++ Build Tools and WebView2. macOS builds need Xcode Command Line Tools. Tauri builds platform packages on their respective host OS.

```sh
npm install
npx tauri dev
```

Create the Windows MSI and NSIS installers on Windows with:

```powershell
npm.cmd run build:windows
```

Installers are written under `src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`. The Windows installer embeds the small WebView2 bootstrapper; if the WebView2 Runtime is missing, setup downloads and installs it. The installed Panda app does not need Node.js, Rust, or VS Code.

The product is **Panda Companion**, identifier `com.pandacompany.companion`, version `0.1.0`. The configured Windows installers are MSI and NSIS, and both use the panda icon at `src-tauri/icons/icon.ico` (with PNG sizes for other bundle assets).

### Runtime dependencies

- **Local AI:** Ollama for Windows must be installed and running. For local screen understanding, download a vision model with `ollama pull qwen3.5:2b` (model download is about 2.7 GB). Ollama and the model are separate from the Panda installer. OpenAI mode instead needs the user's own API key and an internet connection.
- **Web runtime:** The installer embeds the WebView2 bootstrapper and installs the Microsoft WebView2 Runtime if needed. The bootstrapper needs internet when the runtime is not already present.
- **First screen session:** Tesseract's English recognition data is fetched from jsDelivr on first use and cached by Tesseract.js. This means first-use OCR needs internet; this download is not an AI-provider request and does not contain the user's screen text or screenshot.
- **Native build requirements:** Node.js, Rust, MSVC Build Tools, and WebView2 are build-machine requirements only, not Panda app dependencies after installation.

## How it works

- Windows one-shot DXGI monitor capture is exposed in Settings for diagnostics. Continuous Windows live-session capture still uses the separate `scrcap` path and has not been verified end to end. Do not rely on it for sensitive workflows.
- The app opens as a full chat panel. Use the top-right collapse button to shrink it to the floating panda; click the panda to reopen the panel. `Command/Ctrl+Shift+P` hides or restores the app window.
- Captures run at one frame per second in a two-frame in-memory queue. The app samples a frame every eight seconds for local OCR and visual-change detection. It sends screen data to OpenAI only for a user question or a proactive suggestion after a detected change, with a one-minute suggestion cooldown.
- macOS screen capture uses `scrcap` and ScreenCaptureKit. Windows has a diagnostic one-shot DXGI path and a distinct `scrcap` live-session path; the latter is unverified. No audio is enabled.
- OCR runs locally using Tesseract.js. Its worker and WASM engine are bundled with the app; the compressed English recognition model is downloaded and cached on first use from jsDelivr. Screenshots and recognized text are not sent to that host.
- The OpenAI key is read and written only by native commands using macOS Keychain or Windows Credential Manager. OpenAI requests use the Responses API and `gpt-4.1-mini`.
- Settings also offers **Local Ollama**. The app checks `http://127.0.0.1:11434/api/tags`, lists locally installed models, and sends chat through Ollama's `/api/chat` endpoint. It never switches to OpenAI when Local Ollama is selected. No API key is needed in local mode.
- To use screen understanding locally, install an Ollama model with the `vision` capability, for example `ollama pull qwen3.5:2b`. Panda verifies that capability with `/api/show` before enabling live screen sharing; screenshots use Ollama's message `images` base64 field. Screen context is sent only during a user-started, active capture session and only to the local Ollama endpoint.
- Chat text and the app exclusion list are stored in the webview's local storage. Screen images are not written to disk; only a tiny 32×32 grayscale signature is retained between samples for local visual comparison.

## Privacy notes

Screen sharing is off until the user starts a session. The system picker determines the selected source, and the active foreground app is checked before and after each frame is read. If it is excluded, analysis is skipped. In OpenAI mode, OpenAI receives the current image and OCR text only for a user request or a proactive suggestion request. In Local Ollama mode, prompts and approved screen context go only to `127.0.0.1:11434`; there is no cloud fallback. OpenAI API data handling is governed by the account's API settings.

## Current platform and build notes

- The macOS capture usage description is in `src-tauri/Info.plist`; the configured minimum is macOS 14.0 to support the native content picker.
- The app is experimental. Windows monitor enumeration, frame preview, image analysis, continuous live sessions, interruption recovery, and Pause/Stop still require manual validation on Windows. See `QA.md`.
- The screen capture crate is currently on its alpha API line. Pin and review its version before distributing production installers.
