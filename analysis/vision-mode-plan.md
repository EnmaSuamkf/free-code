# Free-Code Vision Mode — Investigation & Plan

**Goal:** let free-code *see the user's screen* and *hear the user talk*, so both can solve problems together in real time. Example: you have a browser open, you ask out loud *"what is this?"*, and free-code answers based on what is actually on your screen.

**Reference project studied:** [svpino/alloy-voice-assistant](https://github.com/svpino/alloy-voice-assistant) (cloned to `/tmp/alloy-voice-assistant`).

---

## 1. What alloy-voice-assistant does (and teaches us)

It is a single ~170-line Python script (`assistant.py`) that proves the whole loop end-to-end:

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌─────────┐
│ Mic listens │ ──▶ │ Whisper STT  │ ──▶ │ GPT-4o        │ ──▶ │ TTS     │
│ (background)│     │ (local)      │     │ text + image  │     │ (voice) │
└─────────────┘     └──────────────┘     └───────┬───────┘     └─────────┘
                                                 ▲
                                    ┌────────────┴────────────┐
                                    │ Webcam thread keeps the │
                                    │ LATEST frame in memory  │
                                    └─────────────────────────┘
```

How it works, piece by piece:

1. **`WebcamStream`** — a background thread continuously reads webcam frames into a buffer protected by a lock. Nothing is sent anywhere; it just keeps the *freshest frame* available.
2. **`recognizer.listen_in_background(...)`** — the `SpeechRecognition` library listens on the mic with voice-activity detection. When you stop talking, it fires a callback.
3. **The callback** transcribes the audio with **local Whisper** (`base` model), grabs the current frame as base64 JPEG, and sends *transcript + one image* to the multimodal model (GPT-4o or Gemini Flash) via LangChain, with chat history.
4. **The response is spoken** with OpenAI TTS (`tts-1`, voice "alloy"), streamed as PCM to the speakers.

### The key insight

> **You do not need video understanding.** The model never sees a stream — it sees *one snapshot taken at the instant you ask a question*, plus the conversation history. That makes the problem cheap, fast, and implementable with any vision-capable model free-code already supports.

### Its limitations (what we must do differently)

| alloy-voice-assistant | What free-code needs |
|---|---|
| Webcam | **Screen capture** (the actual request) |
| Standalone Python script | Integrated into free-code (TypeScript extension) |
| OpenAI/Google hardcoded | Any vision model via `packages/ai` |
| Chat only, no tools | Full agent: can *act* on what it sees (edit files, run commands) |
| English hardcoded in STT | Configurable language (user speaks Spanish) |
| No consent/privacy model | Screen = secrets; needs explicit opt-in |

---

## 2. What free-code already has (audit of this repo)

The good news: **most of the pipeline already exists.** Only capture (eyes) and audio (ears/mouth) are missing.

| Building block | Status | Where |
|---|---|---|
| Image content in user messages | ✅ exists | `packages/ai/src/types.ts:153` — `ImageContent`, supported across providers |
| Vision-capable models | ✅ exists | Claude, GPT-4o/5, Gemini, etc. via `packages/ai` |
| Extension can inject text+image turns | ✅ exists | `pi.sendUserMessage(content: (TextContent\|ImageContent)[])` — `packages/coding-agent/src/core/extensions/types.ts:1183` |
| Slash commands / hotkeys via extensions | ✅ exists | `pi.registerCommand()` + `pi.registerShortcut()` (`types.ts:1138/1140`), default-extensions pattern |
| Clipboard image paste | ✅ exists | `src/utils/clipboard-image.ts` + native `packages/free-clipboard` |
| Image file attachments | ✅ exists | `src/cli/file-processor.ts` |
| Browser screenshots | ✅ exists | `default-extensions/browser/` (agent-browser) — precedent for visual context |
| Wayland detection | ✅ exists | `isWaylandSession()` exported in `src/utils/clipboard-image.ts` |
| Image resize / conversion (WASM) | ✅ exists | Photon via `loadPhoton()` (`src/utils/photon.ts`) — already converts/resizes clipboard images |
| Auto-resize pipeline | ✅ exists | "Auto-resize images to 2000×2000" setting + `processFileArguments` (`src/main.ts:142`) |
| Extension status bar & widgets | ✅ exists | `ctx.ui.setStatus(key, value)`, `ctx.ui.setWidget(key, content, {placement})` — `mode.ts` uses `setStatus` |
| Input-editor manipulation | ✅ exists | `ctx.ui.setEditorText()` / `getEditorText()` (`types.ts:235`) |
| Session event hooks | ✅ exists | `pi.on("tool_call"/"context"/…)` — `mode.ts` uses them to block/intercept |
| **Desktop screen capture** | ❌ missing | — |
| **Voice input (STT)** | ❌ missing | — |
| **Voice output (TTS)** | ❌ missing | — |
| **Live "assist mode" UX** | ❌ missing | — |

Environment note (this machine): **Ubuntu GNOME on Wayland**, no screenshot CLI installed. On Wayland, apps cannot silently grab the screen — capture must go through the **XDG Desktop Portal** (`org.freedesktop.portal.Screenshot` for snapshots, `org.freedesktop.portal.ScreenCast` + PipeWire for a persistent stream after a one-time permission dialog). This is actually a feature: the OS gives us the consent flow for free.

---

## 3. Proposed architecture

A new default extension, `default-extensions/vision.ts`, shipped like `browse-command.ts`, built in four incremental phases. Each phase is independently useful.

```
                        free-code session
                              ▲
                              │ pi.sendUserMessage([text, image])
              ┌───────────────┴────────────────┐
              │      vision.ts extension       │
              │  /see  /voice  /vision live    │
              └───┬──────────┬──────────┬──────┘
                  │          │          │
           ┌──────┴───┐ ┌────┴─────┐ ┌──┴───────┐
           │ Capture  │ │   STT    │ │   TTS    │
           │ backend  │ │ backend  │ │ backend  │
           ├──────────┤ ├──────────┤ ├──────────┤
           │ Wayland: │ │ local:   │ │ OpenAI   │
           │  portal  │ │ whisper. │ │ tts /    │
           │ X11:scrot│ │ cpp      │ │ Kokoro / │
           │ mac:     │ │ API:     │ │ espeak / │
           │  screen- │ │ whisper, │ │ say      │
           │  capture │ │ groq,    │ │          │
           │ win: PS  │ │ gemini   │ │          │
           └──────────┘ └──────────┘ └──────────┘
```

### Phase 1 — `/see`: screen snapshot on demand (eyes) — **start here**

- `/see what is this error?` → captures the screen and calls `pi.sendUserMessage([{type:"text",...},{type:"image",...}])`. The downscale/encode **is not built from scratch**: reuse Photon (`loadPhoton()`) and hook into the existing `autoResizeImages` pipeline ("2000×2000 max" setting, `processFileArguments`) instead of a hardcoded ~1568px JPEG; only add a vision-specific target (~1568px, ~1.5k tokens) if a more aggressive goal is wanted.
- Capture backends by platform, selected with the existing `isWaylandSession()` helper:
  - **Linux/Wayland:** the **XDG portal is the primary path** (not a fallback) — `org.freedesktop.portal.Screenshot` via D-Bus (permission dialog; can be persisted). `gnome-screenshot`/`grim`/`spectacle` only as fallback if the portal is unavailable.
  - **Linux/X11:** `scrot` / ImageMagick `import`.
  - **macOS:** `screencapture -x`.
  - **Windows:** PowerShell `System.Windows.Forms` capture (same pattern as the WSL fallback in `clipboard-image.ts`).
- **Dependency detection:** on this machine no fallback is installed (`gnome-screenshot`/`grim`/`scrot`/`import` → none), but `xdg-desktop-portal-gnome` is. The extension must detect the available backend and tell the user if nothing is available, instead of failing silently.
- Optional: monitor/window picker when multiple displays exist.
- **Value:** immediately delivers "I have a browser open, what is this?" — typed instead of spoken. Low risk, ~1–2 days of work.

### Phase 2 — `/voice`: push-to-talk input (ears)

- A keybinding registered with **`pi.registerShortcut(shortcut, {description, handler})`** (`types.ts:1140`) starts/stops mic recording (`pw-record`/`arecord`/`sox`/`ffmpeg`). *(Note: `DEFAULT_APP_KEYBINDINGS` does not exist; extensions register shortcuts with `registerShortcut`, and base keybindings live in `TUI_KEYBINDINGS` in `packages/tui/src/keybindings.ts`.)*
- Transcription backends, configurable:
  - **Local:** `whisper.cpp` (no API cost, private, `base`/`small` models are fast on CPU).
  - **API:** OpenAI Whisper, Groq (very fast), Gemini audio input.
- The transcript is dropped into the input editor with **`ctx.ui.setEditorText()`** (user reviews it via `getEditorText()` before sending) or sends directly — configurable.
- Language configurable (Spanish/English/auto).
- **Dependency detection:** `pw-record` and `arecord` are already present on this machine; `whisper`/`tts` are not. Detect and warn.

### Phase 3 — `/vision live`: the alloy loop (hands-free)

- Toggles live mode. Best **modeled as a mode** (precedent: `default-extensions/mode.ts`), which already handles persisted state (`pi.appendEntry`), `setStatus`, `setActiveTools`, and `pi.on(...)` hooks.
- Background VAD mic listening (like alloy's `listen_in_background`); each utterance triggers **capture freshest frame + transcript → `pi.sendUserMessage([...], { deliverAs: "steer" })`**. `deliverAs: "steer"` injects the turn even while the agent is streaming — the real signature is `sendUserMessage(content: string | (TextContent|ImageContent)[], options?: { deliverAs?: "steer"|"followUp" })`.
- On Wayland, live mode uses the **ScreenCast portal + PipeWire**: one permission dialog, then frames can be grabbed on demand for the whole session — no dialog per question.
- Responses are spoken via TTS (streamed, interruptible) *and* rendered in the TUI as usual. Use `pi.on("context"/…)` to detect a new utterance and interrupt the in-flight TTS. A live-mode system-prompt addition asks for short conversational answers when no tool use is needed.
- Status indicator via **`ctx.ui.setStatus("vision", "live · listening…")`** (same mechanism as `mode.ts` → `setStatus("mode","plan")`); for mute/pause controls, `ctx.ui.setWidget("vision", […], {placement})`.

### Phase 4 — web-ui variant (cheapest demo, widest reach)

In `packages/web-ui`, the browser gives everything natively: `getDisplayMedia()` (screen picker built into the browser), Web Speech API or Whisper for STT, `speechSynthesis` or API TTS. Zero native dependencies — a good place to prototype the live-mode UX before polishing the TUI version.

---

## 4. Privacy, cost, latency

- **Privacy:** the screen shows password managers, tokens, private messages. Rules: explicit opt-in per session; capture *only at question time* (never continuous upload); visible indicator while live mode is on; a `vision.exclude` config for apps/regions; portal permission dialogs on Wayland reinforce consent.
- **Cost:** one downscaled 1568px JPEG ≈ 1.1–1.6k input tokens. A 30-question live session ≈ 40–50k image tokens — noticeable but fine; only send an image when the question needs one (heuristic or explicit wake-word "look…").
- **Latency budget (target < 5 s like alloy):** VAD stop ~0.3 s + local Whisper `base` ~0.5–1 s + capture ~0.1 s + model first-token ~1–2 s + streamed TTS start ~0.5 s.

## 5. Suggested roadmap

| Phase | Deliverable | Effort (rough) |
|---|---|---|
| 1 | `/see` command with cross-platform capture backends | 1–2 days |
| 2 | `/voice` push-to-talk + whisper.cpp/API STT | 2–3 days |
| 3 | `/vision live` — VAD loop + ScreenCast portal + TTS | 4–6 days |
| 4 | web-ui live mode (`getDisplayMedia` + Web Speech) | 2–3 days, parallelizable |

Real environments in this repo: **CLI** (`default-extensions`), **VS Code** (`packages/vscode-free-code` + `packages/free-desktop-host/activate-vscode.mjs` for the command palette), **macOS** (`packages/free-desktop-host/src/stdio-mac.mjs`, an stdio bridge that reuses the core), and **web-ui** (`packages/web-ui`). There is no separate `FreeCodeMac` package. Also, **slash commands are registered once** in `default-extensions` (shared core for CLI/VS Code/Mac) — only **shortcuts** (`registerShortcut`) and VS Code *command palette* entries need per-environment registration. See the root `AGENTS.md` checklist (and fix there the reference to `DEFAULT_APP_KEYBINDINGS`, which does not exist).

## 6. Verdict

**Yes, this is very feasible.** alloy-voice-assistant validates the interaction model (snapshot-at-question-time + STT + TTS, no video needed), and free-code already has the hard parts: multimodal message pipeline, vision models, and an extension API (`sendUserMessage` with `ImageContent`) that lets all of this ship as a default extension without touching the core. The genuinely new work is three well-understood adapters — screen capture, STT, TTS — plus careful consent UX. Phase 1 (`/see`) alone already fulfills the motivating example and can be built immediately.
