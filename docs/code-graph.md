# Code Graph — Symbol index and code navigation

The **code graph** is a local index of symbols, call edges, and imports for your project. It lets the agent find functions, classes, and methods, discover who calls a given symbol, and retrieve the full source of any symbol without blindly reading files.

---

## Agent tools

These tools are active by default alongside the built-in tools (`read`, `bash`, etc.):

| Tool | Description |
|------|-------------|
| `code_index` | Build or update the project index |
| `code_symbols` | Search symbols by name |
| `code_callers` | Find all callers of a function or method |
| `code_context` | Get the source code and direct callees of a symbol |

The index is stored in `.code-graph/` at the project root.

---

## Editor commands (`/`)

### `/codeGraph-index [--force]`

Indexes the project to build a code graph of symbols, call edges, and imports.

```
/codeGraph-index           # Incremental — only re-indexes changed files
/codeGraph-index --force   # Re-indexes all files from scratch
```

**When to use:** once after cloning, and with `--force` after large refactors. Day-to-day, stale files are re-indexed automatically in the background on session startup.

---

### `/codeGraph-symbols <query> [--kind <type>] [--limit <n>]`

Searches symbols by name (case-insensitive, substring match).

```
/codeGraph-symbols parseArgs
/codeGraph-symbols handle --kind function
/codeGraph-symbols User --kind class --limit 10
```

**Available kinds:** `function`, `class`, `method`, `interface`, `type`, `variable`, `enum`

---

### `/codeGraph-callers <name> [--limit <n>]`

Finds all code locations that call a given function or method by name.

```
/codeGraph-callers syncDefaultExtensions
/codeGraph-callers render --limit 20
```

> **Note:** matching is text-based — common names like `save`, `render`, or `init` may return false positives from unrelated classes. Use `/codeGraph-context` to verify a caller before trusting the result.

---

### `/codeGraph-context <name> [--file <partial-path>]`

Gets the full source code of a symbol plus its direct callees. Validates that the file has not changed since the last index.

```
/codeGraph-context createAgentSessionServices
/codeGraph-context load --file resource-loader
```

When multiple symbols share the same name across different files, `--file` disambiguates by matching a partial path.

---

## Typical workflow

```
/codeGraph-index                          # 1. Index the project (once)
/codeGraph-symbols parseArgs              # 2. Find a symbol
/codeGraph-callers parseArgs              # 3. See who calls it
/codeGraph-context parseArgs              # 4. Read its source
```

After large changes to the project:

```
/codeGraph-index --force                  # Re-index all files
```

---

## Automatic background re-indexing

On session startup free-code checks whether any `.ts`/`.js` files have been modified since the last index. If so, it **automatically re-indexes in the background** — no manual action needed.

You will see two notifications:

```
⚠️ Code graph index is stale: 5 file(s) modified since last index. Re-indexing in background…
```

Once complete:

```
✓ Code graph updated: 3 file(s) re-indexed in 420ms
```

The re-index runs incrementally (only changed files). Use `/codeGraph-index --force` after large refactors to re-parse everything from scratch.

---

## Installing `@free/code-graph`

The code graph requires the `@free/code-graph` package. If it is not installed, the tools respond with an actionable error message:

```bash
# From the repository root
npm install -g ./packages/code-graph
```

---

## Generated files

The index is written to `.code-graph/` at the project root:

```
.code-graph/
  meta.json      # Timestamp of the last index run and stats
  graph.json     # Symbols, edges (calls + imports), and file hashes
```

Adding `.code-graph/` to `.gitignore` is recommended to avoid committing the index.

---

## Related documentation

| Topic | File |
|-------|------|
| Commands reference | [commands-reference.md](commands-reference.md) |
| Extensions | [extensions.md](extensions.md) |
| Built-in tools | [commands-reference.md#model-and-tools-cli](commands-reference.md) |
