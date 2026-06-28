#!/usr/bin/env node
// Concatenates media/src/js/*.js and media/src/css/*.css (in numeric order)
// into media/chat.js and media/chat.css for both the VS Code extension and macOS app.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

const jsFiles = [
  "media/src/js/01-dom-refs.js",
  "media/src/js/02-state.js",
  "media/src/js/03-utils.js",
  "media/src/js/04-slash-menu.js",
  "media/src/js/05-input.js",
  "media/src/js/06-pickers.js",
  "media/src/js/07-working.js",
  "media/src/js/08-messages.js",
  "media/src/js/09-tools.js",
  "media/src/js/10-questionnaire.js",
  "media/src/js/11-tabs.js",
  "media/src/js/12-message-handler.js",
  "media/src/js/13-button-events.js",
  "media/src/js/14-indicators.js",
  "media/src/js/15-session-monitor.js",
  "media/src/js/16-events.js",
  "media/src/js/17-theme.js",
];

const cssFiles = [
  "media/src/css/01-splash.css",
  "media/src/css/02-base.css",
  "media/src/css/03-tabs.css",
  "media/src/css/04-messages.css",
  "media/src/css/05-modals.css",
  "media/src/css/06-status-queue.css",
  "media/src/css/07-queue.css",
  "media/src/css/08-input.css",
  "media/src/css/09-terminal.css",
  "media/src/css/10-session-monitor.css",
  "media/src/css/11-slash-menu.css",
  "media/src/css/12-chat-actions.css",
  "media/src/css/13-diff.css",
  "media/src/css/14-questionnaire.css",
];

function build(files, outFile) {
  const parts = files.map((f) => {
    const full = path.join(root, f);
    if (!fs.existsSync(full)) throw new Error(`Missing source file: ${full}`);
    return fs.readFileSync(full, "utf8");
  });
  const out = parts.join("\n");
  fs.writeFileSync(path.join(root, outFile), out);
  const lineCount = out.split("\n").length;
  console.log(`Built ${outFile} (${lineCount} lines) from ${files.length} modules`);
}

build(jsFiles, "media/chat.js");
build(cssFiles, "media/chat.css");
