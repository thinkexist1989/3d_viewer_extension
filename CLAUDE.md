# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VS Code extension that previews 3D models (`.glb` / `.gltf`) inside a webview using three.js. Single command: `Three Model Viewer: Open Viewer` (`threeModelViewer.openViewer`).

## Commands

- `npm run compile` — type-check and emit JS from `src/` to `out/` (`tsc -p ./`).
- `npm run watch` — recompile on change.
- `npx vsce package` — build the `.vsix` (runs `compile` via `vscode:prepublish`).
- Press `F5` in VS Code to launch an Extension Development Host for manual testing.

There is no test runner or linter configured. `npm run compile` (or `tsc`) is the only verification step — run it after editing TypeScript.

## Architecture

Two execution contexts that communicate by message passing:

1. **Extension host** — [src/extension.ts](src/extension.ts), compiled to `out/extension.js` (the `main` entry). Runs in Node, has filesystem access. Registers the command, creates the webview panel, shows the native open dialog, and hands the chosen file's webview URI to the webview.

2. **Webview** — [media/webview.js](media/webview.js) + [media/webview.css](media/webview.css). Runs in the sandboxed browser context. Owns the three.js scene, camera, `OrbitControls`, lighting, and the `GLTFLoader`. Receives the model URI via `window.addEventListener("message", ...)` and also supports drag-and-drop of files directly onto the viewer.

The host→webview message protocol (`webview.postMessage`):
- `loadModelUrl` — both `.glb` and `.gltf`; sends a `vscode-resource` URL (`url`, `fileName`) that the webview's `GLTFLoader.load(url)` fetches directly. Bytes are deliberately **not** sent through `postMessage` — VS Code does not preserve `Uint8Array`/`ArrayBuffer` across the message channel (they arrive as plain `{0:..,1:..}` objects), which silently breaks `.glb` parsing. Letting three.js fetch by URL also resolves external `.bin`/textures for free.
- `requestOpenModel` — webview→host, fired by the toolbar Open button to re-trigger the file dialog.

### three.js loading

three.js is **not** bundled. The host injects an HTML `importmap` ([src/extension.ts](src/extension.ts) `getWebviewHtml`) that maps `three` and `three/addons/` to `webview.asWebviewUri(...)` paths inside `node_modules/three`. So `node_modules/three` must be present at runtime and is shipped in the `.vsix` (it is not excluded by [.vscodeignore](.vscodeignore)). The webview's ES-module imports (`import * as THREE from "three"`) resolve through that importmap.

### Resource roots and CSP — the load-failure footgun

`.gltf` files often reference external `.bin` buffers and texture images by relative path, and `.glb`/`.gltf` files themselves are fetched over `vscode-resource`. For the webview to fetch any of these, two things must line up:

- **`localResourceRoots`** must include the model's containing folder. The host adds it dynamically via `ensureResourceRoot` before posting the URL. `GLTFLoader.load(url)` resolves external resources relative to the model URL, so the whole folder must be reachable. The initial roots also include the filesystem root so arbitrary locations work.
- **CSP** in the webview HTML allows `vscode-resource` / `vscode-cdn` origins for `connect-src` so the loader's fetches aren't blocked.

Drag-and-dropped models load from an in-memory `File` via `GLTFLoader.parse` with an empty base path, so models with external dependencies will fail to fetch — `buildLoadErrorDetails` in [media/webview.js](media/webview.js) surfaces this and steers the user toward the Open button. Keep that error-detail logic intact when touching the load paths; "Failed to fetch" almost always means a resource-root or CSP issue, not a parse error.

The inline `<script>` tags use a per-load `nonce` (`createNonce`) that must match the CSP `script-src 'nonce-...'`.
