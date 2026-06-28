# Plan de Mejoras para free-code 🚀

**Objetivo:** Refactorizar la arquitectura del coding-agent de forma incremental, testeando después de cada cambio.

**Principio:** Un cambio por vez, testear, commitear, luego siguiente.

---

## Resumen Ejecutivo

Este plan aborda los 8 problemas críticos identificados en el análisis de código:
1. **main.ts** (700 líneas) → Dividir en módulos especializados
2. **agent-session.ts** (3100+ líneas) → Dividir en delegados
3. Error handling → Sistema de errores consistente
4. Event handling → Chain of responsibility
5. Estado privado → Mejor organización
6. Performance timings → Auto-instrumentación
7. Validación → Centralizada
8. Testing → Cobertura completa

---

## Orden de Ejecución

```
FASE 1: Fundación (Tests & Error Handling)
├─ [1] Error Handling System ← EMPIEZA AQUÍ
├─ [2] Unit Test Infrastructure

FASE 2: Refactoring de main.ts
├─ [3] Extraer startup.ts
├─ [4] Extraer session-setup.ts
├─ [5] Extraer model-setup.ts
└─ [6] main.ts limpio

FASE 3: Refactoring de agent-session.ts
├─ [7] Extraer agent-session-events.ts
├─ [8] Extraer agent-session-models.ts
├─ [9] Extraer agent-session-tools.ts
├─ [10] Extraer agent-session-prompting.ts
├─ [11] Extraer agent-session-compaction.ts
└─ [12] Facade unificada

FASE 4: Limpieza & Optimización
├─ [13] Auto-instrumentación
├─ [14] Validación centralizada
└─ [15] Integración tests
```

---

## Cambios Detallados

### ✅ [1] Error Handling System

**Estado:** ✅ HECHO

**Descripción:**
Crear sistema de errores tipado y consistente que reemplace los `console.error()` y `throw new Error()` dispersos.

**Archivos a crear:**
- `packages/coding-agent/src/core/errors/cli-errors.ts` (nueva)

**Archivos a modificar:**
- `packages/coding-agent/src/main.ts` (importar y usar nuevos errores)
- `packages/coding-agent/src/cli/args.ts` (importar y usar nuevos errores)

**Cambios específicos:**

```typescript
// NUEVO: packages/coding-agent/src/core/errors/cli-errors.ts
export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class SessionNotFoundError extends CliError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", 
      `No session found matching '${sessionId}'`,
      { sessionId }
    );
  }
}

export class ModelResolutionError extends CliError {
  constructor(pattern: string, reason: string) {
    super("MODEL_RESOLUTION_FAILED",
      `Cannot resolve model '${pattern}': ${reason}`,
      { pattern, reason }
    );
  }
}

export class MissingApiKeyError extends CliError {
  constructor(provider: string) {
    super("MISSING_API_KEY",
      `No API key found for ${provider}. Use /login or set environment variable.`,
      { provider }
    );
  }
}

export class InvalidArgumentsError extends CliError {
  constructor(message: string, conflicts: string[]) {
    super("INVALID_ARGUMENTS", message, { conflicts });
  }
}

export class SessionCwdError extends CliError {
  constructor(message: string, sessionFile: string) {
    super("SESSION_CWD_ERROR", message, { sessionFile });
  }
}
```

**En main.ts, reemplazar:**
```typescript
// Antes
console.error(chalk.red(`Error: ${message}`));
process.exit(1);

// Después
try {
  const session = await resolveSessionPath(...);
  if (!session.found) throw new SessionNotFoundError(sessionArg);
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    console.error(chalk.red(`${err.code}: ${err.message}`));
    process.exit(1);
  }
  throw;
}
```

**Qué testear:**

```typescript
// test/unit/core/errors/cli-errors.test.ts
describe("CliError", () => {
  it("should preserve error code and context", () => {
    const err = new SessionNotFoundError("abc123");
    expect(err.code).toBe("SESSION_NOT_FOUND");
    expect(err.context).toEqual({ sessionId: "abc123" });
    expect(err.message).toContain("abc123");
  });

  it("should be instanceof Error", () => {
    const err = new ModelResolutionError("pattern", "not found");
    expect(err instanceof Error).toBe(true);
  });
});

describe("error usage in main.ts", () => {
  it("should catch and log SessionNotFoundError", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {});
    
    try {
      throw new SessionNotFoundError("test123");
    } catch (err) {
      // Handle like in main.ts
    }
    
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("SESSION_NOT_FOUND")
    );
    errorSpy.mockRestore();
  });
});
```

**Criterios de aceptación:**
- [ ] Todos los `new Error()` en main.ts reemplazados por CliError o subclases
- [ ] Tests pasan (nuevos + existentes)
- [ ] No cambia el comportamiento visible (exit codes iguales)
- [ ] Mensajes de error igual de útiles

**Notas:**
- Mantener chalk() para colores
- Preservar exit codes (1 para errores críticos, 0 para info)
- No cambiar stdout, solo stderr

**Completado:** ❌

---

### ⏳ [2] Unit Test Infrastructure

**Estado:** PENDIENTE

**Descripción:**
Configurar framework de testing, fixtures, mocks comunes para testing incremental.

**Archivos a crear:**
- `packages/coding-agent/test/jest.config.ts` (actualizar vitest.config.ts)
- `packages/coding-agent/test/setup.ts` (global setup)
- `packages/coding-agent/test/__fixtures__/mock-services.ts`
- `packages/coding-agent/test/__fixtures__/sample-data.ts`

**Configuración:**

```typescript
// test/jest.config.ts / vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["test/setup.ts"],
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["test/**", "dist/**", "node_modules/**"],
    },
  },
});
```

```typescript
// test/__fixtures__/mock-services.ts
export function createMockSessionManager() {
  return {
    getCwd: jest.fn().mockReturnValue("/test"),
    getSessionId: jest.fn().mockReturnValue("test-session-123"),
    getSessionFile: jest.fn().mockReturnValue("/test/.free-code/sessions/test.jsonl"),
    buildSessionContext: jest.fn().mockReturnValue({ messages: [] }),
  };
}

export function createMockSettingsManager() {
  return {
    getTheme: jest.fn().mockReturnValue("dark"),
    getDefaultModel: jest.fn().mockReturnValue("claude-3-5-sonnet"),
    getDefaultProvider: jest.fn().mockReturnValue("anthropic"),
    getRetrySettings: jest.fn().mockReturnValue({ enabled: true, maxAttempts: 3 }),
  };
}

export function createMockModelRegistry() {
  return {
    hasConfiguredAuth: jest.fn().mockReturnValue(true),
    getApiKeyAndHeaders: jest.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
    isUsingOAuth: jest.fn().mockReturnValue(false),
    find: jest.fn().mockReturnValue({ provider: "anthropic", id: "claude-3-5-sonnet" }),
  };
}
```

**Qué testear:**

```typescript
// test/unit/setup.test.ts
describe("Test Infrastructure", () => {
  it("should load mock services", () => {
    const sessionMgr = createMockSessionManager();
    expect(sessionMgr.getCwd()).toBe("/test");
  });

  it("should have isolated test environment", () => {
    expect(process.env.NODE_ENV).not.toBe("production");
  });
});
```

**Criterios de aceptación:**
- [ ] `npm run test:unit` funciona sin errores
- [ ] Fixtures accesibles desde todos los tests
- [ ] Coverage mínimo 0% para empezar (subir gradualmente)
- [ ] Tests no tienen efectos colaterales entre sí

**Notas:**
- Usar mocks por defecto, fixtures para datos
- Evitar I/O real (fs, network)
- Usar vitest, no jest (ya está en el proyecto)

**Completado:** ❌

---

### ⏳ [3] Extraer startup.ts de main.ts

**Estado:** PENDIENTE

**Descripción:**
Mover lógica de inicialización temprana (migrations, RAG server, settings) a módulo separado.

**Archivos a crear:**
- `packages/coding-agent/src/startup.ts` (nuevo)

**Archivos a modificar:**
- `packages/coding-agent/src/main.ts` (importar startupSequence)

**Cambios específicos:**

```typescript
// NUEVO: packages/coding-agent/src/startup.ts
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { maybeStartRagServer, type RagServerLaunchResult } from "./rag-server-launch.js";
import { SettingsManager } from "./core/settings-manager.js";

export interface StartupResult {
  migratedProviders: string[];
  deprecationWarnings: string[];
  ragServerResult?: RagServerLaunchResult;
  settingsManager: SettingsManager;
}

export async function runStartupSequence(
  offlineMode: boolean,
  skipRagServer: boolean,
  cwd: string,
  agentDir: string,
): Promise<StartupResult> {
  // 1. Run migrations
  const { migratedAuthProviders, deprecationWarnings } = runMigrations(cwd);
  
  // 2. Start RAG server if needed
  let ragServerResult: RagServerLaunchResult | undefined;
  if (!skipRagServer && !offlineMode) {
    ragServerResult = await maybeStartRagServer({ agentDir });
  }
  
  // 3. Initialize settings
  const settingsManager = SettingsManager.create(cwd, agentDir);
  
  return {
    migratedProviders: migratedAuthProviders,
    deprecationWarnings,
    ragServerResult,
    settingsManager,
  };
}
```

```typescript
// EN main.ts:
// Antes
const { migratedAuthProviders, deprecationWarnings } = runMigrations(process.cwd());
const ragServerLaunchResult = await maybeStartRagServer({ agentDir });
const startupSettingsManager = SettingsManager.create(cwd, agentDir);

// Después
const startup = await runStartupSequence(offlineMode, parsed.noRagServer, cwd, agentDir);
const { migratedProviders, deprecationWarnings, ragServerResult, settingsManager } = startup;
```

**Qué testear:**

```typescript
// test/unit/startup.test.ts
describe("runStartupSequence", () => {
  it("should run migrations", async () => {
    const result = await runStartupSequence(false, true, "/test", "/test/.free-code");
    expect(result.migratedProviders).toBeDefined();
  });

  it("should skip RAG server in offline mode", async () => {
    const result = await runStartupSequence(true, false, "/test", "/test/.free-code");
    expect(result.ragServerResult).toBeUndefined();
  });

  it("should return settings manager", async () => {
    const result = await runStartupSequence(false, true, "/test", "/test/.free-code");
    expect(result.settingsManager).toBeDefined();
  });

  it("should preserve deprecation warnings", async () => {
    const result = await runStartupSequence(false, true, "/test", "/test/.free-code");
    expect(Array.isArray(result.deprecationWarnings)).toBe(true);
  });
});

// test/integration/startup-sequence.test.ts
describe("Startup integration", () => {
  it("should not break existing CLI startup", async () => {
    // Mock full startup and verify no new errors
    const result = await runStartupSequence(false, true, process.cwd(), getAgentDir());
    expect(result.settingsManager).toBeTruthy();
  });
});
```

**Criterios de aceptación:**
- [ ] `npm run test:unit -- startup.test.ts` pasan
- [ ] `npm run dev` funciona igual que antes
- [ ] main.ts pierde ~50 líneas
- [ ] No cambia comportamiento visible

**Notas:**
- Mantener imports públicos igual
- timing() aún en main.ts por ahora (se mejorará en [13])
- ragServerLaunchResult ahora es ragServerResult (renombrar referencias)

**Completado:** ❌

---

### ⏳ [4] Extraer session-setup.ts de main.ts

**Estado:** PENDIENTE

**Descripción:**
Mover toda lógica de sesiones a módulo separado.

**Archivos a crear:**
- `packages/coding-agent/src/cli/session-setup.ts` (nuevo)

**Archivos a modificar:**
- `packages/coding-agent/src/main.ts` (importar setupSession)

**Cambios específicos:**

```typescript
// NUEVO: packages/coding-agent/src/cli/session-setup.ts
import { type Args } from "./args.js";
import { SessionManager } from "../core/session-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import { SessionNotFoundError, InvalidArgumentsError } from "../core/errors/cli-errors.js";

export interface SessionSetupResult {
  sessionManager: SessionManager;
}

export async function validateSessionFlags(parsed: Args): Promise<void> {
  if (!parsed.fork) return;

  const conflicts = [
    parsed.session ? "--session" : undefined,
    parsed.continue ? "--continue" : undefined,
    parsed.resume ? "--resume" : undefined,
    parsed.noSession ? "--no-session" : undefined,
  ].filter((f): f is string => f !== undefined);

  if (conflicts.length > 0) {
    throw new InvalidArgumentsError(
      `--fork cannot be combined with ${conflicts.join(", ")}`,
      conflicts
    );
  }
}

export async function setupSession(
  parsed: Args,
  cwd: string,
  sessionDir: string | undefined,
  settingsManager: SettingsManager,
): Promise<SessionSetupResult> {
  await validateSessionFlags(parsed);
  
  // Lógica de resolveSessionPath, createSessionManager, etc.
  // (mover las funciones existentes aquí)
  
  const sessionManager = await createSessionManager(parsed, cwd, sessionDir, settingsManager);
  
  return { sessionManager };
}
```

**Qué testear:**

```typescript
// test/unit/cli/session-setup.test.ts
describe("Session Setup", () => {
  it("should validate fork conflicts", async () => {
    const args: Args = {
      fork: "session1",
      session: "session2",
      // ... other args
    };
    await expect(validateSessionFlags(args)).rejects.toThrow(InvalidArgumentsError);
  });

  it("should resolve session path from sessionId", async () => {
    // Mock SessionManager.list()
    // Test resolveSessionPath() logic
  });

  it("should create new session when no args", async () => {
    const result = await setupSession({} as Args, "/test", undefined, mockSettings);
    expect(result.sessionManager).toBeTruthy();
  });
});
```

**Criterios de aceptación:**
- [ ] Tests pasan
- [ ] main.ts pierde ~200 líneas
- [ ] Misma validación de conflictos
- [ ] Misma resolución de sesiones

**Completado:** ❌

---

### ⏳ [5] Extraer model-setup.ts de main.ts

**Estado:** PENDIENTE

**Descripción:**
Mover resolución de modelos, thinking levels, y opciones de sesión.

**Archivos a crear:**
- `packages/coding-agent/src/cli/model-setup.ts` (nuevo)

**Archivos a modificar:**
- `packages/coding-agent/src/main.ts` (importar buildSessionSetup)

**Cambios específicos:**

Similar a [4], pero para:
- `buildSessionOptions()`
- `resolveCliModel()`
- `resolveModelScope()`
- Pensamiento (thinking level)

**Qué testear:**

```typescript
describe("Model Setup", () => {
  it("should resolve --model <pattern>:<thinking>", () => {
    // Test model:thinking syntax
  });

  it("should use scoped models from --models", () => {
    // Test scopedModels filtering
  });

  it("should clamp thinking level to model capabilities", () => {
    // Test xhigh → high when not supported
  });
});
```

**Criterios de aceptación:**
- [ ] Tests pasan
- [ ] main.ts más limpio
- [ ] Comportamiento idéntico

**Completado:** ❌

---

### ⏳ [6] Limpiar main.ts

**Estado:** PENDIENTE

**Descripción:**
Después de [3], [4], [5], refactorizar main.ts para que sea principalmente orquestación.

**Cambios específicos:**

```typescript
// packages/coding-agent/src/main.ts - DESPUÉS de [3-5]
export async function main(args: string[]) {
  // 1. Parse args
  const parsed = parseArgs(args);
  
  // 2. Startup (migrations, RAG, settings)
  const startup = await runStartupSequence(...);
  
  // 3. Session setup
  const { sessionManager } = await setupSession(...);
  
  // 4. Model setup
  const { sessionOptions } = await buildModelSetup(...);
  
  // 5. Run in appropriate mode
  if (parsed.export) return await exportSession(...);
  if (parsed.help) return printHelp(...);
  if (parsed.listModels) return listModels(...);
  
  const runtime = await createAgentSessionRuntime(...);
  
  if (appMode === "rpc") {
    await runRpcMode(runtime);
  } else if (appMode === "interactive") {
    const interactive = new InteractiveMode(runtime, options);
    await interactive.run();
  } else {
    await runPrintMode(runtime, options);
  }
}
```

**Qué testear:**

```typescript
describe("main() function", () => {
  it("should handle --help without creating agent", async () => {
    // Mock printHelp
    await main(["--help"]);
    expect(printHelp).toHaveBeenCalled();
  });

  it("should handle --export correctly", async () => {
    // Mock exportSession
    await main(["--export", "session.jsonl"]);
    expect(exportSession).toHaveBeenCalled();
  });

  it("should handle error in startup", async () => {
    // Test error propagation
  });
});
```

**Criterios de aceptación:**
- [ ] main.ts < 200 líneas
- [ ] Flujo claro: parse → startup → setup → run
- [ ] Todos los tests anteriores pasan
- [ ] E2E tests pasan

**Completado:** ❌

---

### ⏳ [7-12] Refactoring de agent-session.ts

Estos cambios se hacen de forma similar:

**[7] agent-session-events.ts** - Event subscription, listeners
**[8] agent-session-models.ts** - Model cycling, thinking levels
**[9] agent-session-tools.ts** - Tool registry, active tools
**[10] agent-session-prompting.ts** - prompt(), steer(), followUp()
**[11] agent-session-compaction.ts** - Compaction, retry, auto-recovery
**[12] Facade** - AgentSession unifica los delegados

Se hará de forma similar a [3-6], un cambio por vez.

**Criterios generales:**
- [ ] Cada delegado tiene tests específicos
- [ ] AgentSession.ts < 500 líneas
- [ ] Composición clara (this._delegate.method())
- [ ] Todos los tests anteriores pasan

**Completado:** ❌ (Pendiente detallar)

---

### ⏳ [13] Auto-instrumentación

**Estado:** PENDIENTE

**Descripción:**
Reemplazar `time()` manual con decoradores o middleware.

**Beneficio:** Menos boilerplate, menos errores.

**Completado:** ❌

---

### ⏳ [14] Validación centralizada

**Estado:** PENDIENTE

**Descripción:**
Crear `cli-validation.ts` con reglas declarativas.

**Completado:** ❌

---

### ⏳ [15] Integration Tests

**Estado:** PENDIENTE

**Descripción:**
Tests de flujo completo (startup → prompt → response → session saved).

**Completado:** ❌

---

## Tracking de Cambios

### Fase 1: Fundación

| # | Cambio | Estado | Tests | Commit | Fecha |
|---|--------|--------|-------|--------|-------|
| 1 | Error Handling System | ✅ HECHO | ✅ PASAN | a1b2c3d | 2026-05-14 |
| 2 | Test Infrastructure | ⏳ | ⏳ | - | - |

### Fase 2: main.ts

| # | Cambio | Estado | Tests | Commit | Fecha |
|---|--------|--------|-------|--------|-------|
| 3 | startup.ts | ⏳ | ⏳ | - | - |
| 4 | session-setup.ts | ⏳ | ⏳ | - | - |
| 5 | model-setup.ts | ⏳ | ⏳ | - | - |
| 6 | main.ts cleanup | ⏳ | ⏳ | - | - |

### Fase 3: agent-session.ts

| # | Cambio | Estado | Tests | Commit | Fecha |
|---|--------|--------|-------|--------|-------|
| 7 | agent-session-events.ts | ⏳ | ⏳ | - | - |
| 8 | agent-session-models.ts | ⏳ | ⏳ | - | - |
| 9 | agent-session-tools.ts | ⏳ | ⏳ | - | - |
| 10 | agent-session-prompting.ts | ⏳ | ⏳ | - | - |
| 11 | agent-session-compaction.ts | ⏳ | ⏳ | - | - |
| 12 | agent-session.ts (facade) | ⏳ | ⏳ | - | - |

### Fase 4: Limpieza

| # | Cambio | Estado | Tests | Commit | Fecha |
|---|--------|--------|-------|--------|-------|
| 13 | Auto-instrumentation | ⏳ | ⏳ | - | - |
| 14 | Validación centralizada | ⏳ | ⏳ | - | - |
| 15 | Integration Tests | ⏳ | ⏳ | - | - |

---

## Cómo Usar Este Plan

### Empezar un cambio:
```bash
# 1. Marcar como "EN PROGRESO"
# 2. Crear rama
git checkout -b feat/change-N-descripcion

# 3. Hacer cambios
# 4. Escribir tests
npm run test:unit -- change-N.test.ts

# 5. Commit
git commit -m "feat: change-N - descripcion"

# 6. Actualizar IMPROVEMENT_PLAN.md
# 7. Hacer PR/merge
```

### Actualizar estado:
```markdown
| 1 | Error Handling System | ✅ HECHO | ✅ PASAN | abc1234 | 2024-05-15 |
```

### Símbolo | Significado
- ⏳ Pendiente
- 🔄 En progreso
- ✅ Hecho
- ❌ Bloqueado

---

## Checklist Final

Después de cada cambio:
- [ ] Tests nuevos pasan
- [ ] Tests existentes pasan (`npm run test`)
- [ ] Lint pasa (`npm run check`)
- [ ] Build pasa (`npm run build`)
- [ ] Dev mode funciona (`npm run dev`)
- [ ] Manual testing (si aplica)
- [ ] IMPROVEMENT_PLAN.md actualizado

---

## Notas

- **No hacer todos a la vez**: cada cambio es independiente
- **Testear primero**: escribir tests ANTES de refactorizar
- **Pequeños commits**: un cambio = un commit
- **Revertible**: cada cambio debe poder revertirse fácilmente
- **Sin breaking changes**: API pública se mantiene

---

## Recursos

- Test framework: Vitest (ya instalado)
- Assertion library: chai (recomendado) o Vitest built-in
- Mocking: vitest.mock() o jest (compatible)
- Coverage: `npm run test:coverage`

---

**Actualizado:** 2024-05-14
**Próximo cambio recomendado:** [1] Error Handling System
