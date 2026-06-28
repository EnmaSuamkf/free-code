(function () {
  var storageKey = "free-code-doc-color-theme";
  var legacyStorageKey = "edo-doc-color-theme";
  var order = ["system", "light", "dark"];

  function getStored() {
    try {
      var value = localStorage.getItem(storageKey);
      if (value) return value;
      var legacyValue = localStorage.getItem(legacyStorageKey);
      if (legacyValue) localStorage.setItem(storageKey, legacyValue);
      return legacyValue;
    } catch (e) { return null; }
  }
  function setStored(value) {
    try { localStorage.setItem(storageKey, value); } catch (e) { /* ignore */ }
  }
  function applyTheme(mode) {
    var el = document.documentElement;
    if (mode === "light" || mode === "dark") {
      el.setAttribute("data-color-scheme", mode);
    } else {
      el.removeAttribute("data-color-scheme");
    }
  }
  function labelFor(mode) {
    if (mode === "light") return "Light";
    if (mode === "dark") return "Dark";
    return "System";
  }
  function init() {
    var stored = getStored();
    var mode = order.indexOf(stored) >= 0 ? stored : "system";
    applyTheme(mode);
    var btn = document.getElementById("doc-theme-toggle");
    var labelEl = document.getElementById("doc-theme-label");
    if (labelEl) labelEl.textContent = labelFor(mode);
    if (!btn) return;
    btn.setAttribute("title", "Color theme: " + labelFor(mode) + ". Cycles light, dark, and system default.");
    btn.setAttribute("aria-label", "Color theme: " + labelFor(mode));
    btn.addEventListener("click", function () {
      var i = order.indexOf(mode);
      mode = order[(i + 1) % order.length];
      setStored(mode);
      applyTheme(mode);
      if (labelEl) labelEl.textContent = labelFor(mode);
      btn.setAttribute("title", "Color theme: " + labelFor(mode) + ". Cycles light, dark, and system default.");
      btn.setAttribute("aria-label", "Color theme: " + labelFor(mode));
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
