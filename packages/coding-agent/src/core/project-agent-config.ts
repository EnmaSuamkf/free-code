/**
 * Project-specific agent configuration loader.
 *
 * Looks for CLAUDE.md or AGENT.md in the project root and loads them
 * as the primary agent instructions, taking precedence over global AGENTS.md.
 *
 * Priority:
 * 1. CLAUDE.md (in project root)
 * 2. AGENT.md (in project root)
 * 3. None (falls back to global AGENTS.md)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectAgentConfig {
	/** The loaded configuration content */
	content: string;
	/** Which file was used: 'CLAUDE.md' or 'AGENT.md' */
	source: "CLAUDE.md" | "AGENT.md";
	/** Absolute path to the file */
	path: string;
}

/**
 * Try to load project-specific agent configuration.
 * Returns the configuration if found, otherwise returns null.
 *
 * @param cwd - Current working directory (project root)
 * @returns ProjectAgentConfig if found, null otherwise
 */
export function loadProjectAgentConfig(cwd: string): ProjectAgentConfig | null {
	// Try CLAUDE.md first (highest priority)
	const claudePath = join(cwd, "CLAUDE.md");
	if (existsSync(claudePath)) {
		try {
			const content = readFileSync(claudePath, "utf-8");
			return {
				content,
				source: "CLAUDE.md",
				path: claudePath,
			};
		} catch (err) {
			console.error(`Failed to read ${claudePath}:`, err);
			return null;
		}
	}

	// Try AGENT.md second
	const agentPath = join(cwd, "AGENT.md");
	if (existsSync(agentPath)) {
		try {
			const content = readFileSync(agentPath, "utf-8");
			return {
				content,
				source: "AGENT.md",
				path: agentPath,
			};
		} catch (err) {
			console.error(`Failed to read ${agentPath}:`, err);
			return null;
		}
	}

	return null;
}

/**
 * Merge project-specific configuration with global agent instructions.
 * Project config takes precedence and is prepended to the global rules.
 *
 * @param projectConfig - Project-specific configuration to prepend
 * @param globalAgentRules - Global AGENTS.md content
 * @returns Combined configuration with project rules first
 */
export function mergeAgentConfig(projectConfig: ProjectAgentConfig, globalAgentRules: string): string {
	return `# Project-Specific Agent Configuration
(Loaded from ${projectConfig.source} in project root)

${projectConfig.content}

---

${globalAgentRules}`;
}
