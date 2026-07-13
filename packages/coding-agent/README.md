# @free/coding-agent

The core CLI agent that powers free-code. Interactive coding assistant with tool integration, session management, and extensibility.

**Packager:** `@free/pi-coding-agent` on npm  
**CLI command:** `free-code`  
**User documentation:** [docs/README.md](../../docs/README.md)

---

## Installation

### Global (Recommended for Users)

```bash
npm install -g @free/pi-coding-agent
free-code
```

Then authenticate: `/login` or set `ANTHROPIC_API_KEY`.

### As a Dependency

```bash
npm install @free/pi-coding-agent
```

Use the SDK or RPC mode for programmatic integration. See [docs/sdk.md](../../docs/sdk.md) and [docs/rpc.md](../../docs/rpc.md).

---

## Vision Mode

Multimodal extension with **screen capture**, **voice input** (STT), **text-to-speech** (TTS), and **hands-free mode**.

### Commands

- `/see <question>` — Capture screen, ask about it (vision)
- `/voice [context]` — Record audio, transcribe, ask (STT)
- `/vision live [on|off]` — Hands-free mode (continuous listening + TTS responses)
- `/vision status` — Show current config
- `/vision backends` — List available backends (screen capture, STT, TTS)
- `/vision config [key] [value]` — View/change settings

**Push-to-talk shortcut:** `Ctrl+Alt+V` (configurable via `/vision config shortcut`)

### Quick Start

**Prerequisites:**
- Screen capture: GNOME/KDE/macOS (auto-detected)
- Audio recorder: `pw-record` or `arecord` (auto-detected on Linux)
- STT backend: OpenAI/Groq API key **OR** local whisper.cpp
- TTS backend: OpenAI API key **OR** local `espeak`

**Setup (Groq — fastest, free):**

1. Get a free API key: https://console.groq.com/keys
2. Add to `~/.free-code/agent/.env`:
   ```bash
   echo 'GROQ_API_KEY=gsk_...' >> ~/.free-code/agent/.env
   ```
3. Configure STT:
   ```
   /vision config sttBackend groq
   /vision config sttModel whisper-large-v3-turbo
   ```
4. Restart free-code

**Setup (OpenAI — good quality):**

1. Add to `~/.free-code/agent/.env`:
   ```bash
   echo 'OPENAI_API_KEY=sk-...' >> ~/.free-code/agent/.env
   ```
2. Restart free-code (uses OpenAI for STT + TTS automatically)

**Setup (Local whisper.cpp — offline):**

```bash
# Install dependencies
sudo apt install cmake

# Clone and build
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make

# Download model
bash ./models/download-ggml-model.sh base

# Install
sudo ln -sf $(pwd)/build/bin/main /usr/local/bin/whisper
```

Then configure:
```
/vision config sttBackend whisper-cpp
```

### Usage Examples

**Screen capture + vision:**
```
/see What windows are open?
/see Describe this error message
```

**Voice input:**
```
/voice
```
Speak → transcribes → optionally edits → send

Or use `Ctrl+Alt+V`: press to start recording, press again to stop + transcribe.

**Hands-free mode:**
```
/vision live on
```

Say "max" (wake word) + your question:
- "max, hello" → conversation
- "max, what do you see" → captures screen + describes

Interrupt TTS: press `Ctrl+Alt+V`

Stop: `/vision live off`

### Configuration

**Common settings:**

```bash
# Wake word (default: "max", empty = no wake word)
/vision config liveWakeWord max

# Voice mode: review (edit before send) or send (auto-send)
/vision config voiceMode send

# TTS voice (alloy, echo, fable, onyx, nova, shimmer)
/vision config ttsVoice nova

# Disable TTS in live mode (STT only)
/vision config liveSpeak false

# Screen capture: always (true) or only on keywords like "what do you see" (false)
/vision config liveAlwaysCapture false
```

**All settings:** `/vision config`

### Backends

**STT (Speech-to-Text):**
- `openai` — OpenAI Whisper API (good quality, ~1-3s latency)
- `groq` — Groq Whisper API (**fastest**, ~200-500ms, free tier)
- `whisper-cpp` — Local whisper.cpp (offline, requires compilation)

**TTS (Text-to-Speech):**
- `openai` — OpenAI TTS API (natural voices, requires API key)
- `espeak` — Local espeak (robotic, free, install: `sudo apt install espeak`)

**Screen Capture:**
- `portal` — XDG Desktop Portal (Wayland)
- `gnome-screenshot` — GNOME (install: `sudo apt install gnome-screenshot`)
- `grim` — wlroots compositors
- `spectacle` — KDE
- `scrot` — X11
- `screencapture` — macOS

Backend selection is automatic (`auto`). Override with `/vision config captureBackend <name>`.

### Performance Tips

1. **Use Groq for STT** — 10-20x faster than OpenAI Whisper
2. **Reduce recording window** — `/vision config liveTurnMaxMs 5000` (5s instead of 8s)
3. **Disable wake word** — `/vision config liveWakeWord ""` (process everything, faster but less selective)

### Troubleshooting

Check available backends:
```
/vision backends
```

If a backend shows ✗:
- **STT**: Add API key to `.env` or install whisper.cpp
- **TTS**: Add OpenAI key or `sudo apt install espeak`
- **Screen capture**: Install `gnome-screenshot` (GNOME) or `grim` (Wayland)
- **Recorders**: Install `pipewire` (provides `pw-record`) or `alsa-utils` (`arecord`)

Full config: `~/.free-code/agent/vision.json`

See also: [Vision Mode Plan](../../analysis/vision-mode-plan.md)

---

## For Developers

**Contributing to the agent?** Start here.

### Build & Test

```bash
# From monorepo root
npm install
npm run build

# Run tests
./test.sh

# Run type check
npm run check
```

### Project Structure

```
packages/coding-agent/
├─ src/
│  ├─ core/           # Agent runtime (resource loading, session management)
│  ├─ modes/          # Interactive, RPC, print, JSON modes
│  ├─ rpc/            # RPC protocol implementation
│  ├─ cli.ts          # Entry point
│  └─ index.ts        # SDK exports
├─ dist/              # Compiled output
├─ examples/          # Extensions, skills, and SDK examples
└─ package.json
```

### Key Concepts

- **Sessions:** JSONL-based tree structure. Stored in `~/.free-code/agent/sessions/`
- **Resource loading:** Discovers `FREE_CODE.md`, `CLAUDE.md`, `AGENTS.md` in project and parent directories
- **Extensions:** TypeScript modules for custom tools, commands, UI
- **MCP:** Tool integration via Model Context Protocol
- **RPC Mode:** stdin/stdout JSON-RPC for non-Node.js integration

### Editing Workflow

After modifying TypeScript:

```bash
npm run build                    # Recompile package
free-code                         # Test from sources
```

The CLI automatically detects the local build in `packages/coding-agent/dist/cli.js` if running from the monorepo.

### Entry Points

- **CLI:** `dist/cli.js` → `free-code` command
- **SDK:** `dist/index.js` → `@free/pi-coding-agent` import
- **RPC:** `free-code --mode rpc`

---

## Documentation

User-facing guides are in [docs/](../../docs/):

| What | Where |
|------|-------|
| Installation & setup | [Setup Guide](../../docs/setup-guide-all-platforms.md) |
| CLI usage | [CLI Guide](../../docs/cli-guide.md) |
| Commands & slash commands | [Commands Reference](../../docs/commands-reference.md) |
| Configuration | [Advanced Configuration](../../docs/advanced-configuration.md) |
| SDK integration | [docs/sdk.md](../../docs/sdk.md) |
| RPC protocol | [docs/rpc.md](../../docs/rpc.md) |

---

## Guidelines

- Project rules (for humans and agents): [AGENTS.md](../../AGENTS.md)
- Contribution guidelines: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Code style: Run `npm run check` before submitting

---

## License

MIT
