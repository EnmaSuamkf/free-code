function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const SVG_CHECK = `<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="26" cy="26" r="23"/>
  <polyline points="14,27 22,35 38,18"/>
</svg>`;

const SVG_ERROR = `<svg viewBox="0 0 52 52" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true">
  <circle cx="26" cy="26" r="23"/>
  <line x1="17" y1="17" x2="35" y2="35"/>
  <line x1="35" y1="17" x2="17" y2="35"/>
</svg>`;

function renderPage(options: {
	title: string;
	heading: string;
	message: string;
	details?: string;
	variant: "success" | "error";
}): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	const isSuccess = options.variant === "success";
	const icon = isSuccess ? SVG_CHECK : SVG_ERROR;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #1a1a1a;
      --text: #e0e0e0;
      --text-muted: #909090;
      --text-heading: #e8e8e8;
      --accent: #5a9e6f;
      --accent-light: #7cc495;
      --error: #c74e39;
      --error-light: #e07060;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.06);
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: "SF Mono", Menlo, Monaco, "Courier New", monospace;
      --icon-color: ${isSuccess ? "var(--accent)" : "var(--error)"};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { color-scheme: dark; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
    }
    .card {
      width: 100%;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
      padding: 44px 36px 40px;
      border-radius: 12px;
      background: var(--card-bg);
      border: 1px solid ${isSuccess ? "rgba(90,158,111,0.2)" : "rgba(196,78,57,0.25)"};
      box-shadow: 0 0 0 1px ${isSuccess ? "rgba(90,158,111,0.06)" : "rgba(196,78,57,0.08)"} inset;
      opacity: 0;
      transform: translateY(14px);
      animation: fadeUp 0.7s ease forwards;
    }
    .logo {
      font-size: 38px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1;
      user-select: none;
    }
    .logo-code {
      color: var(--accent);
      font-weight: 300;
    }
    .icon {
      width: 56px;
      height: 56px;
      color: var(--icon-color);
      opacity: 0;
      transform: scale(0.7);
      animation: iconIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.35s forwards;
    }
    h1 {
      font-size: 20px;
      font-weight: 650;
      line-height: 1.2;
      color: var(--text-heading);
      text-align: center;
    }
    p {
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--text-muted);
      text-align: center;
      max-width: 32em;
    }
    .details {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-muted);
      white-space: pre-wrap;
      word-break: break-word;
      text-align: left;
      width: 100%;
      padding: 12px 14px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    @keyframes fadeUp {
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes iconIn {
      to { opacity: 1; transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card, .icon {
        animation: none;
        opacity: 1;
        transform: none;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">free<span class="logo-code">code</span></div>
    <div class="icon">${icon}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </div>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "free-code — Signed in",
		heading: "Authentication successful",
		message,
		variant: "success",
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "free-code — Sign-in failed",
		heading: "Authentication failed",
		message,
		details,
		variant: "error",
	});
}
