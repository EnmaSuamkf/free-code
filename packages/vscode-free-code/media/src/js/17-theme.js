// === MODULE: theme ===
// Light/dark theme toggle. Only active in FreeCodeMac (WKWebView) — in the
// VS Code webview the IDE controls theme variables so we hide the button.

const themeBtnEl = document.getElementById("theme-toggle");
const isFreeCodeMac = !!window.webkit?.messageHandlers?.freeCodeBridge;

if (!isFreeCodeMac) {
  // Running inside VS Code: theme is owned by the IDE, hide the button.
  if (themeBtnEl) themeBtnEl.hidden = true;
} else {
  const THEME_KEY = "free-code-theme";
  const LEGACY_THEME_KEY = "edo-theme";

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeBtnEl) {
      themeBtnEl.textContent = theme === "light" ? "☾" : "☀";
      themeBtnEl.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
      themeBtnEl.setAttribute("aria-label", themeBtnEl.title);
    }
  }

  // Restore persisted theme on load
  try {
    const saved = readMigratedLocalStorage(THEME_KEY, LEGACY_THEME_KEY);
    if (saved === "light" || saved === "dark") applyTheme(saved);
  } catch { /* ignore */ }

  themeBtnEl?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    writeLocalStorage(THEME_KEY, next);
  });
}
