// === MODULE: tools ===
// Tool call/result lifecycle, diff rendering, payload formatting.

/**
 * @param {string} toolName
 * @param {ToolEntry} entry
 */
function enqueuePendingToolEntry(toolName, entry) {
  const queue = pendingToolEntriesByName.get(toolName) || [];
  queue.push(entry);
  pendingToolEntriesByName.set(toolName, queue);
}

/**
 * @param {string} toolName
 * @returns {ToolEntry | null}
 */
function dequeuePendingToolEntry(toolName) {
  const queue = pendingToolEntriesByName.get(toolName);
  if (!queue || queue.length === 0) return null;
  const entry = queue.shift() || null;
  if (queue.length === 0) pendingToolEntriesByName.delete(toolName);
  return entry;
}

/**
 * @param {ToolEntry} entry
 * @param {"running" | "success" | "error"} state
 */
function setToolEntryState(entry, state) {
  entry.row.classList.remove(
    "tool-event-running",
    "tool-event-success",
    "tool-event-error",
  );
  entry.row.classList.add(`tool-event-${state}`);
  entry.statusDot.classList.remove(
    "tool-status-running",
    "tool-status-success",
    "tool-status-error",
  );
  entry.statusDot.classList.add(`tool-status-${state}`);
  if (state === "running") entry.label.textContent = `${entry.toolName}`;
  else if (state === "error")
    entry.label.textContent = `${entry.toolName} (error)`;
  else entry.label.textContent = `${entry.toolName} (result)`;
}

/**
 * @param {string} toolName
 * @param {unknown} args
 * @returns {ToolEntry}
 */
function createToolEntry(toolName, args) {
  const row = /** @type {HTMLDetailsElement} */ (
    document.createElement("details")
  );
  row.className = "message tool-event collapsed-tool tool-event-running";
  const head = document.createElement("summary");
  head.className = "tool-head";
  const statusDot = document.createElement("span");
  statusDot.className = "tool-status-dot tool-status-running";
  const label = document.createElement("span");
  label.className = "tool-label";
  label.textContent = toolName;
  head.appendChild(statusDot);
  head.appendChild(label);
  row.appendChild(head);
  const payload = formatToolPayload(args);
  if (payload) {
    row.classList.add("tool-has-payload");
    const pre = document.createElement("pre");
    pre.textContent = payload;
    row.appendChild(pre);
  }
  const resultHost = document.createElement("div");
  resultHost.className = "tool-result-host";
  row.appendChild(resultHost);
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return { row, toolName, label, statusDot, resultHost, hasResult: false };
}

/**
 * @param {ToolEntry} entry
 * @param {unknown} result
 * @param {boolean} isError
 */
function finalizeToolEntry(entry, result, isError) {
  setToolEntryState(entry, isError ? "error" : "success");
  entry.resultHost.textContent = "";
  const diff =
    !isError && (entry.toolName === "edit" || entry.toolName === "write")
      ? getDiffFromResult(result)
      : null;
  if (diff) {
    entry.resultHost.appendChild(renderDiffBlock(diff));
  } else {
    const pre = document.createElement("pre");
    pre.textContent = formatToolResult(result);
    entry.resultHost.appendChild(pre);
  }
  entry.hasResult = true;
  pendingToolRows.delete(entry.row);
  if ((entry.toolName === "edit" || entry.toolName === "write") && !isError) {
    entry.row.open = true;
  }
  scrollMessagesAfterContentChange();
}


function addToolCallMessage(toolName, args) {
  const entry = createToolEntry(toolName, args);
  enqueuePendingToolEntry(toolName, entry);
  pendingToolRows.add(entry.row);
  return entry.row;
}

/**
 * Render a tool result row (head + truncated text body).
 * @param {string} toolName
 * @param {unknown} result
 * @param {boolean} isError
 * @returns {{ row: HTMLDetailsElement, created: boolean }}
 */
function addToolResultMessage(toolName, result, isError) {
  const existing = dequeuePendingToolEntry(toolName);
  if (existing) {
    finalizeToolEntry(existing, result, isError);
    return { row: existing.row, created: false };
  }
  const entry = createToolEntry(toolName, null);
  finalizeToolEntry(entry, result, isError);
  return { row: entry.row, created: true };
}

/**
 * Parse and render a colored diff block from the custom free-code diff format.
 * Format per line: first char is '+' (added), '-' (removed), or ' ' (context).
 * Followed by a padded line number, a space, then the content.
 * Ellipsis lines look like `   ...`.
 * @param {string} diffStr
 * @returns {HTMLElement}
 */
function renderDiffBlock(diffStr) {
  const container = document.createElement("div");
  container.className = "diff-block";
  const lines = diffStr.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const kind = line[0];
    const rest = line.slice(1);
    const row = document.createElement("div");
    const trimmed = rest.trimStart();
    if (trimmed === "..." || trimmed.endsWith(" ...")) {
      row.className = "diff-line diff-line-ellipsis";
      row.textContent = "  \u2026";
      container.appendChild(row);
      continue;
    }
    const spaceIdx = trimmed.indexOf(" ");
    const content = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (kind === "+") {
      row.className = "diff-line diff-line-add";
      row.textContent = `+ ${content}`;
    } else if (kind === "-") {
      row.className = "diff-line diff-line-del";
      row.textContent = `\u2212 ${content}`;
    } else {
      row.className = "diff-line diff-line-ctx";
      row.textContent = `  ${content}`;
    }
    container.appendChild(row);
  }
  return container;
}

/**
 * Extract diff string from a tool result object (edit tool only).
 * @param {unknown} result
 * @returns {string | null}
 */
function getDiffFromResult(result) {
  if (!result || typeof result !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (result);
  const details = r.details;
  if (!details || typeof details !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (details);
  return typeof d.diff === "string" && d.diff.length > 0 ? d.diff : null;
}

/**
 * Pretty-print tool arguments. Falls back to String() if JSON.stringify throws.
 * @param {unknown} payload
 * @returns {string}
 */
function formatToolPayload(payload) {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * Tool results have the shape `{ content: [{ type, text }], details }`.
 * Concatenate text parts (or fall back to JSON). Truncate to keep the chat readable.
 * @param {unknown} result
 * @returns {string}
 */
function formatToolResult(result) {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray(/** @type {Record<string, unknown>} */ (result).content)
  ) {
    const parts = /** @type {unknown[]} */ (
      /** @type {Record<string, unknown>} */ (result).content
    );
    const texts = [];
    for (const p of parts) {
      if (p && typeof p === "object") {
        const o = /** @type {Record<string, unknown>} */ (p);
        if (typeof o.text === "string") texts.push(o.text);
        else if (o.type === "image") texts.push("[image]");
      }
    }
    const joined = texts.join("\n");
    return truncateForChat(joined || formatToolPayload(result));
  }
  return truncateForChat(formatToolPayload(result));
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncateForChat(text, max = 4000) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more chars hidden)`;
}

