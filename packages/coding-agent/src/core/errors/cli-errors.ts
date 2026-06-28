/**
 * CLI Error Handling System
 *
 * Provides typed, structured error classes for consistent error handling
 * throughout the CLI application. Each error includes:
 * - error code (for programmatic handling)
 * - human-readable message
 * - optional context (for logging/debugging)
 */

/**
 * Base class for all CLI errors
 */
export class CliError extends Error {
	constructor(
		public code: string,
		message: string,
		public context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "CliError";
		// Ensure proper prototype chain for instanceof checks
		Object.setPrototypeOf(this, CliError.prototype);
	}
}

/**
 * Session not found error
 */
export class SessionNotFoundError extends CliError {
	constructor(sessionId: string) {
		super("SESSION_NOT_FOUND", `No session found matching '${sessionId}'`, { sessionId });
		Object.setPrototypeOf(this, SessionNotFoundError.prototype);
	}
}

/**
 * Model resolution failed error
 */
export class ModelResolutionError extends CliError {
	constructor(pattern: string, reason: string) {
		super("MODEL_RESOLUTION_FAILED", `Cannot resolve model '${pattern}': ${reason}`, { pattern, reason });
		Object.setPrototypeOf(this, ModelResolutionError.prototype);
	}
}

/**
 * Missing API key error
 */
export class MissingApiKeyError extends CliError {
	constructor(provider: string) {
		super("MISSING_API_KEY", `No API key found for ${provider}. Use /login or set environment variable.`, {
			provider,
		});
		Object.setPrototypeOf(this, MissingApiKeyError.prototype);
	}
}

/**
 * Invalid command-line arguments error
 */
export class InvalidArgumentsError extends CliError {
	constructor(message: string, conflicts?: string[]) {
		super("INVALID_ARGUMENTS", message, conflicts ? { conflicts } : undefined);
		Object.setPrototypeOf(this, InvalidArgumentsError.prototype);
	}
}

/**
 * Session CWD (current working directory) mismatch error
 */
export class SessionCwdError extends CliError {
	constructor(message: string, sessionFile: string) {
		super("SESSION_CWD_ERROR", message, { sessionFile });
		Object.setPrototypeOf(this, SessionCwdError.prototype);
	}
}

/**
 * Authentication error (API key or OAuth)
 */
export class AuthenticationError extends CliError {
	constructor(provider: string, isOAuth: boolean) {
		const message = isOAuth
			? `Authentication failed for "${provider}". Credentials may have expired or network is unavailable. Run '/login ${provider}' to re-authenticate.`
			: `No API key found for ${provider}. Use /login or set an API key environment variable.`;

		super("AUTHENTICATION_ERROR", message, { provider, isOAuth });
		Object.setPrototypeOf(this, AuthenticationError.prototype);
	}
}

/**
 * Extension loading error
 */
export class ExtensionLoadError extends CliError {
	constructor(extensionPath: string, reason: string) {
		super("EXTENSION_LOAD_ERROR", `Failed to load extension "${extensionPath}": ${reason}`, {
			extensionPath,
			reason,
		});
		Object.setPrototypeOf(this, ExtensionLoadError.prototype);
	}
}

/**
 * RAG server startup error
 */
export class RagServerError extends CliError {
	constructor(message: string, baseUrl?: string) {
		super("RAG_SERVER_ERROR", message, baseUrl ? { baseUrl } : undefined);
		Object.setPrototypeOf(this, RagServerError.prototype);
	}
}

/**
 * Export operation error
 */
export class ExportError extends CliError {
	constructor(sessionFile: string, outputPath: string | undefined, reason: string) {
		super("EXPORT_ERROR", `Failed to export session: ${reason}`, { sessionFile, outputPath, reason });
		Object.setPrototypeOf(this, ExportError.prototype);
	}
}
