# Plan de implementación: `@edo/code-graph`

> Estado: COMPLETADO ✅  
> Rama de trabajo: `feature/OCTOPUS-11111`  
> Retomar con: `edo-code` en `/Users/pablo.castaneda/Documents/repositories/edo-code`  
> URL del ticket: [https://jira.example.com/browse/OCTOPUS-11111](https://jira.example.com/browse/OCTOPUS-11111)

---

## Contexto de decisiones tomadas

- **Arquitectura**: Opción A — herramientas nativas en `coding-agent` (no MCP separado)
- **Paquete**: nuevo `packages/code-graph` (librería pura, sin TUI)
- **Parser**: TypeScript Compiler API (`ts.createSourceFile`) — solo TS/TSX/JS/JSX en Fase 1
- **Storage**: JSON files + índices en memoria (sin `better-sqlite3`, portable a Node y Bun)
- **Scope Fase 1**: indexación manual + 4 tools; sin watcher incremental
- **Alias resolution**: best-effort para `tsconfig.json paths` y Babel `module-resolver`; Vite/webpack en Fase 2

---

## 🔧 Mejoras Validadas por Gemini (Post-Arquitectura)

La siguiente arquitectura fue validada y refinada en conversación con Gemini 3.1 Pro, incorporando mitigaciones de riesgos y edge cases reales de producción:

### **Riesgos Mitigados en Fase 1**

1. **JSON en Memoria para Proyectos Grandes**
  - ✅ **Veredicto**: Aceptable. 100k símbolos ≈ decenas de MB. El riesgo real es el bloqueo del Event Loop al parsear 50-100MB
  - 📅 **Fase 2**: Migrar a `better-sqlite3` cuando el bloqueo sea molesto
2. **Resolución de IMPORTS sin FileId**
  - ✅ **Veredicto**: Aceptable y prudente. Resolver fileIds requeriría un indexador de dos pasadas
  - 📌 **Mantener** `toName` como string resuelto por alias en Fase 1
3. **Scopes Granulares (Arrow Functions y Closures)**
  - 🔴 **Riesgo detectado**: Sin registrar Arrow/Function Expressions, pierdes trazabilidad en React/Node moderno
  - ✅ **Mitigación**: Scope stack debe registrar `ArrowFunction` y `FunctionExpression` con nombres inferidos (`<anonymous>` o nombre de variable contenedora)
  - 📍 **Implementado en PASO 5**
4. **Invalidación Incremental (Código Stale)**
  - 🔴 **Riesgo crítico**: Si un archivo se edita externamente, las líneas cacheadas quedan desincronizadas
  - ✅ **Mitigación**: Validar `mtime` en `queryContext()` antes de extraer código fuente. Si ≠, devolver error controlado
  - 📍 **Implementado en PASO 7**

### **Edge Cases Adicionales Identificados**


| Problema                                  | Fase 1                                                             | Fase 2                                                |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| **Falsos positivos (save, init, render)** | Prompt Engineering: advertir al LLM en docstring de `code_callers` | TypeChecker / LSP para resolución exacta              |
| **Monorepos (múltiples tsconfig.json)**   | Asumir único `tsconfig.json` en rootDir                            | Detección de workspaces recursivos (npm, pnpm, turbo) |
| **Symlinks infinitos (node_modules)**     | Filtrar explícitamente con `dirent.isSymbolicLink()`               | Seguimiento controlado con Set de rutas visitadas     |


📍 **Más detalles en PASO 6 y PASO 10**

---

## Archivos a crear / modificar

### Nuevos (packages/code-graph)

- `packages/code-graph/package.json`
- `packages/code-graph/tsconfig.build.json`
- `packages/code-graph/src/types.ts`
- `packages/code-graph/src/store.ts`
- `packages/code-graph/src/alias-resolver.ts`
- `packages/code-graph/src/extractor.ts`
- `packages/code-graph/src/indexer.ts`
- `packages/code-graph/src/queries.ts`
- `packages/code-graph/src/index.ts`
- `packages/code-graph/ITERATIONS.md`

### Nuevos (coding-agent)

- `packages/coding-agent/src/core/tools/code-graph-tools.ts`

### Modificados (coding-agent)

- `packages/coding-agent/package.json` — añadir dep `@edo/code-graph`
- `packages/coding-agent/src/core/tools/index.ts` — exportar `codeGraphTools`

---

## Pasos detallados

### PASO 1 — Scaffold del paquete `code-graph`

- Crear `packages/code-graph/package.json`
  - name: `@edo/code-graph`, type: `module`
  - deps: `typescript`, `ignore`
  - devDeps: `@types/node`, `shx`
  - scripts: `build` (tsgo), `clean`
- Crear `packages/code-graph/tsconfig.build.json`
  - extends `../../tsconfig.base.json`
  - outDir `./dist`, rootDir `./src`
  - include `src/**/*.ts`

### PASO 2 — Tipos compartidos (`src/types.ts`)

Definir e exportar:

- `SymbolKind`: `'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'enum'`
- `EdgeKind`: `'CALLS' | 'IMPORTS'`
- `FileInfo`: `{ id, path, hash, mtime }`
- `SymbolInfo`: `{ id, fileId, filePath, kind, name, qualifiedName, startLine, endLine, startCol }`
- `EdgeInfo`: `{ fromId?, toName, kind, fileId }`
- `IndexStats`: `{ filesIndexed, filesSkipped, symbolsTotal, edgesTotal, durationMs }`

### PASO 3 — Store JSON (`src/store.ts`)

Clase `CodeGraphStore` con:

- **Persistencia**: lee/escribe `{graphDir}/meta.json`, `files.json`, `symbols.json`, `edges.json`
- **Índices en memoria** (construidos al `load()`):
  - `filesById: Map<number, FileInfo>`
  - `filesByPath: Map<string, FileInfo>`
  - `symbolsById: Map<number, SymbolInfo>`
  - `symbolsByName: Map<string, SymbolInfo[]>` (clave: `name.toLowerCase()`)
  - `symbolsByFile: Map<number, SymbolInfo[]>`
  - `edgesByToName: Map<string, EdgeInfo[]>` (para lookups de callers)
- **Métodos**:
  - `load(graphDir)` / `save(graphDir)` — carga y persiste
  - `upsertFile(path, hash, mtime): number` — devuelve id
  - `deleteFileData(fileId)` — elimina símbolos y edges del fichero
  - `insertSymbol(sym): number`
  - `insertEdge(edge)`
  - `getFileHash(path): string | undefined`
  - `getStats(): { files, symbols, edges }`
  - `searchSymbols(query, kind?, limit?): SymbolInfo[]`
  - `getCallerEdges(name): Array<{ caller: SymbolInfo | undefined, edge: EdgeInfo }>`
  - `getSymbolById(id): SymbolInfo | undefined`
  - `clear()` — reset completo
- **Auto-incremento**: contador privado `nextId` para cada tabla

### PASO 4 — Alias Resolver (`src/alias-resolver.ts`)

> **Por qué importa**: sin esto, `import { foo } from '@/utils/bar'` queda como `toName = "@/utils/bar"` en el grafo, rompiendo la trazabilidad de dependencias entre módulos. Los edges CALLS (por nombre de función) no se ven afectados.

Función `loadAliases(rootDir): AliasEntry[]` que lee en orden:

**Fuente 1 — `tsconfig.json` → `compilerOptions.paths`**

```json
// tsconfig.json
"paths": {
  "@/*": ["./src/*"],
  "~utils/*": ["./src/utils/*"]
}
```

→ `[{ prefix: "@/", replacement: "src/" }, { prefix: "~utils/", replacement: "src/utils/" }]`

**Fuente 2 — `.babelrc` / `babel.config.json` → plugin `module-resolver`**

```json
// babel.config.json
"plugins": [["module-resolver", { "alias": {
  "^@/(.*)": "./src/$1",
  "^~build/(.*)": "./build/$1"
}}]]
```

Soporte de patrones:

- Regex con grupo de captura `^@/(.*)` → `./src/$1`: se convierte a prefix `@/` → `src/`
- String simple `"@components"` → `"./src/components"`: se usa directamente

**Fuente 3 — `tsconfig.*.json` / `jsconfig.json`** (misma lógica que fuente 1)

Función `resolveImportPath(raw, aliases, filePath, rootDir): string`:

- Si `raw` empieza por `.` o `/` → devolver sin cambios (ya es relativo/absoluto)
- Si `raw` es un módulo de node (`react`, `lodash`, etc.) → devolver sin cambios
- Iterar aliases por orden de especificidad (más largo primero): aplicar el primero que encaje
- Si no hay match → devolver `raw` sin cambios (módulo externo no aliased)

Tipo exportado:

```typescript
export interface AliasEntry { prefix: string; replacement: string }
export function loadAliases(rootDir: string): AliasEntry[]
export function resolveImportPath(raw: string, aliases: AliasEntry[], rootDir: string): string
```

**Limitaciones conocidas (documentar en ITERATIONS.md)**:

- Babel regex con grupos de captura complejos se simplifican a prefix/replacement básico
- `vite.config.ts` / `webpack.config.js` requieren ejecución JS → Fase 2
- `jsconfig.json` de proyectos JS sin TypeScript → Fase 2

### PASO 5 — Extractor AST (`src/extractor.ts`)

Función `extractFromSource(source: ts.SourceFile): ExtractionResult`

Nodos a extraer (visitor recursivo con scope stack):

```
FunctionDeclaration → kind: 'function'
VariableDeclaration (top-level, initializer = ArrowFunction|FunctionExpression) → kind: 'function'
ClassDeclaration → kind: 'class'
MethodDeclaration (dentro de clase) → kind: 'method', qualifiedName: 'ClassName.method'
InterfaceDeclaration → kind: 'interface'
TypeAliasDeclaration → kind: 'type'
EnumDeclaration → kind: 'enum'
```

Edges a extraer:

```
CallExpression(Identifier) → CALLS, toName = callee.text
CallExpression(PropertyAccess) → CALLS, toName = property.name.text
ImportDeclaration → IMPORTS, toName = resolveImportPath(moduleSpecifier.text, aliases, rootDir)
```

El extractor recibe `aliases: AliasEntry[]` como parámetro (cargados por el indexer una vez al inicio).

**Regla del scope stack (⭐ Mejorado post-Gemini):**

- Al entrar en `FunctionDeclaration` / `MethodDeclaration`: `push(qualifiedName)`
- Al entrar en `ArrowFunction` o `FunctionExpression`: `push(inferredName)` donde `inferredName` es:
  - Si está en `VariableDeclaration`: nombre de la variable
  - Si está en `PropertyAssignment`: nombre de la propiedad
  - En otro caso: `<anonymous>`
- Al salir de cualquiera de los anteriores: `pop()`
- `fromId` de un edge CALLS = `currentScope()` (o undefined si top-level)

**Justificación**: Sin esto, los closures y callbacks en React/Node (ej. `array.map(() => funcCall())`) pierden su scope, resultando en `fromId` incorrecto o huérfano. El código moderno requiere esta granularidad.

Retorna: `{ symbols: RawSymbol[], edges: RawEdge[] }`

### PASO 6 — Indexer (`src/indexer.ts`)

Clase `CodeGraphIndexer`:

- `constructor(rootDir, store)`
- `indexProject(options?: { force? }): Promise<IndexStats>`
  1. Llamar `loadAliases(rootDir)` → `aliases` (una sola vez por proyecto)
  2. Construir `ignore` con `.gitignore` del rootDir
  3. Añadir defaults: `node_modules`, `.git`, `dist`, `build`, `*.d.ts`
  4. Walk recursivo de `rootDir` filtrando por extensión (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`)
    - **⭐ Mejorado post-Gemini**: Filtrar explícitamente symlinks usando `fs.readdir({ withFileTypes: true })` y omitiendo entradas donde `dirent.isSymbolicLink() === true`
    - **Justificación**: Evita bucles infinitos en `node_modules` con configuraciones de pnpm u otras herramientas que usan symlinks cíclicos
  5. Para cada fichero: calcular SHA1, comparar con store; saltar si sin cambios
  6. Parse con `ts.createSourceFile`, extraer pasando `aliases`, insertar en store
  7. Llamar `store.save(graphDir)` al final
- `indexFile(filePath, aliases, content?, hash?, mtime?)` — indexa un fichero individual

**Notas sobre Fase 1 vs Fase 2**:

- **Fase 1**: Asumir un único `tsconfig.json` en `rootDir`. Si el usuario está en un monorepo, recomendación es lanzar el agente dentro del sub-paquete específico
- **Fase 2**: Implementar detección recursiva de workspaces (npm, pnpm, turbo) con soporte de múltiples `tsconfig.json` contextualizados por paquete

### PASO 7 — Queries (`src/queries.ts`)

Funciones puras que operan sobre un `CodeGraphStore` + leen fuente de disco:

- `querySymbols(store, query, kind?, limit?): string` — tabla markdown
- `queryCallers(store, name, limit?): string` — lista markdown con `file:line`
  - **⭐ Mejorado post-Gemini (Documentación)**: Nota en docstring que métodos comunes como `save()`, `init()`, `render()` pueden colisionar. El LLM debe usar contexto para filtrar falsos positivos (ver PASO 10)
- `queryContext(store, name, file?, rootDir?): string` — bloque markdown con fuente del símbolo + lista de callees directos

**Validación de Integridad (⭐ Mejorado post-Gemini)**:

- Antes de extraer las líneas del código fuente en `queryContext()`:
  1. Obtener `SymbolInfo` del símbolo solicitado
  2. Buscar en `store.filesById` el `FileInfo` correspondiente
  3. Comparar `mtime` guardado en `FileInfo.mtime` con `mtime` actual del archivo en disco usando `fs.statSync()`
  4. Si **NO coinciden**:
    - No devolver el código basura
    - Devolver error controlado markdown: `"⚠️ File modified since last index. Please run code_index again."`
  5. Si coinciden: proceder a extraer líneas normalmente

**Justificación**: Si el código se edita externamente mientras la sesión está abierta, las líneas cacheadas apuntarían a fragmentos incorrectos, alucinando al agente. Este check crítico lo previene.

Formato de `queryContext`:

```markdown
## `ClassName.methodName` (method) — src/foo.ts:42-67

\`\`\`typescript
<source lines 42..67>
\`\`\`

**Calls:** barFn, bazFn, quxMethod
```

### PASO 8 — Index del paquete (`src/index.ts`)

Re-exportar todo lo público:

```typescript
export { CodeGraphStore } from './store.js';
export { CodeGraphIndexer } from './indexer.js';
export { querySymbols, queryCallers, queryContext } from './queries.js';
export { loadAliases, resolveImportPath } from './alias-resolver.js';
export type { SymbolInfo, EdgeInfo, FileInfo, IndexStats, SymbolKind, EdgeKind, AliasEntry } from './types.js';
```

### PASO 9 — ITERATIONS.md

Documentar las iteraciones futuras planeadas (priorizadas post-Gemini):

#### Fase 2 — Resolución y Precisión

1. **Resolución de Falsos Positivos (TypeChecker)**
  - Integrar `typescript` TypeChecker o cliente LSP (`typescript-language-server`) como fuente de verdad secundaria
  - Permite resolver exactamente `User.save()` vs `Post.save()` mediante inferencia de tipos
  - Asignar `toId` concreto a los edges `CALLS` en lugar de solo `toName` string
  - Migra documentación de `code_callers` a advertencia de contexto vs verdad absoluta
2. **Monorepos y Workspaces Recursivos**
  - Detección automática: leer `package.json` raíz y `pnpm-workspace.yaml`
  - Construir mapa de `AliasResolver` donde cada sub-paquete tiene su propio contexto de resolución
  - Soportar alias conflictivos que apunten a lugares distintos según el paquete
3. **Almacenamiento Escalable (SQLite)**
  - Migrar store a `better-sqlite3` para FTS5 y queries más ricas
  - Store actual es swap-in sin cambiar API pública
  - Resuelve el bloqueo del Event Loop al parsear 100MB+ de JSON

#### Fase 2 — Dinamismo Incremental

1. **Watcher Incremental**
  - FSWatcher + debounce, re-indexar solo ficheros tocados
  - Mantener caché de hashes para validación rápida
  - Sincronización automática en background
2. **Re-indexado Parcial Al Vuelo**
  - Si `code_context` detecta `mtime` mismatch, opcionalmente re-indexar solo ese archivo en lugar de error duro
  - Alternativa a bloquear: "File modified. Reindexing only this file..." (puede ser lento, pero transparente)

#### Fase 2 — Alias Resolver Avanzado

1. **Alias Resolver Dinámico**
  - Soporte `Vite` (`vite.config.ts` ejecutado en sandbox)
  - Soporte `webpack` (`webpack.config.js`)
  - `jsconfig.json` para proyectos JS puros sin TypeScript
  - Regex complejos de Babel `module-resolver` con múltiples grupos de captura

#### Fase 3 — Extensibilidad

1. **Resolución de IMPORTS a FileId**
  - Cruzar `toName` resuelto contra `files.json` para aristas módulo→módulo reales
  - Permite queries de impacto: "qué archivos dependen de este?"
2. **Multi-lenguaje**
  - Añadir `tree-sitter` para Python, Go, Rust, etc.
  - Mantener la misma estructura de `SymbolInfo` y `EdgeInfo` agnóstica del lenguaje
3. **Routes Detector**
  - Detectar handlers Express/Fastify/Next.js y crear nodos `route`
  - Habilitar queries de "qué endpoints llaman a esta función"
4. **LSP como Fuente Secundaria Opcional**
  - Para TS/JS, usar `typescript-language-server` para resolución exacta de tipos y referencias
    - No reemplaza el AST, sino complementa con verdad de tipos

### PASO 10 — Tool definitions en `coding-agent`

Crear `packages/coding-agent/src/core/tools/code-graph-tools.ts`:

4 tools siguiendo el patrón de `grep.ts`:

- `**code_index`**: `{ force?: boolean }` → llama `indexer.indexProject()`, devuelve stats
- `**code_symbols**`: `{ query: string, kind?: SymbolKind, limit?: number }` → `querySymbols()`
- `**code_callers**`: `{ name: string, limit?: number }` → `queryCallers()`
  - **⭐ Docstring Mejorado post-Gemini**: Incluir advertencia explícita:
    ```
    This tool uses text-based matching for method names. 
    For generic names like 'save', 'init', or 'render', expect false positives from other classes. 
    Use code_context to verify the actual caller before trusting results.
    ```
  - **Justificación**: Sin TypeChecker (Fase 2), no podemos resolver exactamente qué `User.save()` vs `Post.save()` se llama. El LLM puede razonar sobre el contexto para filtrar.
- `**code_context`**: `{ name: string, file?: string }` → `queryContext()`
  - **⭐ Incluye Validación de mtime** (ver PASO 7)

Patrón de store lazy:

```typescript
let _store: CodeGraphStore | null = null;
function getOrLoadStore(cwd: string): CodeGraphStore | null {
  const graphDir = join(cwd, '.code-graph');
  if (!existsSync(graphDir)) return null;
  if (!_store) {
    _store = new CodeGraphStore();
    _store.load(graphDir);
  }
  return _store;
}
```

Si no hay índice: devolver `"Project not indexed. Use code_index tool first."`.

`renderCall` y `renderResult` siguen el mismo patrón que `grep.ts` (Text component del TUI).

Exportar:

```typescript
export function createCodeGraphTools(cwd: string): ToolDefinition<any, any>[]
export function createCodeGraphAgentTools(cwd: string): AgentTool<any>[]
```

### PASO 11 — Integrar en `tools/index.ts`

- Añadir exports de `code-graph-tools.ts`
- Añadir `'code_index' | 'code_symbols' | 'code_callers' | 'code_context'` al union `ToolName`
- Incluir en `allTools`, `allToolDefinitions`, `createAllTools`, `createAllToolDefinitions`
- **No** incluirlos en `DEFAULT_ACTIVE_BUILTIN_TOOL_NAMES` por defecto (son opt-in)

### PASO 12 — Actualizar `coding-agent/package.json`

Añadir a `dependencies`:

```json
"@edo/code-graph": "^0.1.0"
```

### PASO 13 — `npm install` y verificar build

```bash
cd /Users/pablo.castaneda/Documents/repositories/edo-code
npm install
cd packages/code-graph && npm run build
cd ../coding-agent && npm run build
```

---

## Verificación final

Después de los 12 pasos, probar manualmente:

```bash
# Desde el directorio del repo
edo-code
# En la sesión del agente:
> usa code_index para indexar el proyecto
> usa code_symbols para buscar "createGrepTool"
> usa code_callers para buscar quién llama a "extractFromSource"
> usa code_context para ver el contexto de "indexProject"
```

---

## Reglas de implementación a respetar

- Sin comentarios en el código salvo WHY no obvios
- Sin `better-sqlite3` ni otras deps nativas
- Sin mocks ni tests en Fase 1 (el código es suficientemente simple)
- La API pública de `code-graph` NO importa nada de `coding-agent` (evitar ciclos)
- `coding-agent` sí importa de `code-graph`
- El `.code-graph/` directorio va en `.gitignore`

