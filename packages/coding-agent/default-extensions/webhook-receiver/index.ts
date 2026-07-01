/**
 * webhook-receiver — inbound webhook endpoint for free-code.
 *
 * Lets external systems (Flowise, GitHub, Stripe, CI, ...) drive the agent:
 * register a named hook, point the external system at its callback URL, and
 * incoming POSTs are delivered to the session either as a queued event
 * (drained via poll/wait tools) or as a message that wakes the agent.
 *
 * MCP can't do this — an MCP server can't start an agent turn. This is an
 * extension because only the extension API exposes `sendUserMessage()` and
 * `sendMessage({ triggerTurn })`.
 *
 * Delivery modes (per hook):
 *   queue   — buffer the event; agent drains with poll_webhook_events /
 *             wait_for_webhook_event.
 *   trigger — inject a user message immediately (wakes the agent; queued as a
 *             follow-up if it is currently streaming).
 *
 * Multi-session: each session binds the first free port from config.port upward
 * (config.portRange attempts), so several free-code windows coexist without
 * clashing. Override with FREECODE_WEBHOOK_PORT or `/webhook port <n>`. The
 * callback URL always reports the port this session actually bound.
 *
 * Security: binds 127.0.0.1 by default; every hook requires a shared secret or
 * an HMAC secret. For cloud sources, front it with a tunnel (cloudflared/ngrok)
 * and set publicBaseUrl + hmacSecret.
 *
 * Config: <agentDir>/webhook-receiver.json (see ./_config.ts).
 */
import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import type { Server } from "node:http";
import { type HookMode, loadConfig, saveConfig, type WebhookConfig } from "./_config.ts";
import { EventRegistry, type WebhookEvent } from "./_registry.ts";
import { createServer } from "./_server.ts";

export default function webhookReceiver(pi: ExtensionAPI): void {
	const registry = new EventRegistry();
	let config: WebhookConfig = loadConfig();
	let server: Server | null = null;
	let boundOwner = false;
	/** Port this session actually bound (may differ from config.port after auto-fallback). */
	let boundPort: number | null = null;
	/** Explicit per-session port set via `/webhook port <n>` (skips auto-fallback). */
	let forcedPort: number | null = null;
	let currentCtx: ExtensionContext | null = null;

	const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		currentCtx?.ui.notify(`[webhook] ${message}`, type);
	};

	const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

	/** The port used in URLs: the actually-bound port when live, else the intended one. */
	function effectivePort(): number {
		return boundPort ?? forcedPort ?? config.port;
	}

	function urlsFor(name: string): { local: string; publicUrl: string | null } {
		const encoded = encodeURIComponent(name);
		const local = `http://${config.host}:${effectivePort()}/hook/${encoded}`;
		const publicUrl = config.publicBaseUrl
			? `${config.publicBaseUrl.replace(/\/$/, "")}/hook/${encoded}`
			: null;
		return { local, publicUrl };
	}

	function renderEvent(event: WebhookEvent): string {
		const bodyStr = typeof event.body === "string" ? event.body : JSON.stringify(event.body, null, 2);
		return [
			`Incoming webhook event "${event.name}" (${event.receivedAt}).`,
			"",
			"Payload:",
			"```",
			bodyStr.slice(0, 8000),
			bodyStr.length > 8000 ? "... [truncated]" : "",
			"```",
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	function handleEvent(name: string, hook: { mode: HookMode }, event: WebhookEvent): void {
		if (hook.mode === "trigger") {
			const busy = currentCtx ? !currentCtx.isIdle() : false;
			pi.sendUserMessage(renderEvent(event), busy ? { deliverAs: "followUp" } : undefined);
			notify(`'${name}' received → turn triggered${busy ? " (follow-up)" : ""}`);
		} else {
			registry.enqueue(event);
			notify(`'${name}' received → queued (${registry.size()})`);
		}
	}

	function startServer(): void {
		if (server || !config.enabled) return;
		const host = config.host;
		const basePort = forcedPort ?? config.port;
		// With an explicit port we don't scan; otherwise try base..base+portRange-1.
		const attempts = forcedPort != null ? 1 : Math.max(1, config.portRange);

		const tryListen = (attempt: number): void => {
			const port = basePort + attempt;
			const instance = createServer({
				getConfig: () => config,
				onEvent: (name, hook, event) => handleEvent(name, hook, event),
				log: (message, type) => notify(message, type),
			});
			instance.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && attempt < attempts - 1) {
					tryListen(attempt + 1); // port taken (another session?) → try the next one
					return;
				}
				if (err.code === "EADDRINUSE") {
					notify(
						`no free port in ${basePort}-${basePort + attempts - 1}; receiver inactive in this session`,
						"warning",
					);
				} else {
					notify(`server error: ${err.message}`, "error");
				}
				server = null;
				boundOwner = false;
				boundPort = null;
			});
			instance.once("listening", () => {
				server = instance;
				boundOwner = true;
				boundPort = port;
				notify(`listen on http://${host}:${port}`);
			});
			instance.listen(port, host);
		};

		tryListen(0);
	}

	/** Close the listening socket without touching the queued events. */
	function closeServer(): void {
		if (server) {
			server.close();
			server = null;
		}
		boundOwner = false;
		boundPort = null;
	}

	function stopServer(): void {
		closeServer();
		registry.clear();
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		config = loadConfig();
		startServer();
	});

	pi.on("session_shutdown", () => {
		stopServer();
	});

	// =========================================================================
	// Tools
	// =========================================================================

	const VALID_NAME = /^[A-Za-z0-9._-]+$/;

	function describeHook(name: string): string {
		const hook = config.hooks[name];
		const { local, publicUrl } = urlsFor(name);
		const lines = [
			`Webhook '${name}' (mode=${hook.mode}).`,
			`Local URL:   ${local}`,
			...(publicUrl ? [`Public URL: ${publicUrl}`] : []),
			hook.secret ? `Header:      X-Webhook-Secret: ${hook.secret}` : "",
			hook.hmacSecret ? "HMAC:        X-Signature: sha256=<hmac-sha256(hmacSecret, rawBody)>" : "",
			config.enabled && !boundOwner
				? "Warning: the server is not yet active in this session (no free port). Try /webhook port <n>."
				: "",
		];
		return lines.filter(Boolean).join("\n");
	}

	pi.registerTool({
		name: "register_webhook",
		label: "Register webhook",
		description:
			"Register a named inbound webhook and return its callback URL. mode 'trigger' wakes the agent on each event; 'queue' buffers events for poll_webhook_events/wait_for_webhook_event. A shared secret is auto-generated when neither secret nor hmacSecret is provided.",
		parameters: Type.Object({
			name: Type.String({ description: "Unique hook name; used in the URL path (chars: A-Z a-z 0-9 . _ -)." }),
			mode: Type.Optional(
				Type.Union([Type.Literal("queue"), Type.Literal("trigger")], {
					description: "Delivery mode. Defaults to the configured defaultMode.",
				}),
			),
			secret: Type.Optional(Type.String({ description: "Shared secret expected in the X-Webhook-Secret header." })),
			hmacSecret: Type.Optional(
				Type.String({ description: "Secret to verify an HMAC-SHA256 signature of the raw body (X-Signature)." }),
			),
		}),
		execute: async (_callId, args) => {
			const name = args.name.trim();
			if (!VALID_NAME.test(name)) {
				return reply(`Invalid name '${name}'. Allowed: A-Z a-z 0-9 . _ -`);
			}
			const mode: HookMode = args.mode ?? config.defaultMode;
			let secret = args.secret;
			const hmacSecret = args.hmacSecret;
			if (!secret && !hmacSecret) secret = crypto.randomBytes(24).toString("hex");
			config.hooks[name] = { mode, ...(secret ? { secret } : {}), ...(hmacSecret ? { hmacSecret } : {}) };
			saveConfig(config);
			if (!server && config.enabled) startServer();
			return reply(describeHook(name));
		},
	});

	pi.registerTool({
		name: "unregister_webhook",
		label: "Unregister webhook",
		description: "Remove a previously registered webhook.",
		parameters: Type.Object({
			name: Type.String({ description: "Hook name to remove." }),
		}),
		execute: async (_callId, args) => {
			const name = args.name.trim();
			if (!config.hooks[name]) {
				return reply(`Webhook '${name}' does not exist.`);
			}
			delete config.hooks[name];
			saveConfig(config);
			return reply(`Webhook '${name}' removed.`);
		},
	});

	pi.registerTool({
		name: "get_webhook_url",
		label: "Get webhook URL",
		description: "Return the callback URL (and auth header hint) for a registered webhook, to configure in the external system.",
		parameters: Type.Object({
			name: Type.String({ description: "Hook name." }),
		}),
		execute: async (_callId, args) => {
			const name = args.name.trim();
			if (!config.hooks[name]) {
				return reply(`Webhook '${name}' does not exist.`);
			}
			return reply(describeHook(name));
		},
	});

	pi.registerTool({
		name: "list_webhooks",
		label: "List webhooks",
		description: "List all registered webhooks with their delivery mode and queued-event counts.",
		parameters: Type.Object({}),
		execute: async () => {
			const names = Object.keys(config.hooks);
			if (names.length === 0) {
				return reply("No webhooks registered. Use register_webhook.");
			}
			const status = config.enabled ? (boundOwner ? "active" : "inactive (no free port)") : "disabled";
			const lines = names.sort().map((n) => `  - ${n} [${config.hooks[n].mode}]`);
			return reply(
				`Server: ${status} on http://${config.host}:${effectivePort()}\nQueued: ${registry.size()} event(s)\n\nWebhooks:\n${lines.join("\n")}`,
			);
		},
	});

	pi.registerTool({
		name: "poll_webhook_events",
		label: "Poll webhook events",
		description: "Return buffered webhook events (from 'queue' mode hooks). By default it drains the queue; set drain=false to peek without removing.",
		parameters: Type.Object({
			drain: Type.Optional(Type.Boolean({ description: "Remove events from the queue after reading (default true)." })),
		}),
		execute: async (_callId, args) => {
			const drain = args.drain ?? true;
			const events = drain ? registry.drain() : registry.peek();
			if (events.length === 0) {
				return reply("No events in queue.");
			}
			return reply(JSON.stringify(events, null, 2));
		},
	});

	pi.registerTool({
		name: "wait_for_webhook_event",
		label: "Wait for webhook event",
		description: "Block until the next queued webhook event arrives or the timeout elapses (long-poll). Returns the event, or a timeout notice. Use this to wait for an external system to call back.",
		parameters: Type.Object({
			timeoutSeconds: Type.Optional(
				Type.Number({ description: "Max seconds to wait (1-300, default 30).", minimum: 1, maximum: 300 }),
			),
		}),
		execute: async (_callId, args, signal) => {
			const seconds = Math.min(Math.max(args.timeoutSeconds ?? 30, 1), 300);
			const event = await registry.wait(seconds * 1000, signal);
			if (!event) {
				return reply(`No events after ${seconds}s.`);
			}
			return reply(JSON.stringify(event, null, 2));
		},
	});

	pi.registerTool({
		name: "register_external_webhook",
		label: "Register external webhook",
		description:
			"Register free-code's callback URL in an external system by calling that system's API. Provide the external registration endpoint and any body/headers; use {{url}} in the body to interpolate the local callback URL of `hookName`.",
		parameters: Type.Object({
			hookName: Type.String({ description: "Name of a webhook already created with register_webhook." }),
			apiUrl: Type.String({ description: "The external system's webhook-registration endpoint." }),
			method: Type.Optional(Type.String({ description: "HTTP method (default POST)." })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers." })),
			body: Type.Optional(Type.String({ description: "Raw request body; occurrences of {{url}} are replaced with the callback URL." })),
			usePublicUrl: Type.Optional(Type.Boolean({ description: "Interpolate the public URL instead of the local one (default false)." })),
		}),
		execute: async (_callId, args) => {
			const hook = config.hooks[args.hookName];
			if (!hook) {
				return reply(`Webhook '${args.hookName}' does not exist. Create it with register_webhook.`);
			}
			const { local, publicUrl } = urlsFor(args.hookName);
			const callbackUrl = args.usePublicUrl ? publicUrl : local;
			if (!callbackUrl) {
				return reply("No publicBaseUrl configured to build the public URL.");
			}
			const body = args.body ? args.body.replaceAll("{{url}}", callbackUrl) : undefined;
			try {
				const res = await fetch(args.apiUrl, {
					method: args.method ?? "POST",
					headers: { "content-type": "application/json", ...(args.headers ?? {}) },
					body,
				});
				const text = await res.text();
				return reply(
					`Registered at ${args.apiUrl} → ${res.status}\nCallback: ${callbackUrl}\nResponse:\n${text.slice(0, 4000)}`,
				);
			} catch (err) {
				return reply(`Error registering at ${args.apiUrl}: ${String(err)}`);
			}
		},
	});

	// =========================================================================
	// /webhook command (CLI surface)
	// =========================================================================

	const USAGE = "Usage: /webhook list | add <name> [--trigger] | rm <name> | url <name> | events | port <n>";
	const SUBCOMMANDS = ["list", "add", "rm", "url", "events", "port"];

	pi.registerCommand("webhook", {
		description:
			"Manage inbound webhooks: /webhook list | add <name> [--trigger] | rm <name> | url <name> | events | port <n>",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			const parts = p.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);

			// Still typing (or about to type) the subcommand.
			if (parts.length === 0 || (parts.length === 1 && !trailingSpace)) {
				const typed = parts[0] ?? "";
				return SUBCOMMANDS.filter((s) => s.startsWith(typed)).map((s) => ({ value: `${s} `, label: s }));
			}

			const sub = parts[0];

			// Complete an existing hook name for rm / url.
			if ((sub === "rm" || sub === "url") && (parts.length === 1 || (parts.length === 2 && !trailingSpace))) {
				const typed = trailingSpace ? "" : (parts[1] ?? "");
				return Object.keys(config.hooks)
					.filter((n) => n.startsWith(typed))
					.sort()
					.map((n) => ({ value: `${sub} ${n}`, label: n, description: config.hooks[n].mode }));
			}

			// Suggest the --trigger flag for add.
			if (sub === "add" && parts.length >= 2 && !parts.includes("--trigger")) {
				return [{ value: `${parts.join(" ")} --trigger`, label: "--trigger", description: "wake the agent on each event" }];
			}

			return null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens.shift() ?? "list";

			if (sub === "list") {
				const names = Object.keys(config.hooks);
				const status = config.enabled ? (boundOwner ? "active" : "inactive (no free port)") : "disabled";
				const body =
					names.length === 0
						? "No webhooks registered."
						: names
							.sort()
							.map((n) => `  ${n} [${config.hooks[n].mode}]`)
							.join("\n");
				ctx.ui.notify(
					`Server: ${status} on http://${config.host}:${effectivePort()}\nQueued: ${registry.size()}\n\n${body}`,
					"info",
				);
				return;
			}

			if (sub === "events") {
				const events = registry.peek();
				ctx.ui.notify(events.length === 0 ? "No events in queue." : JSON.stringify(events, null, 2), "info");
				return;
			}

			if (sub === "port") {
				const raw = tokens.shift();
				const port = Number(raw);
				if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
					ctx.ui.notify("Usage: /webhook port <1-65535>", "warning");
					return;
				}
				forcedPort = port;
				closeServer();
				startServer();
				ctx.ui.notify(`Restarting the receiver on port ${port} (this session)…`, "info");
				return;
			}

			const name = tokens.shift();
			if ((sub === "add" || sub === "rm" || sub === "url") && !name) {
				ctx.ui.notify(`Missing <name>. ${USAGE}`, "warning");
				return;
			}

			if (sub === "add" && name) {
				if (!VALID_NAME.test(name)) {
					ctx.ui.notify(`Invalid name '${name}'. Allowed: A-Z a-z 0-9 . _ -`, "warning");
					return;
				}
				const mode: HookMode = tokens.includes("--trigger") ? "trigger" : config.defaultMode;
				const secret = crypto.randomBytes(24).toString("hex");
				config.hooks[name] = { mode, secret };
				saveConfig(config);
				if (!server && config.enabled) startServer();
				ctx.ui.notify(describeHook(name), "info");
				return;
			}

			if (sub === "rm" && name) {
				if (!config.hooks[name]) {
					ctx.ui.notify(`Webhook '${name}' does not exist.`, "warning");
					return;
				}
				delete config.hooks[name];
				saveConfig(config);
				ctx.ui.notify(`Webhook '${name}' removed.`, "info");
				return;
			}

			if (sub === "url" && name) {
				if (!config.hooks[name]) {
					ctx.ui.notify(`Webhook '${name}' does not exist.`, "warning");
					return;
				}
				ctx.ui.notify(describeHook(name), "info");
				return;
			}

			ctx.ui.notify(USAGE, "warning");
		},
	});
}
