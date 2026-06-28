/**
 * Injected before chat.js in the macOS WKWebView (Swift loads this file first).
 * Defines acquireVsCodeApi so chat.js is unchanged; messages go to native via freeCodeBridge.
 */
(function () {
  window.__freeCodeDispatchHostMessage = function (data) {
    window.dispatchEvent(new MessageEvent("message", { data: data, source: window }));
  };
  /** Called from native with base64-encoded UTF-8 JSON string. */
  window.__freeCodeInjectHostPayloadB64 = function (b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder().decode(bytes);
    window.__freeCodeDispatchHostMessage(JSON.parse(text));
  };
  globalThis.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (window.webkit?.messageHandlers?.freeCodeBridge) {
          window.webkit.messageHandlers.freeCodeBridge.postMessage(msg);
        }
      },
      setState: function () {},
      getState: function () {
        return undefined;
      },
    };
  };

  /** Splash (chat-mac.html): stagger rows, show Start, dismiss overlay. */
  function initMacSplash() {
    const splash = document.getElementById("splash");
    const dismiss = document.getElementById("splash-dismiss");
    const tagline = document.getElementById("splash-tagline");
    if (!splash || !dismiss) return;

    if (tagline) {
      const full = "there are plenty of agents… but this one is FreeCode";
      let i = 0;
      const tick = function () {
        if (i <= full.length) {
          tagline.textContent = full.slice(0, i);
          if (i < full.length) {
            tagline.appendChild(
              Object.assign(document.createElement("span"), {
                className: "splash-cursor",
              }),
            );
          }
          i++;
          window.setTimeout(tick, i < 12 ? 72 : 48);
        } else {
          dismiss.hidden = false;
        }
      };
      window.setTimeout(tick, 520);
    } else {
      dismiss.hidden = false;
    }

    window.setTimeout(function () {
      splash.querySelectorAll(".splash-feature").forEach(function (el, idx) {
        window.setTimeout(function () {
          el.classList.add("splash-visible");
        }, 110 * idx);
      });
    }, 180);

    dismiss.addEventListener("click", function () {
      splash.classList.add("splash-hiding");
      window.setTimeout(function () {
        splash.hidden = true;
      }, 480);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMacSplash);
  } else {
    initMacSplash();
  }
})();
