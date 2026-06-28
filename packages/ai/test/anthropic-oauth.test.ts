import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.js";

/** Simulate the browser redirect hitting the local callback server. */
function hitCallback(authUrl: string, code: string, host = "127.0.0.1"): void {
	const state = new URL(authUrl).searchParams.get("state") ?? "";
	const req = http.get(
		{ host, port: 53692, path: `/callback?code=${code}&state=${encodeURIComponent(state)}` },
		(res) => {
			res.resume();
		},
	);
	req.on("error", () => {});
}

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) {
					throw new Error("Missing OAuth state or redirect_uri in auth URL");
				}
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("completes via the browser callback even when the manual prompt is cancelled", async () => {
		// Reproduces the plugin/FreeCodeMac bug: the manual-paste prompt is resolved
		// non-blockingly (here, cancelled), and the browser redirect arrives shortly
		// after. The callback server must stay open so login still completes.
		let authUrl = "";
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			const body = getJsonBody(init);
			expect(body.code).toBe("browser-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
				// Browser redirect lands after the manual prompt was already cancelled.
				setTimeout(() => hitCallback(authUrl, "browser-code"), 25);
			},
			onPrompt: async () => {
				throw new Error("onPrompt should not be reached when the callback succeeds");
			},
			onManualCodeInput: async () => {
				throw new Error("user cancelled the manual prompt");
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("falls back to onPrompt when the callback port is unavailable", async () => {
		// Sibling instance holds 53692 on both stacks -> our login binds nothing and
		// must rely on the manual paste / onPrompt path instead of aborting.
		const blockers = await Promise.all(
			["127.0.0.1", "::1"].map(
				(host) =>
					new Promise<http.Server | null>((resolve) => {
						const s = http.createServer(() => {});
						s.on("error", () => resolve(null));
						s.listen(53692, host, () => resolve(s));
					}),
			),
		);

		try {
			const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
				const body = getJsonBody(init);
				expect(body.code).toBe("prompt-code");
				return jsonResponse({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			});
			vi.stubGlobal("fetch", fetchMock);

			let authUrl = "";
			const credentials = await loginAnthropic({
				onAuth: (info) => {
					authUrl = info.url;
				},
				onPrompt: async () => {
					const state = new URL(authUrl).searchParams.get("state");
					return `http://localhost:53692/callback?code=prompt-code&state=${state}`;
				},
				onManualCodeInput: async () => {
					throw new Error("user cancelled the manual prompt");
				},
			});

			expect(credentials.access).toBe("access-token");
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			for (const s of blockers) s?.close();
		}
	});

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicToken("refresh-token");

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
