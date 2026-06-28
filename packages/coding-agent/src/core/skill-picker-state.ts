/**
 * Skill picker snapshot for RPC / VS Code (same semantics as default-extensions/resource-picker `/pick-skill`).
 */

export interface ParsedSkillBlock {
	name: string;
	description: string;
	fullBlock: string;
}

function estimateCharsAsTokens(charCount: number): number {
	return Math.max(0, Math.ceil(charCount / 4));
}

/**
 * Parse `<skill>...</skill>` blocks from the merged system prompt (name + description + full XML).
 */
export function parseSkillBlocks(systemPrompt: string): ParsedSkillBlock[] {
	const results: ParsedSkillBlock[] = [];
	const blockRe = /<skill>([\s\S]*?)<\/skill>/g;
	let m: RegExpExecArray | null;
	while (true) {
		m = blockRe.exec(systemPrompt);
		if (m === null) break;
		const inner = m[1];
		const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
		const descMatch = inner.match(/<description>([\s\S]*?)<\/description>/);
		const name = nameMatch?.[1]?.trim() ?? "";
		if (!name) continue;
		const description = descMatch?.[1]?.trim() ?? "";
		results.push({ name, description, fullBlock: m[0] });
	}
	return results;
}

export function estimateSkillBlockTokens(fullSkillXml: string): number {
	return estimateCharsAsTokens(fullSkillXml.length);
}

export interface SkillPickerSnapshotRow {
	name: string;
	description: string;
	tokensEstimated: number;
	enabled: boolean;
}

/**
 * Build pick-skill rows: `enabled` means the skill block is included (not in `hiddenSkillNames`).
 */
export function getSkillPickerSnapshot(
	systemPrompt: string,
	hiddenSkillNames: Set<string> | undefined,
): SkillPickerSnapshotRow[] {
	const parsed = parseSkillBlocks(systemPrompt);
	return parsed.map((s) => ({
		name: s.name,
		description: s.description,
		tokensEstimated: estimateSkillBlockTokens(s.fullBlock),
		enabled: !hiddenSkillNames?.has(s.name),
	}));
}
