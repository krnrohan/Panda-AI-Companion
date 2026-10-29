# Manual verification checklist

## Windows DXGI diagnostic (not yet verified)

- [ ] Open Settings and explicitly click **Refresh Monitors**; confirm actual monitor names, dimensions, and primary status.
- [ ] Select a monitor and explicitly click **Capture Test Frame**; confirm a real image preview and dimensions.
- [ ] Select Local Ollama with an installed vision model; click **Analyze Captured Frame** and verify a genuine streamed response from the same preview image.
- [ ] Confirm capture does not happen on app launch or monitor refresh.

Continuous live sessions remain a separate, unverified path and must not be inferred from these one-shot diagnostics.

Run these checks on a Windows machine and a macOS machine before distributing a build. The screen selection and permission paths require real OS sessions; they cannot be exercised from a browser preview.

## Shared app flow

- [ ] Switch between OpenAI API and Local Ollama; confirm the selector is disabled during a live/paused screen session.
- [ ] With Ollama stopped, choose Local Ollama and confirm the app reports the local connection issue without calling OpenAI.
- [ ] Start Ollama; refresh and confirm `/api/tags` models appear. Select `qwen3.5:2b` after installing it with `ollama pull qwen3.5:2b`.
- [ ] In Local Ollama mode, ask a text question and confirm it is answered by a real `/api/chat` response without an OpenAI API key.
- [ ] Install/select a vision-capable local model and verify `/api/show` reports `vision`; a text-only model must not enable local screen sharing.
- [ ] In Local Ollama mode, use a live session and ask about visible content; verify the Ollama request contains the approved image in `messages[].images` and no request reaches `api.openai.com`.
- [ ] In Local Ollama mode, make a meaningful screen change and verify a real local model response can produce one proactive suggestion; confirm no cloud request occurs.
- [ ] Select a missing model and confirm the UI offers the `ollama pull <model>` command; confirm there is no silent fallback.
- [ ] Save a valid API key. Confirm the settings panel shows only that it is saved, not the key itself.
- [ ] Try an invalid key and a network failure. Confirm neither is saved to secure storage.
- [ ] Ask a follow-up question and confirm the previous chat turns are used as context.
- [ ] Clear history, relaunch, and confirm chat text is removed; confirm exclusions remain.
- [ ] Add and remove one or more excluded app names.
- [ ] Toggle the app with `Command/Ctrl+Shift+P`; drag the window by its top bar.
- [ ] Collapse to the panda and click it to reopen the chat panel.
- [ ] Confirm screen images and full OCR text are not written to disk.

## macOS

- [ ] Start a live session and select a display/window using the system picker.
- [ ] Cancel the picker; confirm the session remains off.
- [ ] Deny Screen Recording permission; confirm a clear error and usable chat/settings.
- [ ] Grant Screen Recording permission, restart if macOS requires it, then capture successfully.
- [ ] Pause and stop; confirm capture ends. Resume and confirm the picker appears again.
- [ ] Bring an excluded app to the foreground; confirm capture stops and no screen data is sent.
- [ ] Confirm the macOS screen recording indicator is present while sharing.

## Windows

- [ ] Install the MSI and NSIS outputs on a clean Windows machine without Node.js, Rust, or VS Code; confirm Panda launches and uninstalls cleanly.
- [ ] Verify setup installs WebView2 when missing or proceeds when it is already installed.
- [ ] Confirm the installed app shows the Panda Companion name and panda icon in Start, taskbar, and installer UI.
- [ ] Start a live session and select a display/window using the Windows Graphics Capture picker.
- [ ] Cancel the picker; confirm the session remains off.
- [ ] Pause and stop; confirm capture ends. Resume and confirm the picker appears again.
- [ ] Bring an excluded app to the foreground; confirm capture stops and no screen data is sent.
- [ ] Confirm the Windows capture border appears while sharing.

## Proactive help and failures

- [ ] Make a substantial screen/text change and confirm at most one suggestion appears during the one-minute cooldown.
- [ ] Leave the screen unchanged and confirm the panda does not repeatedly interrupt.
- [ ] Disconnect the network or use a revoked API key; confirm errors appear in chat/status and are not retried repeatedly.
- [ ] Verify the bundled Tesseract worker starts and English data downloads once and is cached for later sessions.
