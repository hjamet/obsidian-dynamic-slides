/**
 * cliRunner.ts — Direct CLI invocation for SlideFlow review payloads (e.g. `agy`).
 *
 * Uses quote-aware tokenization BEFORE substituting `{{COMMENTS}}` and spawns the
 * binary directly via `child_process.spawn(..., { shell: false })`, so multiline XML,
 * angle brackets `< >`, quotes `"`, backticks, and `$` in note content are delivered
 * 100% verbatim without shell parsing or escaping corruption on Windows/macOS/Linux.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const COMMENTS_PLACEHOLDER = "{{COMMENTS}}";
export const DEFAULT_CLI_COMMAND =
	'agy -remote-control -model "Gemini 4 Neon (XHigh)" -p "{{COMMENTS}}"';

export interface ParsedCliCommand {
	executable: string;
	args: string[];
	displayName: string;
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	displayName: string;
}

/**
 * Splits a shell-style command template into argv tokens while respecting single
 * and double quotes, BEFORE injecting `{{COMMENTS}}`.
 */
export function tokenizeCommandTemplate(template: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasToken = false;

	for (let i = 0; i < template.length; i++) {
		const ch = template[i];

		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < template.length && template[i + 1] === '"') {
				current += '"';
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			hasToken = true;
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			hasToken = true;
			continue;
		}

		if (/\s/.test(ch)) {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}

		current += ch;
		hasToken = true;
	}

	if (quote !== null) {
		throw new Error("CLI command template has an unclosed quote.");
	}

	if (hasToken) {
		tokens.push(current);
	}

	return tokens;
}

export function getCliDisplayName(template: string): string {
	try {
		const tokens = tokenizeCommandTemplate((template || "").trim());
		if (tokens.length === 0) return "CLI";
		const base = path.basename(tokens[0]).replace(/\.(exe|cmd|bat)$/i, "");
		return base || "CLI";
	} catch {
		return "CLI";
	}
}

export function parseCommandTemplate(template: string, commentsPayload: string): ParsedCliCommand {
	const trimmed = (template || "").trim();
	if (!trimmed) {
		throw new Error("CLI command template is empty. Configure it in SlideFlow settings.");
	}
	if (!trimmed.includes(COMMENTS_PLACEHOLDER)) {
		throw new Error(
			`CLI command template must include the ${COMMENTS_PLACEHOLDER} placeholder.`
		);
	}

	const rawTokens = tokenizeCommandTemplate(trimmed);
	if (rawTokens.length === 0) {
		throw new Error("CLI command template could not be parsed.");
	}

	const executable = rawTokens[0];
	const args = rawTokens.slice(1).map((tok) => tok.split(COMMENTS_PLACEHOLDER).join(commentsPayload));
	const displayName = path.basename(executable).replace(/\.(exe|cmd|bat)$/i, "") || executable;

	return { executable, args, displayName };
}

function resolveExecutablePath(executable: string): string {
	// Explicit path provided
	if (executable.includes("/") || executable.includes("\\")) {
		if (!fs.existsSync(executable)) {
			throw new Error(`CLI executable not found: ${executable}`);
		}
		return executable;
	}

	if (process.platform === "win32") {
		const lower = executable.toLowerCase();
		const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
		const extensions = lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")
			? [""]
			: [".exe", ".cmd", ".bat", ""];

		for (const dir of pathEntries) {
			for (const ext of extensions) {
				const candidate = path.join(dir, `${executable}${ext}`);
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					return candidate;
				}
			}
		}

		// Known fallback paths for Antigravity CLI (`agy`) when Obsidian's Electron PATH lacks LOCALAPPDATA\agy\bin
		if (lower === "agy" || lower === "agy.exe") {
			const localAppData = process.env.LOCALAPPDATA || "";
			const home = os.homedir();
			const candidates = [
				localAppData ? path.join(localAppData, "agy", "bin", "agy.exe") : "",
				path.join(home, "AppData", "Local", "agy", "bin", "agy.exe"),
				"C:\\Users\\hjamet\\AppData\\Local\\agy\\bin\\agy.exe",
				"C:\\Users\\Jamet\\AppData\\Local\\agy\\bin\\agy.exe",
			].filter(Boolean);

			for (const cand of candidates) {
				if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
					return cand;
				}
			}

			throw new Error(
				"Executable `agy.exe` not found in PATH or %LOCALAPPDATA%\\agy\\bin\\agy.exe."
			);
		}
	}

	return executable;
}

export function runCliCommand(
	template: string,
	commentsPayload: string,
	cwd: string
): Promise<CliRunResult> {
	const parsed = parseCommandTemplate(template, commentsPayload);
	const resolvedExe = resolveExecutablePath(parsed.executable);

	if (process.platform === "win32") {
		if (/\.(cmd|bat)$/i.test(resolvedExe)) {
			throw new Error(
				`Batch scripts (${path.basename(resolvedExe)}) cannot safely receive multiline XML arguments on Windows. Point directly to the .exe binary instead.`
			);
		}
		const estimatedCmdLen =
			resolvedExe.length + parsed.args.reduce((sum, a) => sum + a.length + 3, 0);
		if (estimatedCmdLen > 31500) {
			throw new Error(
				`Payload too large for Windows command line (${estimatedCmdLen} chars > 31,500 limit). Split into smaller comment batches.`
			);
		}
	}

	return new Promise<CliRunResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn(resolvedExe, parsed.args, {
			cwd: cwd || undefined,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			reject(new Error(`Failed to start ${parsed.displayName}: ${err.message}`));
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			if (code === null) {
				reject(
					new Error(
						`${parsed.displayName} terminated unexpectedly (signal: ${signal || "unknown"}).`
					)
				);
				return;
			}
			resolve({
				exitCode: code,
				stdout,
				stderr,
				displayName: parsed.displayName,
			});
		});
	});
}
