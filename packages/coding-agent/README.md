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
