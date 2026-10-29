# Release preparation

## Current status

This repository folder has no `.git` metadata and no configured Git remote. The owner, canonical GitHub repository, and Pages URL are unknown. The `website/site.js` download URL is intentionally empty and the button remains disabled. No push, tag, release, or deployment was performed.

Windows screen capture has not been verified end to end. The DXGI one-shot UI/commands compile checks are not evidence of monitor enumeration, frame capture, preview, or vision analysis. Continuous capture, Pause/Stop, and restart are also unverified. Treat Windows distribution as experimental until the checklist in `QA.md` passes on real machines.

## Local Windows checks

From the project root in PowerShell:

```powershell
npm.cmd run build
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:CARGO_TARGET_DIR = (Join-Path (Get-Location).Path "src-tauri\target")
cargo check --manifest-path src-tauri\Cargo.toml --target x86_64-pc-windows-msvc
cargo test --manifest-path src-tauri\Cargo.toml --target x86_64-pc-windows-msvc
npm.cmd run build:windows
```

The configured NSIS output is normally `src-tauri/target/release/bundle/nsis/Panda Companion_<version>_x64-setup.exe` for a local build; target-specific builds may add `x86_64-pc-windows-msvc` in the path. Confirm the actual output and hash before distribution. Do not distribute until capture/UI tests pass.

## GitHub setup (after owner confirms repository)

1. Create or choose the intended repository and set its remote; decide and add an appropriate license before making source public. No license is invented here.
2. Keep API keys and signing certificates out of Git. Unsigned NSIS releases need no secret, but Windows SmartScreen may warn; code signing requires a certificate and protected CI secret.
3. Enable GitHub Pages with **GitHub Actions** as the source. The `pages.yml` workflow publishes only `website/` when `main` changes or on manual dispatch.
4. Replace `website/site.js`'s empty `releaseDownloadUrl` with the confirmed GitHub Release asset URL only after the owner/repository is known and a verified release exists.
5. After manual release checks pass, deliberately push a semantic version tag such as `v0.1.0`. `windows-release.yml` builds NSIS and creates a GitHub Release with the generated setup executable. This action is not triggered by ordinary branch pushes.

## Dependencies users install separately

The Panda installer does not include Ollama or AI model weights. Users need Ollama for Windows, must start it, and must download a supported model separately (for example `ollama pull qwen3.5:2b`). Model storage and performance requirements vary. The installer embeds the WebView2 bootstrapper; setup may download the runtime if needed. The NSIS package is not currently code-signed.
