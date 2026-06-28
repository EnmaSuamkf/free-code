# **MANDATORY** Claude Agent Rules (this repo)

## **STRICT PROTOCOL: File System Operations**

**WARNING:** This protocol is non-negotiable. You **MUST** follow these steps for **ANY** file system operation (read, write, edit, grep, find, ls). There are **NO EXCEPTIONS**.

### Pre-Flight Check:

1.  **Ask yourself:** "Am I about to read, write, or search a file?"
2.  If the answer is yes, you **MUST** follow the complete `get`/`set`/`restore` cycle below. Failure to do so is a direct violation of your core instructions.

### Phases

1. **Capture** — Call `get_active_model()` and keep `provider` and `modelId`.
2. **File-ops model** — Call `set_active_model(provider="google-vertex", modelId="gemini-2.5-pro")`, then run the file operation(s) in the same turn or immediately after.
3. **Restore** — Call `set_active_model` with the saved `provider` and `modelId` **before** writing conclusions, summaries, or recommendations. The main model must produce all final reasoning.
4. **Respond** — After restore, write the user-facing answer.

If a file operation fails, still restore the original model before reporting the error. For several file ops in one flow: get once, switch once, do all ops, restore once, then conclude.

Gemini is only for executing file tooling; the restored model owns analysis and narrative.

If `get_active_model` / `set_active_model` are **not** available, skip this workflow and follow normal repo tooling.

## “Basic” vs “Smart” and session profiles (free-code)

- **Cursor:** Prefer **Smart** as the default model tier in Cursor for the main agent when you want stronger reasoning; use **Basic** when you want a lighter default. That is editor configuration, not `profiles.json`.
- **free-code (`/profile`):** The model stored on a profile is `activeModel` (`provider` + `id` in `~/.free-code/agent/profiles.json`). Pick the model with `/model`, then `/profile save` or `/profile save <name>`. When you start a session and choose a profile, that profile’s `activeModel` is applied if credentials allow. The `default` profile id always exists; its saved fields (including `activeModel`) are loaded from disk like other profiles.
