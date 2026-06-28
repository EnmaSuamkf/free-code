# Extensions — Análisis completo

> Investigación del sistema de extensiones de edo-code, combinando la documentación oficial con el análisis del código fuente via code graph.

---

## Tabla de contenidos

- [Arquitectura interna](#arquitectura-interna)
- [Flujo de carga](#flujo-de-carga)
- [Ubicaciones de extensiones](#ubicaciones-de-extensiones)
- [Estructura de una extensión](#estructura-de-una-extensión)
- [Estilos de extensión](#estilos-de-extensión)
- [Imports disponibles](#imports-disponibles)
- [ExtensionAPI — referencia completa](#extensionapi--referencia-completa)
- [Eventos](#eventos)
  - [Lifecycle overview](#lifecycle-overview)
  - [Resource events](#resource-events)
  - [Session events](#session-events)
  - [Agent events](#agent-events)
  - [Tool events](#tool-events)
  - [Model events](#model-events)
  - [Input events](#input-events)
  - [User bash events](#user-bash-events)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [Custom Tools](#custom-tools)
- [Custom UI](#custom-ui)
- [State Management](#state-management)
- [Error Handling](#error-handling)
- [Patrones y casos de uso](#patrones-y-casos-de-uso)
- [Ejemplos de referencia](#ejemplos-de-referencia)

---

## Arquitectura interna

> Hallada via `code_context` y `code_callers` sobre el código fuente.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `packages/coding-agent/src/core/extensions/loader.ts` | Carga, instancia y gestión de extensiones |
| `packages/coding-agent/src/core/extensions/types.ts` | Tipos: `ExtensionAPI`, todos los eventos y resultados |
| `packages/coding-agent/src/core/resource-loader.ts` | Descubrimiento de extensiones y recarga (`/reload`) |

### Símbolos relevantes (code graph)

| Símbolo | Tipo | Ubicación |
|---------|------|-----------|
| `ExtensionAPI` | interface | `types.ts:1081` |
| `createExtensionAPI` | function | `loader.ts:198` |
| `loadExtensionModule` | function | `loader.ts:349` |
| `loadExtension` | function | `loader.ts:386` |
| `loadExtensionFromFactory` | function | `loader.ts:414` |
| `loadExtensions` | function | `loader.ts:430` |
| `discoverAndLoadExtensions` | function | `loader.ts:565` |
| `DefaultResourceLoader.reload` | method | `resource-loader.ts:348` |

---

## Flujo de carga

```
discoverAndLoadExtensions
  └─► loadExtensions
        └─► loadExtension
              └─► loadExtensionModule          ← usa jiti para importar el .ts sin compilar
              └─► loadExtensionFromFactory
                    └─► createExtensionAPI     ← construye el objeto `pi` que recibe tu función
                          └─► factory(pi)      ← tu export default function se ejecuta aquí
```

**Recarga** (`/reload`):
```
DefaultResourceLoader.reload
  └─► loadExtensions   ← re-ejecuta toda la cadena de carga
```

### Detalles de `loadExtensionModule`

```typescript
async function loadExtensionModule(extensionPath: string) {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    // Bun binary: virtualModules para paquetes bundleados
    // Node.js/dev: aliases a node_modules
    ...(isBunBinary
      ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
      : { alias: getAliases() }),
  });

  const module = await jiti.import(extensionPath, { default: true });
  const factory = module as ExtensionFactory;
  return typeof factory !== "function" ? undefined : factory;
}
```

- Usa **jiti** → TypeScript se ejecuta directamente, sin compilación previa.
- `moduleCache: false` → cada carga es fresca (necesario para `/reload`).
- Espera `export default function` — si el export no es una función, la extensión se ignora.

---

## Ubicaciones de extensiones

> **Seguridad:** las extensiones corren con permisos completos del sistema. Solo instala desde fuentes de confianza.

| Ubicación | Alcance |
|-----------|---------|
| `~/.edo-code/agent/extensions/*.ts` | Global (todos los proyectos) |
| `~/.edo-code/agent/extensions/*/index.ts` | Global (subdirectorio) |
| `.edo-code/agent/extensions/*.ts` | Project-local |
| `.edo-code/agent/extensions/*/index.ts` | Project-local (subdirectorio) |

Rutas adicionales via `settings.json`:

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

**Flag de test rápido:**

```bash
pi -e ./my-extension.ts
# o bien
edo-code -e ./my-extension.ts
```

---

## Estructura de una extensión

Una extensión exporta una función default que recibe `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@edo/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // 1. Suscribirse a eventos
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extensión cargada", "info");
  });

  // 2. Registrar herramientas
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 3. Registrar comandos slash
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

---

## Estilos de extensión

### Archivo único

```
~/.edo-code/agent/extensions/
└── my-extension.ts
```

### Directorio con index.ts

```
~/.edo-code/agent/extensions/
└── my-extension/
    ├── index.ts        ← entry point (export default function)
    ├── tools.ts
    └── utils.ts
```

### Paquete con dependencias npm

```
~/.edo-code/agent/extensions/
└── my-extension/
    ├── package.json
    ├── package-lock.json
    ├── node_modules/
    └── src/
        └── index.ts
```

```json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Ejecutar `npm install` en el directorio; los imports de `node_modules/` se resuelven automáticamente.

---

## Imports disponibles

| Paquete | Propósito |
|---------|-----------|
| `@edo/pi-coding-agent` | Tipos de extensión (`ExtensionAPI`, `ExtensionContext`, eventos) |
| `@sinclair/typebox` | Esquemas para parámetros de herramientas |
| `@edo/pi-ai` | Utilidades AI (`StringEnum` para enums compatibles con Google) |
| `@edo/pi-tui` | Componentes TUI para rendering personalizado |

También disponibles: dependencias npm propias y módulos de Node.js (`node:fs`, `node:path`, etc.).

---

## ExtensionAPI — referencia completa

> Interfaz definida en `types.ts:1081-1325` — el objeto `pi` recibido por tu función.

### Eventos

```typescript
pi.on(event: string, handler: ExtensionHandler<Event, Result?>): void
```

Ver sección [Eventos](#eventos) para la lista completa.

### Herramientas

```typescript
pi.registerTool<TParams, TDetails, TState>(tool: ToolDefinition): void
pi.getActiveTools(): string[]
pi.getAllTools(): ToolInfo[]
pi.setActiveTools(toolNames: string[]): void
```

### Comandos, atajos y flags

```typescript
pi.registerCommand(name: string, options): void
pi.registerShortcut(shortcut: KeyId, options): void
pi.registerFlag(name: string, options): void
pi.getFlag(name: string): boolean | string | undefined
pi.getCommands(): SlashCommandInfo[]
```

### Rendering de mensajes

```typescript
pi.registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void
```

### Acciones

```typescript
pi.sendMessage(message, options?): void
pi.sendUserMessage(content, options?): void
pi.appendEntry<T>(customType: string, data?: T): void
```

`sendMessage` options:
- `deliverAs`: `"steer"` (durante streaming) | `"followUp"` (cuando termina el agente) | `"nextTurn"` (próximo prompt)
- `triggerTurn: true`: dispara respuesta LLM si el agente está idle

`sendUserMessage` options:
- `deliverAs`: `"steer"` | `"followUp"` (obligatorio si el agente está streaming)

### Metadatos de sesión

```typescript
pi.setSessionName(name: string): void
pi.getSessionName(): string | undefined
pi.setLabel(entryId: string, label: string | undefined): void
```

### Ejecución de shell

```typescript
pi.exec(command: string, args: string[], options?): Promise<ExecResult>
// result: { stdout, stderr, code, killed }
```

### Modelo y thinking

```typescript
pi.setModel(model: Model<any>): Promise<boolean>
pi.getThinkingLevel(): ThinkingLevel  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
pi.setThinkingLevel(level: ThinkingLevel): void
pi.getActiveBuiltinToolNames(): string[]
pi.getLoadedSkillPaths(): string[]
pi.getLoadedExtensionPaths(): string[]
```

### Providers

```typescript
pi.registerProvider(name: string, config: ProviderConfig): void
pi.unregisterProvider(name: string): void
```

`ProviderConfig` acepta:
- `baseUrl` — URL del endpoint (requerido si defines modelos)
- `apiKey` — clave de API o nombre de variable de entorno
- `api` — tipo: `"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`, etc.
- `headers` — cabeceras personalizadas
- `models` — array de definiciones de modelos (reemplaza todos los existentes)
- `oauth` — config OAuth para soporte de `/login`
- `streamSimple` — implementación de streaming personalizada

### Event bus

```typescript
pi.events.on("my:event", (data) => { ... })
pi.events.emit("my:event", { ... })
```

### Display filter

```typescript
pi.getResourceDisplayFilter(): ResourceDisplayFilter | undefined
pi.setResourceDisplayFilter(filter: ResourceDisplayFilter): void
```

---

## Eventos

### Lifecycle overview

```
pi arranca
  │
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
usuario envía prompt
  │
  ├─► input (puede interceptar, transformar o manejar)
  ├─► before_agent_start (puede inyectar mensaje, modificar system prompt)
  ├─► agent_start
  ├─► message_start / message_update / message_end
  │
  │   ┌─── turn (se repite mientras el LLM llame herramientas) ───┐
  │   │                                                           │
  │   ├─► turn_start                                              │
  │   ├─► context (puede modificar mensajes)                      │
  │   ├─► before_provider_request (puede inspeccionar/reemplazar) │
  │   │                                                           │
  │   │   LLM responde, puede llamar herramientas:                │
  │   │     ├─► tool_execution_start                              │
  │   │     ├─► tool_call (puede bloquear)                        │
  │   │     ├─► tool_execution_update                             │
  │   │     ├─► tool_result (puede modificar)                     │
  │   │     └─► tool_execution_end                                │
  │   │                                                           │
  │   └─► turn_end                                                │
  │
  └─► agent_end

/new o /resume
  ├─► session_before_switch (puede cancelar)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume" }
  └─► resources_discover { reason: "startup" }

/fork
  ├─► session_before_fork (puede cancelar)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/compact o auto-compaction
  ├─► session_before_compact (puede cancelar o personalizar)
  └─► session_compact

/tree
  ├─► session_before_tree (puede cancelar o personalizar)
  └─► session_tree

/model o Ctrl+P
  └─► model_select

exit (Ctrl+C, Ctrl+D)
  └─► session_shutdown
```

---

### Resource events

#### `resources_discover`

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd, event.reason ("startup" | "reload")
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

---

### Session events

#### `session_start`

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - presente en "new", "resume", "fork"
});
```

#### `session_resources_ready`

Disparado después de `session_start`, cuando el system prompt y el registro de herramientas están listos.

```typescript
pi.on("session_resources_ready", async (event, ctx) => {
  // event.reason - "startup" | "reload"
  const prompt = ctx.getSystemPrompt();
});
```

#### `session_before_switch`

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" | "resume"
  // event.targetSessionFile - solo en "resume"
  const ok = await ctx.ui.confirm("¿Limpiar sesión?", "¿Borrar todos los mensajes?");
  if (!ok) return { cancel: true };
});
```

#### `session_before_fork`

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId
  return { cancel: true };
  // o
  return { skipConversationRestore: true };
});
```

#### `session_before_compact` / `session_compact`

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;
  return { cancel: true };
  // o resumen personalizado:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry, event.fromExtension
});
```

#### `session_before_tree` / `session_tree`

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  return { cancel: true };
  // o resumen personalizado:
  return { summary: { summary: "...", details: {} } };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### `session_shutdown`

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // Cleanup, guardar estado, etc.
});
```

---

### Agent events

#### `before_agent_start`

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt, event.images, event.systemPrompt
  return {
    message: {
      customType: "my-extension",
      content: "Contexto adicional para el LLM",
      display: true,
    },
    systemPrompt: event.systemPrompt + "\n\nInstrucciones extra...",
  };
});
```

#### `agent_start` / `agent_end`

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages
});
```

#### `turn_start` / `turn_end`

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### `message_start` / `message_update` / `message_end`

```typescript
pi.on("message_start", async (event, ctx) => { /* event.message */ });
pi.on("message_update", async (event, ctx) => { /* event.message, event.assistantMessageEvent */ });
pi.on("message_end", async (event, ctx) => { /* event.message */ });
```

#### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### `context`

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - copia profunda, seguro modificar
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### `before_provider_request`

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));
  // Opcional: reemplazar payload
  // return { ...event.payload, temperature: 0 };
});
```

---

### Tool events

#### `tool_call`

Disparado antes de ejecutar la herramienta. **Puede bloquear.** `event.input` es mutable.

```typescript
import { isToolCallEventType } from "@edo/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input es { command: string; timeout?: number }
    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Comando peligroso bloqueado" };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input es { path: string; offset?: number; limit?: number }
    console.log(`Leyendo: ${event.input.path}`);
  }
});
```

Para herramientas personalizadas con tipos:

```typescript
import { isToolCallEventType } from "@edo/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // tipado
  }
});
```

#### `tool_result`

Los handlers se encadenan como middleware. Puede devolver patches parciales.

```typescript
import { isBashToolResult } from "@edo/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details tipado como BashToolDetails
  }

  // Modificar resultado:
  return { content: [...], details: {...}, isError: false };
});
```

---

### Model events

#### `model_select`

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model, event.previousModel, event.source ("set" | "cycle" | "restore")
  ctx.ui.notify(`Modelo: ${event.model.id}`, "info");
});
```

---

### Input events

#### `input`

```typescript
pi.on("input", async (event, ctx) => {
  // event.text, event.images, event.source ("interactive" | "rpc" | "extension")

  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Responde brevemente: ${event.text.slice(7)}` };

  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  return { action: "continue" };
});
```

Resultados posibles: `"continue"` | `"transform"` | `"handled"`

---

### User bash events

#### `user_bash`

```typescript
import { createLocalBashOperations } from "@edo/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command, event.excludeFromContext, event.cwd

  // Envolver el backend local
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // O retornar resultado directamente:
  // return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

---

## ExtensionContext

Recibido como `ctx` en todos los handlers.

| Propiedad / Método | Descripción |
|-------------------|-------------|
| `ctx.ui` | Métodos de UI: `notify`, `confirm`, `select`, `input`, `editor`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`, `custom` |
| `ctx.hasUI` | `false` en print mode y JSON mode |
| `ctx.cwd` | Directorio de trabajo actual |
| `ctx.sessionManager` | Acceso read-only al estado de sesión |
| `ctx.modelRegistry` | Acceso al registro de modelos |
| `ctx.model` | Modelo activo |
| `ctx.signal` | AbortSignal del turno activo (puede ser `undefined` si el agente está idle) |
| `ctx.isIdle()` | Si el agente está idle |
| `ctx.abort()` | Cancelar el turno activo |
| `ctx.hasPendingMessages()` | Si hay mensajes pendientes |
| `ctx.shutdown()` | Solicitar cierre graceful de pi |
| `ctx.getContextUsage()` | Uso de contexto actual (`{ tokens, ... }`) |
| `ctx.compact(options?)` | Disparar compactación |
| `ctx.getSystemPrompt()` | System prompt efectivo del turno actual |

### `ctx.sessionManager` — métodos principales

```typescript
ctx.sessionManager.getEntries()    // Todas las entradas
ctx.sessionManager.getBranch()     // Rama actual
ctx.sessionManager.getLeafId()     // ID de la entrada hoja actual
ctx.sessionManager.getLabel(id)    // Label de una entrada
```

### Uso de `ctx.signal`

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,   // se cancela si el usuario presiona Esc
  });
  const data = await response.json();
  return { details: data };
});
```

---

## ExtensionCommandContext

Extiende `ExtensionContext` con métodos de control de sesión. Solo disponible en handlers de comandos (llamarlos desde event handlers puede causar deadlocks).

```typescript
await ctx.waitForIdle()               // Esperar a que el agente termine
await ctx.newSession(options?)        // Nueva sesión
await ctx.fork(entryId)              // Fork desde una entrada
await ctx.navigateTree(targetId, options?)  // Navegar en el árbol de sesión
await ctx.switchSession(sessionPath) // Cambiar a otra sesión
await ctx.reload()                   // Recargar extensiones, skills, prompts, themes
```

### `ctx.navigateTree` options

- `summarize` — generar resumen de la rama abandonada
- `customInstructions` — instrucciones para el summarizer
- `replaceInstructions` — si `true`, reemplaza el prompt por defecto
- `label` — label a adjuntar a la entrada de resumen o destino

### Listar sesiones disponibles

```typescript
import { SessionManager } from "@edo/pi-coding-agent";

pi.registerCommand("switch", {
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    const choice = await ctx.ui.select("Elige sesión:", sessions.map(s => s.file));
    if (choice) await ctx.switchSession(choice);
  },
});
```

### `ctx.reload()` — comportamiento importante

- Emite `session_shutdown` para el runtime actual.
- El handler que llamó `reload` continúa ejecutándose en la versión anterior.
- Código tras `await ctx.reload()` no debe asumir que el estado en memoria es válido.
- Tratar `reload` como terminal: `await ctx.reload(); return;`

---

## Custom Tools

### Definición completa

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@edo/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Descripción para el LLM",
  promptSnippet: "Frase corta para la sección 'Available tools' del system prompt",
  promptGuidelines: [
    "Bullet extra en la sección 'Guidelines' del system prompt cuando la herramienta está activa."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // usar StringEnum para compatibilidad con Google
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Shim de compatibilidad. Corre antes de la validación del esquema.
    // Útil para migrar campos renombrados.
    return args;
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Reportar progreso
    onUpdate?.({ content: [{ type: "text", text: "Procesando..." }] });

    return {
      content: [{ type: "text", text: "Listo" }],
      details: { result: "..." },
    };
  },
  // Rendering personalizado (opcional)
  renderCall(args, theme, context) { /* ... */ },
  renderResult(result, options, theme, context) { /* ... */ },
});
```

### Herramientas que modifican archivos — `withFileMutationQueue`

Evita condiciones de carrera con herramientas built-in (`edit`, `write`) que corren en paralelo:

```typescript
import { withFileMutationQueue } from "@edo/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Gestión dinámica de herramientas

`pi.registerTool()` puede llamarse en cualquier momento (no solo durante la carga). Las herramientas nuevas están disponibles para el LLM de inmediato, sin `/reload`.

```typescript
const active = pi.getActiveTools();   // nombres activos
const all = pi.getAllTools();          // { name, description, parameters, sourceInfo }[]
pi.setActiveTools(["read", "bash"]);  // cambiar herramientas activas
```

`sourceInfo.source` puede ser: `"builtin"` | `"sdk"` | metadata de extensión.

---

## Custom UI

### Métodos de `ctx.ui`

| Método | Descripción |
|--------|-------------|
| `ctx.ui.notify(msg, level)` | Notificación: `"info"` \| `"success"` \| `"error"` \| `"warning"` |
| `ctx.ui.confirm(title, question)` | Diálogo sí/no → `Promise<boolean>` |
| `ctx.ui.select(title, options)` | Lista de selección → `Promise<string \| undefined>` |
| `ctx.ui.input(title, placeholder?)` | Input de texto → `Promise<string \| undefined>` |
| `ctx.ui.editor(title, initial?)` | Editor de texto multilínea → `Promise<string \| undefined>` |
| `ctx.ui.setStatus(id, text)` | Texto en el footer de estado |
| `ctx.ui.setWidget(id, lines)` | Widget sobre el editor (por defecto) |
| `ctx.ui.setTitle(title)` | Título de la ventana / pestaña |
| `ctx.ui.setEditorText(text)` | Texto en el editor |
| `ctx.ui.custom(component)` | Componente TUI personalizado con teclado completo |

### Renderer de mensajes personalizado

```typescript
pi.registerMessageRenderer("my-type", {
  render(entry, theme, context) {
    // Retorna componentes TUI
  },
});
```

---

## State Management

El estado de extensiones con branching debe guardarse en `details` del tool result y reconstruirse en `session_start`:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Añadido" }],
        details: { items: [...items] },  // persistir para reconstrucción
      };
    },
  });
}
```

Para estado simple (sin branching), también se puede usar `pi.appendEntry(customType, data)`.

---

## Error Handling

- Los errores en handlers de eventos son capturados y logueados; no rompen la sesión.
- En tools, un error no capturado retorna `isError: true` al LLM.
- Usar `ctx.signal` para cancelar operaciones async cuando el usuario presiona Esc.
- En `tool_result` y otros handlers async, pasar `signal: ctx.signal` a `fetch()` y operaciones abort-aware.

---

## Patrones y casos de uso

### Bloquear comandos peligrosos

```typescript
import { isToolCallEventType } from "@edo/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    if (event.input.command.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Peligroso", "¿Permitir rm -rf?");
      if (!ok) return { block: true, reason: "Bloqueado por el usuario" };
    }
  }
});
```

### Git checkpoint en cada turno

```typescript
pi.on("agent_end", async (_event, ctx) => {
  await pi.exec("git", ["stash"]);
  ctx.ui.notify("Checkpoint guardado", "info");
});
```

### Proteger rutas sensibles

```typescript
pi.on("tool_call", async (event, ctx) => {
  const PROTECTED = [".env", "node_modules/"];
  if (isToolCallEventType("write", event)) {
    if (PROTECTED.some(p => event.input.path.includes(p))) {
      return { block: true, reason: `Escritura protegida: ${event.input.path}` };
    }
  }
});
```

### Compactación personalizada

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const summary = await myCustomSummarizer(event.branchEntries);
  return {
    compaction: {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    }
  };
});
```

### Herramienta interactiva (wizard)

```typescript
pi.registerTool({
  name: "deploy",
  description: "Deploy the project",
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const env = await ctx.ui.select("Entorno", ["dev", "staging", "prod"]);
    if (!env) return { content: [{ type: "text", text: "Cancelado" }], details: {} };

    const ok = await ctx.ui.confirm("Confirmar deploy", `¿Deployar a ${env}?`);
    if (!ok) return { content: [{ type: "text", text: "Cancelado" }], details: {} };

    await pi.exec("./deploy.sh", [env], { signal });
    return { content: [{ type: "text", text: `Deploy a ${env} completado` }], details: { env } };
  },
});
```

### Provider personalizado (proxy)

```typescript
pi.registerProvider("my-proxy", {
  baseUrl: "https://proxy.example.com",
  apiKey: "PROXY_API_KEY",
  api: "anthropic-messages",
  models: [{
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet (proxy)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384
  }]
});
```

### Tool que permite al LLM disparar `/reload`

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

---

## Ejemplos de referencia

Los ejemplos funcionales están en:

```
packages/coding-agent/examples/extensions/
```

| Archivo | Descripción |
|---------|-------------|
| `summarize.ts` | Compactación personalizada |
| `snake.ts` | Componente TUI personalizado (juego mientras esperas) |
| `input-transform.ts` | Transformación de input antes de procesamiento |
| `send-user-message.ts` | Envío programático de mensajes al agente |
| `dynamic-tools.ts` | Registro dinámico de herramientas en runtime |

---

*Análisis generado combinando `docs/extensions.md` con inspección de código fuente via `code_context` y `code_callers` sobre `loader.ts` y `types.ts`.*
