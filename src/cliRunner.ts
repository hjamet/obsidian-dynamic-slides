/**
 * cliRunner.ts — Direct CLI invocation for SlideFlow review payloads (e.g. `agy`).
 *
 * - Quote-aware tokenization BEFORE substituting `{{COMMENTS}}`, spawning with `shell: false`
 *   so multiline XML, `< >`, quotes, backticks, and `$` are delivered 100% verbatim.
 * - Automatically prevents duplicate `/one-shot` prefix when the command template already includes it.
 * - Automatically spills huge payloads (> 24,000 chars on Windows) to a job XML file on disk so
 *   Windows' 32,767-char `CreateProcessW` limit can never reject large review batches!
 * - Streams live stdout/stderr to a per-job log file and exposes `onSpawn(pid)` for real-time tracking.
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

export interface CliRunOptions {
	cwd: string;
	jobsDir?: string;
	jobId?: string;
	onSpawn?: (pid: number | null) => void;
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	displayName: string;
	logPath: string | null;
}

export function templateIncludesOneShot(template: string): boolean {
	return /\/one-shot\b/i.test(template || "");
}

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
	if (executable.includes("/") || executable.includes("\\")) {
		if (!fs.existsSync(executable)) {
			throw new Error(`CLI executable not found: ${executable}`);
		}
		return executable;
	}

	if (process.platform === "win32") {
		const lower = executable.toLowerCase();
		const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
		const extensions =
			lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")
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
	options: CliRunOptions
): Promise<CliRunResult> {
	let effectivePayload = commentsPayload;
	let spilledPayloadFile: string | null = null;

	// Avoid hitting Windows' 32,767-char CreateProcessW command-line cap on large batches
	const initialParsed = parseCommandTemplate(template, commentsPayload);
	const estimatedCmdLen =
		initialParsed.executable.length +
		initialParsed.args.reduce((sum, a) => sum + a.length + 3, 0);

	if (process.platform === "win32" && estimatedCmdLen > 24000) {
		const spillDir = options.jobsDir || os.tmpdir();
		if (!fs.existsSync(spillDir)) {
			fs.mkdirSync(spillDir, { recursive: true });
		}
		const jobTag = options.jobId || `job_${Date.now()}`;
		spilledPayloadFile = path.join(spillDir, `${jobTag}_payload.xml`);
		fs.writeFileSync(spilledPayloadFile, commentsPayload, "utf8");
		const hasPrefix = templateIncludesOneShot(template);
		effectivePayload = `${hasPrefix ? "" : "/one-shot\n\n"}Read and execute all SlideFlow review comments stored in this XML file: ${spilledPayloadFile}`;
	}

	const parsed = parseCommandTemplate(template, effectivePayload);
	const resolvedExe = resolveExecutablePath(parsed.executable);

	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedExe)) {
		throw new Error(
			`Batch scripts (${path.basename(resolvedExe)}) cannot safely receive multiline XML arguments on Windows. Point directly to the .exe binary instead.`
		);
	}

	let logPath: string | null = null;
	let logStream: fs.WriteStream | null = null;
	if (options.jobsDir && options.jobId) {
		try {
			if (!fs.existsSync(options.jobsDir)) {
				fs.mkdirSync(options.jobsDir, { recursive: true });
			}
			logPath = path.join(options.jobsDir, `${options.jobId}.log`);
			logStream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
			logStream.write(
				`[${new Date().toISOString()}] Launching: ${resolvedExe} (payload=${commentsPayload.length} chars${spilledPayloadFile ? `, file=${spilledPayloadFile}` : ""})\n`
			);
		} catch {
			logPath = null;
			logStream = null;
		}
	}

	return new Promise<CliRunResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn(resolvedExe, parsed.args, {
			cwd: options.cwd || undefined,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		options.onSpawn?.(child.pid ?? null);
		if (logStream && child.pid) {
			logStream.write(`[${new Date().toISOString()}] PID=${child.pid}\n`);
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout += text;
			logStream?.write(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr += text;
			logStream?.write(`[stderr] ${text}`);
		});

		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			logStream?.write(`\n[ERROR] ${err.message}\n`);
			logStream?.end();
			reject(new Error(`Failed to start ${parsed.displayName}: ${err.message}`));
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			logStream?.write(`\n[${new Date().toISOString()}] Exit code=${code}, signal=${signal || "none"}\n`);
			logStream?.end();

			if (code === 0 && spilledPayloadFile) {
				try {
					fs.unlinkSync(spilledPayloadFile);
				} catch {
					// ignore temp file cleanup errors
				}
			}

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
				logPath,
			});
		});
	});
}
