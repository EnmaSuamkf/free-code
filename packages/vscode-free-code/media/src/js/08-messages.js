// === MODULE: messages ===
// Render user, assistant, thinking, subagent messages into the chat.

function clearMessages() {
  messagesEl.innerHTML =
    '<div id="empty-hint">Use /pick-tools to choose which MCPs and extensions are active in this session.</div>';
  assistantNodes.clear();
  assistantRawText.clear();
  thinkingNodes.clear();
  subagentWidgetNodes.clear();
  pendingToolEntriesByName.clear();
  pendingToolRows.clear();
}

/** @type {Record<string, Set<string>>} allowed attributes per uppercase tag name */
const MD_ALLOWED_ATTRS = {
  A: new Set(["href", "title", "target", "rel"]),
  CODE: new Set(["class"]),
  SPAN: new Set(["class"]),
};
const MD_ALLOWED_TAGS = new Set([
  "P", "BR", "STRONG", "EM", "B", "I", "CODE", "PRE", "UL", "OL", "LI", "A",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "HR", "TABLE", "THEAD",
  "TBODY", "TR", "TH", "TD", "DEL", "SPAN",
]);

/**
 * Strip anything not on an explicit allowlist from `marked`-generated HTML before it's
 * inserted via innerHTML. Assistant text can echo back adversarial content (e.g. from a
 * fetched web page or file), so raw HTML tokens and event-handler/script-ish attributes
 * must not survive into the DOM.
 * @param {string} html
 * @returns {string}
 */
function sanitizeMarkdownHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  /** @param {Node} parent */
  const sanitize = (parent) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (child);
        if (!MD_ALLOWED_TAGS.has(el.tagName)) {
          parent.replaceChild(document.createTextNode(el.textContent || ""), el);
          continue;
        }
        const allowedAttrs = MD_ALLOWED_ATTRS[el.tagName];
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (!allowedAttrs || !allowedAttrs.has(name)) {
            el.removeAttribute(attr.name);
            continue;
          }
          if (name === "href" && !/^(https?:|mailto:)/i.test(attr.value.trim())) {
            el.removeAttribute(attr.name);
          }
        }
        if (el.tagName === "A") {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
        sanitize(el);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        parent.removeChild(child);
      }
    }
  };
  sanitize(doc.body);
  return doc.body.innerHTML;
}

/**
 * Render markdown source into `el`, falling back to plain text if `marked` isn't
 * available or parsing throws.
 * @param {HTMLElement} el
 * @param {string} rawText
 */
function renderMarkdownInto(el, rawText) {
  if (window.marked && rawText) {
    try {
      el.innerHTML = sanitizeMarkdownHtml(window.marked.parse(rawText));
      return;
    } catch {
      // fall through to plain text
    }
  }
  el.textContent = rawText;
}

messagesEl.addEventListener("click", (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const link = target.closest ? target.closest("a[href]") : null;
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href") || "";
  if (/^(https?:|mailto:)/i.test(href)) {
    vscode.postMessage({ type: "open_link", url: href });
  }
});

/**
 * Append a thinking `<details>` block and return its streaming body. Defaults to
 * **open** so the user sees the model's reasoning live while it streams (useful
 * to debug long / failing turns where the final answer never arrives). When the
 * assistant's final-answer text starts streaming, any still-open thinking blocks
 * for the current turn are collapsed automatically (see `assistant_message_start`
 * handler) so the conversation stays focused on the answer afterwards.
 *
 * History restore (`restore_history`) passes `open=false` so re-rendered past
 * thinking blocks land collapsed — the user has already seen them stream, and
 * keeping them collapsed matches the post-collapse state from the live turn.
 *
 * @param {string} messageId
 * @param {boolean} [open]
 * @returns {HTMLElement}
 */
function addThinkingBlock(messageId, open = true) {
  const details = /** @type {HTMLDetailsElement} */ (
    document.createElement("details")
  );
  details.className = "message thinking";
  details.open = open;
  const summary = document.createElement("summary");
  summary.className = "thinking-summary";
  summary.textContent = "Thinking";
  // Clicking a <summary> toggles <details> and parks focus on the <summary>. In this
  // webview that steals focus from the chat input: the next Cmd+V / keystroke is
  // routed to the summary (or, in VS Code, to whatever editor had focus before the
  // webview), so paste "lands in the wrong place". Refocus the input on mousedown.
  // Keyboard navigation (Tab → Enter/Space) triggers `keydown`, not `mousedown`, so
  // users tabbing through the chat can still land on the summary to expand it.
  summary.addEventListener("mousedown", () => {
    setTimeout(() => inputEl?.focus({ preventScroll: true }), 0);
  });
  const body = document.createElement("pre");
  body.className = "thinking-body";
  details.appendChild(summary);
  details.appendChild(body);
  messagesEl.appendChild(details);
  thinkingNodes.set(messageId, body);
  lastTurnNodes.push(details);
  scrollMessagesAfterContentChange();
  return body;
}

/**
 * Collapse every currently-open `<details class="message thinking">` block.
 * Called when the assistant's final-answer text starts streaming, so the chat
 * stays focused on the answer once thinking is done. We only touch blocks that
 * are still `open`: if the user has manually collapsed an older block, leave it.
 */
function collapseOpenThinkingBlocks() {
  const open = messagesEl.querySelectorAll("details.message.thinking[open]");
  open.forEach((d) => {
    if (d instanceof HTMLDetailsElement) d.open = false;
  });
}

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `message ${role}`;
  if (role === "assistant") {
    renderMarkdownInto(row, text);
  } else {
    row.textContent = text;
  }
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return row;
}

/** @type {HTMLElement | null} */
let mcpLoadingEl = null;
/** @type {ReturnType<typeof setInterval> | null} */
let mcpLoadingTimer = null;

/**
 * @param {number} seconds
 */
function addMcpLoadingMessage(seconds) {
  if (mcpLoadingEl) { mcpLoadingEl.remove(); mcpLoadingEl = null; }
  if (mcpLoadingTimer) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }

  const row = document.createElement("div");
  row.className = "message mcp-loading";

  const spinner = document.createElement("span");
  spinner.className = "mcp-loading-spinner";
  row.appendChild(spinner);

  const check = document.createElement("span");
  check.className = "mcp-loading-check";
  check.textContent = "✓";
  check.style.display = "none";
  row.appendChild(check);

  const text = document.createElement("span");
  let remaining = Math.max(0, seconds);
  text.textContent = `Loading MCPs, tools, agents and skills (${remaining}s)`;
  row.appendChild(text);

  // Store refs for completeMcpLoading
  row._mcpSpinner = spinner;
  row._mcpCheck = check;
  row._mcpText = text;

  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  mcpLoadingEl = row;

  mcpLoadingTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    text.textContent = `Loading MCPs, tools, agents and skills (${remaining}s)`;
    if (remaining === 0) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }
  }, 1000);
}

function completeMcpLoading() {
  if (mcpLoadingTimer) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }
  if (!mcpLoadingEl) return;
  const row = mcpLoadingEl;
  mcpLoadingEl = null;
  row.classList.add("done");
  if (row._mcpSpinner) row._mcpSpinner.style.display = "none";
  if (row._mcpCheck) row._mcpCheck.style.display = "inline";
  if (row._mcpText) row._mcpText.textContent = "MCPs, tools, agents and skills loaded";
}

/**
 * @param {string} widgetKey
 * @param {string[]} lines
 * @param {string} tabId
 * @param {boolean} expanded
 * @returns {HTMLElement}
 */
function addOrUpdateSubagentWidget(widgetKey, lines, tabId, expanded = false) {
  let row = subagentWidgetNodes.get(widgetKey);
  if (!row) {
    row = document.createElement("button");
    row.type = "button";
    row.className = "message subagent-widget";
    row.dataset.widgetKey = widgetKey;
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (tabId) vscode.postMessage({ type: "select_tab", tabId });
    });
    messagesEl.appendChild(row);
    subagentWidgetNodes.set(widgetKey, row);
  }
  row.dataset.tabId = tabId;
  row.textContent = "";
  row.classList.toggle("subagent-widget-expanded", expanded);
  const safeLines = Array.isArray(lines)
    ? lines.filter((line) => typeof line === "string")
    : [];
  const first = safeLines[0] || "Subagent";
  const status = first.trim().slice(0, 1);
  row.classList.toggle("subagent-running", status === "\u25cf");
  row.classList.toggle("subagent-done", status === "\u2713");
  row.classList.toggle("subagent-error", status === "\u2717");
  const header = document.createElement("div");
  header.className = "subagent-widget-header";
  header.textContent = first;
  row.appendChild(header);
  if (safeLines.length > 1 && !expanded) {
    const body = document.createElement("div");
    body.className = "subagent-widget-body";
    body.textContent = safeLines[1];
    row.appendChild(body);
  } else if (safeLines.length > 1) {
    const details = document.createElement("div");
    details.className = "subagent-widget-details";
    const resultStart = safeLines.findIndex((line) =>
      /^Subagent #\d+/.test(line),
    );
    const detailLines = safeLines
      .slice(1, resultStart === -1 ? undefined : resultStart)
      .filter((line) => line.trim());
    for (const line of detailLines) {
      const item = document.createElement("div");
      item.className = "subagent-widget-detail-line";
      item.textContent = line;
      details.appendChild(item);
    }
    row.appendChild(details);
  }
  scrollMessagesAfterContentChange();
  return row;
}

/**
 * Render a user message with optional attachment chips. The chips show only the
 * file basename, are clickable (open in the editor via `open_file`), and the
 * tooltip carries the full absolute path. The typed text is rendered below in a
 * `pre-wrap` block so multi-line prompts keep their layout. The LLM still sees
 * the absolute path — that part is appended host-side in `handlePrompt`.
 *
 * @param {string} text
 * @param {string[] | undefined} attachments
 * @returns {HTMLDivElement}
 */
function addUserMessage(text, attachments) {
  const row = document.createElement("div");
  row.className = "message user";
  const paths = Array.isArray(attachments)
    ? attachments.filter((p) => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length > 0) {
    const chips = document.createElement("div");
    chips.className = "file-chips-inline";
    for (const p of paths) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip-link";
      chip.title = p;
      const base = String(p).split(/[/\\]/).pop() || p;
      chip.textContent = base;
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "open_file", path: p });
      });
      chips.appendChild(chip);
    }
    row.appendChild(chips);
  }
  if (typeof text === "string" && text.length > 0) {
    const textEl = document.createElement("div");
    textEl.className = "message-text";
    textEl.textContent = text;
    row.appendChild(textEl);
  }
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return row;
}

