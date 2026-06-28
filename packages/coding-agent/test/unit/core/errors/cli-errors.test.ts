import { describe, expect, it } from "vitest";
import {
	AuthenticationError,
	CliError,
	ExportError,
	ExtensionLoadError,
	InvalidArgumentsError,
	MissingApiKeyError,
	ModelResolutionError,
	RagServerError,
	SessionCwdError,
	SessionNotFoundError,
} from "../../../../src/core/errors/cli-errors.js";

describe("CLI Error System", () => {
	describe("CliError (Base Class)", () => {
		it("should construct with code, message, and context", () => {
			const err = new CliError("TEST_CODE", "Test message", { key: "value" });
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(CliError);
			expect(err.name).toBe("CliError");
			expect(err.code).toBe("TEST_CODE");
			expect(err.message).toBe("Test message");
			expect(err.context).toEqual({ key: "value" });
		});

		it("should construct without context", () => {
			const err = new CliError("TEST_CODE", "Test message");
			expect(err.context).toBeUndefined();
		});
	});

	describe("SessionNotFoundError", () => {
		it("should have correct code and context", () => {
			const err = new SessionNotFoundError("abc-123");
			expect(err).toBeInstanceOf(SessionNotFoundError);
			expect(err).toBeInstanceOf(CliError);
			expect(err.code).toBe("SESSION_NOT_FOUND");
			expect(err.message).toContain("abc-123");
			expect(err.context).toEqual({ sessionId: "abc-123" });
		});
	});

	describe("ModelResolutionError", () => {
		it("should have correct code and context", () => {
			const err = new ModelResolutionError("claude-*", "No models match pattern");
			expect(err).toBeInstanceOf(ModelResolutionError);
			expect(err).toBeInstanceOf(CliError);
			expect(err.code).toBe("MODEL_RESOLUTION_FAILED");
			expect(err.message).toContain("claude-*");
			expect(err.message).toContain("No models match pattern");
			expect(err.context).toEqual({ pattern: "claude-*", reason: "No models match pattern" });
		});
	});

	describe("MissingApiKeyError", () => {
		it("should have correct code and context", () => {
			const err = new MissingApiKeyError("openai");
			expect(err).toBeInstanceOf(MissingApiKeyError);
			expect(err.code).toBe("MISSING_API_KEY");
			expect(err.message).toContain("openai");
			expect(err.context).toEqual({ provider: "openai" });
		});
	});

	describe("InvalidArgumentsError", () => {
		it("should have correct code and context", () => {
			const err = new InvalidArgumentsError("Cannot combine --fork and --session", ["--fork", "--session"]);
			expect(err).toBeInstanceOf(InvalidArgumentsError);
			expect(err.code).toBe("INVALID_ARGUMENTS");
			expect(err.message).toContain("Cannot combine");
			expect(err.context).toEqual({ conflicts: ["--fork", "--session"] });
		});
	});

	describe("SessionCwdError", () => {
		it("should have correct code and context", () => {
			const err = new SessionCwdError("Directory not found", "/path/to/session.jsonl");
			expect(err).toBeInstanceOf(SessionCwdError);
			expect(err.code).toBe("SESSION_CWD_ERROR");
			expect(err.context).toEqual({ sessionFile: "/path/to/session.jsonl" });
		});
	});

	describe("AuthenticationError", () => {
		it("should generate correct message for API key", () => {
			const err = new AuthenticationError("anthropic", false);
			expect(err).toBeInstanceOf(AuthenticationError);
			expect(err.code).toBe("AUTHENTICATION_ERROR");
			expect(err.message).toContain("No API key found");
			expect(err.context).toEqual({ provider: "anthropic", isOAuth: false });
		});

		it("should generate correct message for OAuth", () => {
			const err = new AuthenticationError("google", true);
			expect(err.message).toContain("Credentials may have expired");
			expect(err.context).toEqual({ provider: "google", isOAuth: true });
		});
	});

	describe("ExtensionLoadError", () => {
		it("should have correct code and context", () => {
			const err = new ExtensionLoadError("./ext.js", "Syntax error");
			expect(err).toBeInstanceOf(ExtensionLoadError);
			expect(err.code).toBe("EXTENSION_LOAD_ERROR");
			expect(err.context).toEqual({ extensionPath: "./ext.js", reason: "Syntax error" });
		});
	});

	describe("RagServerError", () => {
		it("should have correct code and context", () => {
			const err = new RagServerError("Server timed out", "http://localhost:8085");
			expect(err).toBeInstanceOf(RagServerError);
			expect(err.code).toBe("RAG_SERVER_ERROR");
			expect(err.context).toEqual({ baseUrl: "http://localhost:8085" });
		});
	});

	describe("ExportError", () => {
		it("should have correct code and context", () => {
			const err = new ExportError("session.jsonl", "output.html", "File not writable");
			expect(err).toBeInstanceOf(ExportError);
			expect(err.code).toBe("EXPORT_ERROR");
			expect(err.context).toEqual({
				sessionFile: "session.jsonl",
				outputPath: "output.html",
				reason: "File not writable",
			});
		});
	});
});
