// === MODULE: questionnaire ===
// Render inline questionnaire cards with tab strip, radio options, and free-text input.

/**
 * Render an inline questionnaire card inside the chat. The card collects
 * answers locally and posts a single `questionnaire_response` back to the
 * extension when the user submits or cancels. Mirrors the bundled TUI tool's
 * UX: option list per question, a "Type something" free-text escape hatch,
 * and a tab strip + submit step when there are multiple questions.
 *
 * @param {string} requestId
 * @param {Array<{ id: string, prompt: string, options: Array<{ value: string, label: string, description?: string }>, label?: string, allowOther?: boolean }>} questions
 */
function renderQuestionnaireCard(requestId, questions) {
  const isMulti = questions.length > 1;
  /** @type {Map<string, { value: string, label: string, wasCustom: boolean, index?: number }>} */
  const answers = new Map();
  let activeIndex = 0;
  let submitted = false;

  const card = document.createElement("section");
  card.className = "message questionnaire-card";
  card.dataset.requestId = requestId;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Questionnaire");

  const header = document.createElement("header");
  header.className = "questionnaire-header";
  const title = document.createElement("strong");
  title.textContent = isMulti
    ? `Questionnaire — ${questions.length} questions`
    : "Question";
  header.appendChild(title);
  card.appendChild(header);

  let tabStrip = null;
  if (isMulti) {
    tabStrip = document.createElement("nav");
    tabStrip.className = "questionnaire-tabs";
    tabStrip.setAttribute("role", "tablist");
    card.appendChild(tabStrip);
  }

  const body = document.createElement("div");
  body.className = "questionnaire-body";
  card.appendChild(body);

  const footer = document.createElement("footer");
  footer.className = "questionnaire-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "questionnaire-btn questionnaire-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => sendResponse(true));
  footer.appendChild(cancelBtn);

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "questionnaire-btn questionnaire-submit";
  submitBtn.textContent = isMulti ? "Submit answers" : "Submit";
  submitBtn.addEventListener("click", () => sendResponse(false));
  footer.appendChild(submitBtn);

  card.appendChild(footer);
  messagesEl.appendChild(card);
  scrollMessagesAfterContentChange();

  render();

  function sendResponse(cancelled) {
    if (submitted) return;
    if (!cancelled && !allAnswered()) {
      // Highlight the first unanswered question to nudge the user.
      const firstUnanswered = questions.findIndex((q) => !answers.has(q.id));
      if (firstUnanswered >= 0) {
        activeIndex = firstUnanswered;
        render();
      }
      return;
    }
    submitted = true;
    card.classList.add("questionnaire-disabled");
    // Disable inputs after submission so the user can't change answers post-hoc.
    for (const input of card.querySelectorAll("input, button")) {
      /** @type {HTMLInputElement | HTMLButtonElement} */ (input).disabled =
        true;
    }
    const summary = document.createElement("p");
    summary.className = "questionnaire-summary";
    if (cancelled) {
      summary.textContent = "Cancelled";
    } else {
      const lines = questions.map((q) => {
        const a = answers.get(q.id);
        if (!a) return `${q.label || q.id}: —`;
        return a.wasCustom
          ? `${q.label || q.id}: (wrote) ${a.label}`
          : `${q.label || q.id}: ${a.index ? `${a.index}. ` : ""}${a.label}`;
      });
      summary.textContent = lines.join("\n");
    }
    card.replaceChild(summary, footer);
    vscode.postMessage(
      cancelled
        ? { type: "questionnaire_response", requestId, cancelled: true }
        : {
            type: "questionnaire_response",
            requestId,
            cancelled: false,
            answers: Array.from(answers.entries()).map(([id, a]) => ({
              id,
              value: a.value,
              label: a.label,
              wasCustom: a.wasCustom,
              index: a.index,
            })),
          },
    );
  }

  function allAnswered() {
    return questions.every((q) => answers.has(q.id));
  }

  function render() {
    if (tabStrip) renderTabs();
    renderBody();
    submitBtn.disabled = !allAnswered();
  }

  function renderTabs() {
    if (!tabStrip) return;
    tabStrip.replaceChildren();
    questions.forEach((q, idx) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "questionnaire-tab";
      tab.setAttribute("role", "tab");
      if (idx === activeIndex) tab.classList.add("active");
      if (answers.has(q.id)) tab.classList.add("answered");
      const marker = document.createElement("span");
      marker.className = "questionnaire-tab-marker";
      marker.textContent = answers.has(q.id) ? "■" : "□";
      tab.appendChild(marker);
      tab.appendChild(document.createTextNode(` ${q.label || `Q${idx + 1}`}`));
      tab.addEventListener("click", () => {
        activeIndex = idx;
        render();
      });
      tabStrip.appendChild(tab);
    });
  }

  function renderBody() {
    body.replaceChildren();
    const q = questions[activeIndex];
    if (!q) return;
    const prompt = document.createElement("p");
    prompt.className = "questionnaire-prompt";
    prompt.textContent = q.prompt;
    body.appendChild(prompt);

    const list = document.createElement("div");
    list.className = "questionnaire-options";
    list.setAttribute("role", "radiogroup");
    body.appendChild(list);

    const groupName = `q-${requestId}-${q.id}`;
    const current = answers.get(q.id);

    q.options.forEach((opt, idx) => {
      const optionId = `${groupName}-opt-${idx}`;
      const wrapper = document.createElement("label");
      wrapper.className = "questionnaire-option";
      wrapper.setAttribute("for", optionId);

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.id = optionId;
      radio.value = opt.value;
      radio.checked =
        !!current && !current.wasCustom && current.index === idx + 1;
      radio.addEventListener("change", () => {
        answers.set(q.id, {
          value: opt.value,
          label: opt.label,
          wasCustom: false,
          index: idx + 1,
        });
        if (isMulti && activeIndex < questions.length - 1) {
          activeIndex += 1;
        }
        render();
      });
      wrapper.appendChild(radio);

      const label = document.createElement("span");
      label.className = "questionnaire-option-label";
      label.textContent = `${idx + 1}. ${opt.label}`;
      wrapper.appendChild(label);

      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "questionnaire-option-desc";
        desc.textContent = opt.description;
        wrapper.appendChild(desc);
      }

      list.appendChild(wrapper);
    });

    if (q.allowOther !== false) {
      const otherWrapper = document.createElement("label");
      otherWrapper.className =
        "questionnaire-option questionnaire-option-other";
      const otherId = `${groupName}-other`;
      otherWrapper.setAttribute("for", otherId);

      const otherRadio = document.createElement("input");
      otherRadio.type = "radio";
      otherRadio.name = groupName;
      otherRadio.id = otherId;
      otherRadio.value = "__other__";
      otherRadio.checked = !!current && current.wasCustom;
      otherWrapper.appendChild(otherRadio);

      const label = document.createElement("span");
      label.className = "questionnaire-option-label";
      label.textContent = "Type something.";
      otherWrapper.appendChild(label);

      const textarea = document.createElement("textarea");
      textarea.className = "questionnaire-other-input";
      textarea.rows = 2;
      textarea.placeholder = "Your answer…";
      textarea.value = current && current.wasCustom ? current.value : "";
      otherRadio.addEventListener("change", () => {
        if (otherRadio.checked) {
          textarea.focus();
          updateOtherAnswer();
        }
      });
      textarea.addEventListener("input", () => {
        if (!otherRadio.checked) otherRadio.checked = true;
        updateOtherAnswer();
      });
      otherWrapper.appendChild(textarea);

      list.appendChild(otherWrapper);

      function updateOtherAnswer() {
        const trimmed = textarea.value.trim();
        if (trimmed.length === 0) {
          answers.delete(q.id);
        } else {
          answers.set(q.id, {
            value: trimmed,
            label: trimmed,
            wasCustom: true,
          });
        }
        submitBtn.disabled = !allAnswered();
        if (tabStrip) renderTabs();
      }
    }
  }
}

