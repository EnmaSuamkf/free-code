/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type CallbackServerInfo = {
	/** Bound loopback listeners (IPv4 and/or IPv6). Empty when the port is unavailable. */
	servers: Server[];
	/** True when at least one listener bound; false means manual-paste-only. */
	available: boolean;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	close: () => void;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Bind both loopback stacks: `localhost` resolves to 127.0.0.1 AND ::1 on most
// machines (see /etc/hosts), and browsers may pick IPv6 first. Listening only on
// IPv4 made the redirect intermittently fail with ERR_CONNECTION_REFUSED.
const CALLBACK_HOSTS = ["127.0.0.1", "::1"];
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function startCallbackServer(expectedState: string, signal?: AbortSignal): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolveWait(value);
		};
	});

	// Let the caller abort the wait (e.g. user cancels the whole login).
	if (signal) {
		if (signal.aborted) settleWait?.(null);
		else signal.addEventListener("abort", () => settleWait?.(null), { once: true });
	}

	const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
				return;
			}

			if (!code || !state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing code or state parameter."));
				return;
			}

			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
			settleWait?.({ code, state });
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Internal error");
		}
	};

	const servers: Server[] = [];

	// Best-effort bind per loopback host. A failure on one host (IPv6 disabled, or
	// the port already taken by a sibling instance) must NOT abort the login — we
	// fall back to whichever listener bound, or to manual paste if none did.
	const listenOn = (host: string) =>
		new Promise<boolean>((resolve) => {
			const server = createServer(handleRequest);
			let bound = false;
			server.on("error", () => {
				if (!bound) {
					try {
						server.close();
					} catch {}
					resolve(false);
				}
			});
			server.listen(CALLBACK_PORT, host, () => {
				bound = true;
				servers.push(server);
				resolve(true);
			});
		});

	const results = await Promise.all(CALLBACK_HOSTS.map(listenOn));
	const available = results.some(Boolean);

	return {
		servers,
		available,
		redirectUri: REDIRECT_URI,
		cancelWait: () => settleWait?.(null),
		waitForCode: () => waitForCodePromise,
		close: () => {
			for (const server of servers) {
				try {
					server.close();
				} catch {}
			}
		},
	};
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer(verifier, options.signal);

	let code: string | undefined;
	let state: string | undefined;
	let redirectUriForExchange = REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			// Manual paste runs concurrently with the callback wait. Crucially, a
			// cancelled/closed prompt must NOT tear down the callback server — GUI
			// hosts (plugin / FreeCodeMac) often resolve this prompt non-blockingly,
			// and closing the server here caused the browser redirect to land on a
			// dead port (ERR_CONNECTION_REFUSED). Only a real paste short-circuits
			// the wait; otherwise we keep listening for the browser callback.
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch(() => {
					// Prompt cancelled/closed: keep waiting on the callback server.
					// If no server is listening, stop waiting so we can prompt again.
					if (!server.available) server.cancelWait();
				});

			const result = server.available ? await server.waitForCode() : null;

			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			} else {
				// Either a code was pasted, or no callback server is listening.
				await manualPromise;
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
					state = parsed.state ?? verifier;
				}
			}
		} else if (server.available) {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: REDIRECT_URI,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== verifier) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		if (!state) {
			throw new Error("Missing OAuth state");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		return exchangeAuthorizationCode(code, state, verifier, redirectUriForExchange);
	} finally {
		server.close();
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
