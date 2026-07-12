# Modo Visión para Free-Code — Investigación y Plan

**Objetivo:** que free-code pueda *ver la pantalla del usuario* y *escuchar lo que dice*, para resolver problemas juntos en tiempo real. Ejemplo: tienes un navegador abierto, preguntas en voz alta *"¿qué es esto?"*, y free-code responde en base a lo que realmente está en tu pantalla.

**Proyecto de referencia estudiado:** [svpino/alloy-voice-assistant](https://github.com/svpino/alloy-voice-assistant) (clonado en `/tmp/alloy-voice-assistant`).

---

## 1. Qué hace alloy-voice-assistant (y qué nos enseña)

Es un único script de Python de ~170 líneas (`assistant.py`) que demuestra el ciclo completo de principio a fin:

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐     ┌─────────┐
│ Mic escucha  │ ──▶ │ Whisper STT  │ ──▶ │ GPT-4o        │ ──▶ │ TTS     │
│ (en segundo  │     │ (local)      │     │ texto+imagen  │     │ (voz)   │
│  plano)      │     └──────────────┘     └───────┬───────┘     └─────────┘
└──────────────┘                                  ▲
                                     ┌────────────┴────────────┐
                                     │ Un hilo de webcam guarda│
                                     │ el ÚLTIMO frame en RAM  │
                                     └─────────────────────────┘
```

Cómo funciona, pieza por pieza:

1. **`WebcamStream`** — un hilo en segundo plano lee continuamente frames de la webcam hacia un buffer protegido con un lock. No se envía nada a ningún sitio; solo mantiene disponible el *frame más reciente*.
2. **`recognizer.listen_in_background(...)`** — la librería `SpeechRecognition` escucha el micrófono con detección de actividad de voz. Cuando dejas de hablar, dispara un callback.
3. **El callback** transcribe el audio con **Whisper local** (modelo `base`), toma el frame actual como JPEG en base64, y envía *transcripción + una imagen* al modelo multimodal (GPT-4o o Gemini Flash) vía LangChain, con el historial de la conversación.
4. **La respuesta se reproduce en voz** con OpenAI TTS (`tts-1`, voz "alloy"), transmitida como PCM a los altavoces.

### La idea clave

> **No hace falta entender vídeo.** El modelo nunca ve un stream — ve *una captura tomada en el instante en que haces la pregunta*, más el historial de la conversación. Eso hace que el problema sea barato, rápido e implementable con cualquier modelo con visión que free-code ya soporta.

### Sus limitaciones (lo que debemos hacer diferente)

| alloy-voice-assistant | Lo que free-code necesita |
|---|---|
| Webcam | **Captura de pantalla** (la petición real) |
| Script de Python independiente | Integrado en free-code (extensión TypeScript) |
| OpenAI/Google hardcodeados | Cualquier modelo con visión vía `packages/ai` |
| Solo chat, sin herramientas | Agente completo: puede *actuar* sobre lo que ve (editar archivos, ejecutar comandos) |
| Inglés hardcodeado en el STT | Idioma configurable (el usuario habla español) |
| Sin modelo de consentimiento/privacidad | La pantalla = secretos; requiere opt-in explícito |

---

## 2. Qué tiene ya free-code (auditoría de este repo)

La buena noticia: **la mayor parte del pipeline ya existe.** Solo faltan la captura (ojos) y el audio (oídos/boca).

| Pieza | Estado | Dónde |
|---|---|---|
| Contenido de imagen en mensajes de usuario | ✅ existe | `packages/ai/src/types.ts:153` — `ImageContent`, soportado en todos los providers |
| Modelos con visión | ✅ existe | Claude, GPT-4o/5, Gemini, etc. vía `packages/ai` |
| Las extensiones pueden inyectar turnos texto+imagen | ✅ existe | `pi.sendUserMessage(content: (TextContent\|ImageContent)[])` — `packages/coding-agent/src/core/extensions/types.ts:1183` |
| Comandos slash / atajos de teclado vía extensiones | ✅ existe | `pi.registerCommand()` + `pi.registerShortcut()` (`types.ts:1138/1140`), patrón default-extensions |
| Pegar imágenes desde el portapapeles | ✅ existe | `src/utils/clipboard-image.ts` + nativo `packages/free-clipboard` |
| Adjuntar archivos de imagen | ✅ existe | `src/cli/file-processor.ts` |
| Capturas del navegador | ✅ existe | `default-extensions/browser/` (agent-browser) — precedente de contexto visual |
| Detección de Wayland | ✅ existe | `isWaylandSession()` exportado en `src/utils/clipboard-image.ts` |
| Resize / conversión de imágenes (WASM) | ✅ existe | Photon vía `loadPhoton()` (`src/utils/photon.ts`) — ya convierte/redimensiona imágenes del portapapeles |
| Pipeline de auto-redimensionado | ✅ existe | setting "Auto-resize images to 2000×2000" + `processFileArguments` (`src/main.ts:142`) |
| Status bar y widgets de extensión | ✅ existe | `ctx.ui.setStatus(key, value)`, `ctx.ui.setWidget(key, content, {placement})` — `mode.ts` ya usa `setStatus` |
| Manipulación del editor de entrada | ✅ existe | `ctx.ui.setEditorText()` / `getEditorText()` (`types.ts:235`) |
| Hooks de eventos de sesión | ✅ existe | `pi.on("tool_call"/"context"/…)` — `mode.ts` los usa para bloquear/interceptar |
| **Captura de pantalla del escritorio** | ❌ falta | — |
| **Entrada de voz (STT)** | ❌ falta | — |
| **Salida de voz (TTS)** | ❌ falta | — |
| **UX de "modo en vivo"** | ❌ falta | — |

Nota del entorno (esta máquina): **Ubuntu GNOME sobre Wayland**, sin ninguna CLI de capturas instalada. En Wayland las aplicaciones no pueden capturar la pantalla silenciosamente — la captura debe pasar por el **XDG Desktop Portal** (`org.freedesktop.portal.Screenshot` para capturas puntuales, `org.freedesktop.portal.ScreenCast` + PipeWire para un stream persistente tras un único diálogo de permiso). Esto en realidad es una ventaja: el sistema operativo nos regala el flujo de consentimiento.

---

## 3. Arquitectura propuesta

Una nueva extensión por defecto, `default-extensions/vision.ts`, distribuida como `browse-command.ts`, construida en cuatro fases incrementales. Cada fase es útil por sí sola.

```
                       sesión de free-code
                              ▲
                              │ pi.sendUserMessage([texto, imagen])
              ┌───────────────┴────────────────┐
              │      extensión vision.ts       │
              │  /see  /voice  /vision live    │
              └───┬──────────┬──────────┬──────┘
                  │          │          │
           ┌──────┴───┐ ┌────┴─────┐ ┌──┴───────┐
           │ Backend  │ │ Backend  │ │ Backend  │
           │ captura  │ │   STT    │ │   TTS    │
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

### Fase 1 — `/see`: captura de pantalla bajo demanda (ojos) — **empezar aquí**

- `/see ¿qué es este error?` → captura la pantalla y llama a `pi.sendUserMessage([{type:"text",...},{type:"image",...}])`. El redimensionado/codificación **no se construye desde cero**: reutilizar Photon (`loadPhoton()`) y engancharse al pipeline existente `autoResizeImages` (setting "2000×2000 max", `processFileArguments`) en vez de un JPEG ~1568px hardcodeado; solo si se quiere un objetivo más agresivo (~1568px, ~1.5k tokens) se añade un modo específico de visión.
- Backends de captura por plataforma, elegidos con la utilidad ya existente `isWaylandSession()`:
  - **Linux/Wayland:** el **portal XDG es el camino primario** (no un fallback) — `org.freedesktop.portal.Screenshot` vía D-Bus (diálogo de permiso; se puede persistir). `gnome-screenshot`/`grim`/`spectacle` solo como fallback si el portal no está disponible.
  - **Linux/X11:** `scrot` / `import` de ImageMagick.
  - **macOS:** `screencapture -x`.
  - **Windows:** captura con PowerShell `System.Windows.Forms` (mismo patrón que el fallback WSL de `clipboard-image.ts`).
- **Detección de dependencias:** en esta máquina ningún fallback está instalado (`gnome-screenshot`/`grim`/`scrot`/`import` → ninguno), pero `xdg-desktop-portal-gnome` sí. La extensión debe detectar el backend disponible y avisar al usuario si falta todo, en vez de fallar silenciosamente.
- Opcional: selector de monitor/ventana cuando hay varias pantallas.
- **Valor:** entrega inmediatamente el caso "tengo un navegador abierto, ¿qué es esto?" — escrito en vez de hablado. Riesgo bajo, ~1–2 días de trabajo.

### Fase 2 — `/voice`: entrada pulsar-para-hablar (oídos)

- Un atajo de teclado registrado con **`pi.registerShortcut(shortcut, {description, handler})`** (`types.ts:1140`) inicia/detiene la grabación del micrófono (`pw-record`/`arecord`/`sox`/`ffmpeg`). *(Nota: no existe `DEFAULT_APP_KEYBINDINGS`; las extensiones registran atajos con `registerShortcut`, y los keybindings base viven en `TUI_KEYBINDINGS` en `packages/tui/src/keybindings.ts`.)*
- Backends de transcripción, configurables:
  - **Local:** `whisper.cpp` (sin coste de API, privado, los modelos `base`/`small` son rápidos en CPU).
  - **API:** OpenAI Whisper, Groq (muy rápido), entrada de audio de Gemini.
- La transcripción se vuelca al editor de entrada con **`ctx.ui.setEditorText()`** (el usuario la revisa con `getEditorText()` antes de enviar) o se envía directamente — configurable.
- Idioma configurable (español/inglés/auto).
- **Detección de dependencias:** `pw-record` y `arecord` ya están presentes en esta máquina; `whisper`/`tts` no. Detectar y avisar.

### Fase 3 — `/vision live`: el ciclo de alloy (manos libres)

- Activa el modo en vivo. Conviene **modelarlo como un modo** (precedente: `default-extensions/mode.ts`), que ya resuelve estado persistido (`pi.appendEntry`), `setStatus`, `setActiveTools` y hooks `pi.on(...)`.
- Escucha de micrófono en segundo plano con VAD (como el `listen_in_background` de alloy); cada frase dispara **capturar el frame más reciente + transcripción → `pi.sendUserMessage([...], { deliverAs: "steer" })`**. El `deliverAs: "steer"` permite inyectar el turno aunque el agente esté streameando — la firma real es `sendUserMessage(content: string | (TextContent|ImageContent)[], options?: { deliverAs?: "steer"|"followUp" })`.
- En Wayland, el modo en vivo usa el **portal ScreenCast + PipeWire**: un solo diálogo de permiso, y luego se pueden tomar frames bajo demanda durante toda la sesión — sin diálogo por pregunta.
- Las respuestas se reproducen en voz vía TTS (streaming, interrumpible) *y* se muestran en la TUI como siempre. Usar `pi.on("context"/…)` para detectar una nueva utterance e interrumpir el TTS en curso. Un añadido al system prompt en modo en vivo pide respuestas cortas y conversacionales cuando no hace falta usar herramientas.
- Indicador de estado con **`ctx.ui.setStatus("vision", "live · escuchando…")`** (mismo mecanismo que `mode.ts` → `setStatus("mode","plan")`); para los controles de silenciar/pausar, `ctx.ui.setWidget("vision", […], {placement})`.

### Fase 4 — variante en web-ui (la demo más barata, mayor alcance)

En `packages/web-ui`, el navegador lo da todo de forma nativa: `getDisplayMedia()` (selector de pantalla integrado en el navegador), Web Speech API o Whisper para STT, `speechSynthesis` o TTS por API. Cero dependencias nativas — un buen sitio para prototipar la UX del modo en vivo antes de pulir la versión de la TUI.

---

## 4. Privacidad, coste, latencia

- **Privacidad:** la pantalla muestra gestores de contraseñas, tokens, mensajes privados. Reglas: opt-in explícito por sesión; capturar *solo en el momento de la pregunta* (nunca subida continua); indicador visible mientras el modo en vivo está activo; una configuración `vision.exclude` para apps/regiones; los diálogos de permiso del portal en Wayland refuerzan el consentimiento.
- **Coste:** un JPEG reducido a 1568px ≈ 1.1–1.6k tokens de entrada. Una sesión en vivo de 30 preguntas ≈ 40–50k tokens de imagen — apreciable pero razonable; enviar imagen solo cuando la pregunta la necesita (heurística o palabra clave "mira…").
- **Presupuesto de latencia (objetivo < 5 s como alloy):** parada del VAD ~0.3 s + Whisper local `base` ~0.5–1 s + captura ~0.1 s + primer token del modelo ~1–2 s + inicio del TTS en streaming ~0.5 s.

## 5. Hoja de ruta sugerida

| Fase | Entregable | Esfuerzo (aprox.) |
|---|---|---|
| 1 | Comando `/see` con backends de captura multiplataforma | 1–2 días |
| 2 | `/voice` pulsar-para-hablar + STT whisper.cpp/API | 2–3 días |
| 3 | `/vision live` — ciclo VAD + portal ScreenCast + TTS | 4–6 días |
| 4 | Modo en vivo en web-ui (`getDisplayMedia` + Web Speech) | 2–3 días, paralelizable |

Entornos reales del repo: **CLI** (`default-extensions`), **VS Code** (`packages/vscode-free-code` + `packages/free-desktop-host/activate-vscode.mjs` para la command palette), **macOS** (`packages/free-desktop-host/src/stdio-mac.mjs`, puente stdio que reusa el core) y **web-ui** (`packages/web-ui`). No existe un paquete `FreeCodeMac` separado. Además, los **slash commands se registran una sola vez** en `default-extensions` (core compartido por CLI/VS Code/Mac) — solo los **atajos** (`registerShortcut`) y las entradas de la *command palette* de VS Code necesitan registro adicional por entorno. Ver el checklist del `AGENTS.md` raíz (y corregir ahí la referencia a `DEFAULT_APP_KEYBINDINGS`, que no existe).

## 6. Veredicto

**Sí, es muy factible.** alloy-voice-assistant valida el modelo de interacción (captura-en-el-momento-de-la-pregunta + STT + TTS, sin necesidad de vídeo), y free-code ya tiene las partes difíciles: pipeline de mensajes multimodal, modelos con visión, y una API de extensiones (`sendUserMessage` con `ImageContent`) que permite entregar todo esto como extensión por defecto sin tocar el core. El trabajo genuinamente nuevo son tres adaptadores bien conocidos — captura de pantalla, STT, TTS — más una UX de consentimiento cuidadosa. La Fase 1 (`/see`) por sí sola ya cumple el ejemplo que motivó la idea y se puede construir de inmediato.
