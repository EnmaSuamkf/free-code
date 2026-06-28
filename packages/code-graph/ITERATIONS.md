# Future iterations of `@free/code-graph`

---

## Priority 1 — Startup experience

### Auto-index on first startup
When no `.code-graph/` directory exists in the project, the agent currently does nothing at startup — the user must run `/code-index` manually to build the initial index.

**Solution**: detect the absence of `.code-graph/meta.json` at `session_resources_ready` and trigger a full background index automatically, the same way stale re-indexing works. Show a notification while it runs and a success message when done.

**Impact**: zero-setup experience — open a project and the code graph is ready without any manual step.

---

## Priority 2 — Correctness

### TypeChecker-based call resolution
`code_callers` is currently text-based: any class with a `save()` method matches a search for `save`. This produces false positives for common method names.

**Solution**: integrate `ts.Program` + TypeChecker to resolve exactly which `User.save()` vs `Post.save()` is being called and assign a concrete `toId` to each call edge. Requires indexing via `ts.createProgram` instead of `ts.createSourceFile` — slower but type-accurate.

### Resolve IMPORT edges to fileId
Cross-reference the resolved `toName` of an IMPORTS edge against `files.json` to assign a concrete `toFileId`.

Enables impact queries: _"which files depend on this module?"_

Requires a two-pass index: first collect all files, then resolve IDs.

---

## Priority 3 — Scalability

### Migrate store to SQLite (`better-sqlite3`)
The current JSON + in-memory store blocks the event loop when parsing 50–100 MB graphs.

**Solution**: swap `CodeGraphStore` for a SQLite-backed implementation with FTS5 full-text search. The public API (`load`, `save`, `searchSymbols`, etc.) stays unchanged — only the internal implementation changes.

### Monorepo and workspace support
Phase 1 assumes a single `tsconfig.json` at `rootDir`.

**Solution**: read the root `package.json` + `pnpm-workspace.yaml` / `turbo.json`, detect sub-packages, and build a per-package `AliasResolver`. Allows conflicting aliases that point to different locations depending on the sub-package context.

---

## Priority 4 — Dynamism

### Incremental file watcher
Manual indexing is sufficient for Phase 1 but expensive in long sessions.

**Solution**: `FSWatcher` (Node `fs.watch`) + a 1.5s debounce on touched files, re-indexing only the changed ones automatically.

### Partial on-demand re-index
When `queryContext` detects an `mtime` mismatch it currently returns a hard error. Instead, re-index only that file on the fly.

Slower than an error, but transparent to the LLM.

---

## Priority 5 — Alias resolver

### Vite, webpack, jsconfig support
- `vite.config.ts` / `webpack.config.js`: require controlled JS execution (vm sandbox or `esbuild` + `eval`)
- `jsconfig.json`: same logic as `tsconfig.json`, add to the scan
- Babel `module-resolver` with complex multi-capture-group regex patterns

---

## Priority 6 — Extensibility

### Multi-language support via tree-sitter
Add `web-tree-sitter` + grammars for Python, Go, Rust, Ruby.

`SymbolInfo` / `EdgeInfo` types are already language-agnostic. The current extractor (TypeScript Compiler API) becomes one of several extractors behind an `Extractor` interface.

### Route detector
Detect Express / Fastify / Next.js route handlers and create nodes of type `route`.

Enables queries like: _"which HTTP endpoints end up calling this function?"_

### LSP as secondary source
Use `typescript-language-server` (via JSON-RPC) as a ground-truth source for `go-to-definition` and `find-references`, complementing the AST index for cases where maintaining a full TypeChecker in-process would be too expensive.
