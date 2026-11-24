/**
 * cliRunner.ts — Direct CLI invocation for SlideFlow review payloads (e.g. `agy`).
 *
 * - Quote-aware tokenization BEFORE substituting `{{COMMENTS}}`, spawning with `shell: false`
 *   so multiline XML, `< >`, quotes, backticks, and `$` are delivered 100% verbatim.
 * - Automatically prevents duplicate `/one-shot` prefix when the command template already includes it.
 * - Automatically injects `--project <projectName>`, `--output-format stream-json`, and
 *   `--log-file <jobId>.agy.log` for `agy` binaries (when not already present in the template)
 *   so every run lands in the configured Antigravity project (`Obsidian`) and reports real-time
 *   `conversationId`, `projectId`, and step progress.
 * - Strips per-task `-remote-control` / `--remote-control` flags when SlideFlow's persistent
 *   `agy remote-control serve` server is active so every task shares ONE single Remote Control
 *   instance (`obsidian-<hostname>`) instead of spawning ephemeral random instances per task.
 * - Automatically spills huge payloads (> 24,000 chars on Windows) to a job XML file on disk so
 *   Windows' 32,767-char `CreateProcessW` limit can never reject large review batches.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const COMMENTS_PLACEHOLDER = "{{COMMENTS}}";
export const DEFAULT_CLI_COMMAND =
	'agy --model "Gemini 4 Neon (XHigh)" -p "/one-shot {{COMMENTS}}"';

export interface ParsedCliCommand {
	executable: string;
	args: string[];
	displayName: string;
}

export interface CliRunOptions {
	cwd: string;
	jobsDir?: string;
	jobId?: string;
	projectName?: string;
	disablePerTaskRemoteControl?: boolean;
	onSpawn?: (pid: number | null) => void;
	onConversationId?: (conversationId: string) => void;
	onProjectId?: (projectId: string) => void;
	onRemoteInstanceId?: (instanceId: string) => void;
	onStepUpdate?: (stepLabel: string, stepIndex: number) => void;
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	displayName: string;
	logPath: string | null;
	agyLogPath: string | null;
	conversationId: string | null;
	projectId: string | null;
	liveInstanceId: string | null;
	streamError: string | null;
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

export function resolveExecutablePath(executable: string): string {
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

const REMOTE_CONTROL_FLAG_RE = /^--?remote-control(?:=(?:true|false|1|0))?$/i;

/**
 * Quote-aware removal of standalone `-remote-control` / `--remote-control` tokens from an `agy`
 * command template so legacy settings never keep spawning ephemeral per-task Remote Control
 * instances alongside SlideFlow's persistent `agy remote-control serve` daemon.
 */
export function stripAgyRemoteControlFlagFromTemplate(template: string): string {
	const raw = (template || "").trim();
	if (!raw) return raw;
	if (getCliDisplayName(raw).toLowerCase() !== "agy") {
		return raw;
	}

	const parts: Array<{ text: string; isToken: boolean }> = [];
	let i = 0;
	while (i < raw.length) {
		if (/\s/.test(raw[i])) {
			const start = i;
			while (i < raw.length && /\s/.test(raw[i])) i++;
			parts.push({ text: raw.slice(start, i), isToken: false });
			continue;
		}
		const start = i;
		let quote: '"' | "'" | null = null;
		while (i < raw.length) {
			const ch = raw[i];
			if (quote) {
				if (ch === "\\" && quote === '"' && i + 1 < raw.length && raw[i + 1] === '"') {
					i += 2;
					continue;
				}
				if (ch === quote) {
					quote = null;
				}
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				i++;
				continue;
			}
			if (/\s/.test(ch)) break;
			i++;
		}
		parts.push({ text: raw.slice(start, i), isToken: true });
	}

	const kept: string[] = [];
	let skippedPrevToken = false;
	for (const part of parts) {
		if (part.isToken && REMOTE_CONTROL_FLAG_RE.test(part.text)) {
			skippedPrevToken = true;
			continue;
		}
		if (!part.isToken && skippedPrevToken) {
			skippedPrevToken = false;
			continue;
		}
		skippedPrevToken = false;
		kept.push(part.text);
	}

	return kept.join("").trim();
}

function hasCliFlag(args: string[], names: string[]): boolean {
	const lowered = names.map((n) => n.toLowerCase());
	for (const tok of args) {
		const low = tok.toLowerCase();
		for (const name of lowered) {
			if (low === name || low.startsWith(`${name}=`)) {
				return true;
			}
		}
	}
	return false;
}

function formatLiveStepLabel(stepUpdate: any): string | null {
	if (!stepUpdate || typeof stepUpdate !== "object") return null;
	const stepType = String(stepUpdate.step_type || "").toLowerCase();
	const state = String(stepUpdate.state || "").toUpperCase();
	const idx = typeof stepUpdate.step_index === "number" ? stepUpdate.step_index : null;
	const suffix = idx !== null && idx > 0 ? ` · #${idx}` : "";

	if (stepType === "tool") {
		const toolName = String(stepUpdate.tool_name || stepUpdate.tool_info?.name || "tool");
		let icon = "🔧";
		if (/read_file|view_file|list_dir|find_by_name|grep/i.test(toolName)) icon = "📖";
		else if (/edit|write|replace/i.test(toolName)) icon = "✏️";
		else if (/search_web|read_url/i.test(toolName)) icon = "🔍";
		else if (/mcp/i.test(toolName)) icon = "🔌";
		else if (/subagent/i.test(toolName)) icon = "🤖";
		return `${icon} ${toolName}${suffix}`;
	}
	if (stepType === "agent_response") {
		if (state === "ACTIVE") return `💬 Réponse en cours…${suffix}`;
		return `💭 Analyse…${suffix}`;
	}
	if (stepType === "user_input") {
		return "🚀 Prompt envoyé";
	}
	return null;
}

const LOG_REMOTE_ID_RE =
	/\[remote-control-([a-zA-Z0-9-]+)\]\s+(?:Connection status:\s+Connected|Starting V2 remote control connection)/i;
const LOG_PROJECT_ID_RE = /Conversation using project ID:\s+(\S+)/i;
const LOG_CONV_ID_RE = /Created conversation\s+([a-f0-9-]+)/i;

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

	const isAgy = parsed.displayName.toLowerCase() === "agy";
	const finalArgs =
		isAgy && options.disablePerTaskRemoteControl !== false
			? parsed.args.filter((tok) => !REMOTE_CONTROL_FLAG_RE.test(tok))
			: [...parsed.args];
	const expectLiveRemoteId =
		isAgy &&
		options.disablePerTaskRemoteControl === false &&
		hasCliFlag(finalArgs, ["-remote-control", "--remote-control"]);
	let agyLogPath: string | null = null;
	let usingStreamJson = false;

	if (isAgy) {
		const extraPrefixArgs: string[] = [];

		const projectName = (options.projectName || "").trim();
		if (projectName && !hasCliFlag(finalArgs, ["-project", "--project"])) {
			extraPrefixArgs.push("--project", projectName);
		}

		if (!hasCliFlag(finalArgs, ["-output-format", "--output-format"])) {
			extraPrefixArgs.push("--output-format", "stream-json");
			usingStreamJson = true;
		} else {
			usingStreamJson = finalArgs.some(
				(a, idx) =>
					/^--?output-format=stream-json$/i.test(a) ||
					(/^--?output-format$/i.test(a) && /^stream-json$/i.test(finalArgs[idx + 1] || ""))
			);
		}

		if (options.jobsDir && options.jobId && !hasCliFlag(finalArgs, ["-log-file", "--log-file"])) {
			if (!fs.existsSync(options.jobsDir)) {
				fs.mkdirSync(options.jobsDir, { recursive: true });
			}
			agyLogPath = path.join(options.jobsDir, `${options.jobId}.agy.log`);
			extraPrefixArgs.push("--log-file", agyLogPath);
		}

		if (extraPrefixArgs.length > 0) {
			finalArgs.unshift(...extraPrefixArgs);
		}
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
				`[${new Date().toISOString()}] Launching: ${resolvedExe} (project=${options.projectName || "default"}, payload=${commentsPayload.length} chars${spilledPayloadFile ? `, file=${spilledPayloadFile}` : ""})\n`
			);
		} catch {
			logPath = null;
			logStream = null;
		}
	}

	return new Promise<CliRunResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let stdoutLineBuf = "";
		let settled = false;

		let conversationId: string | null = null;
		let projectId: string | null = null;
		let liveInstanceId: string | null = null;
		let streamError: string | null = null;
		let lastStepLabel = "";

		const notifyConvId = (id: string | null | undefined) => {
			if (!id || conversationId === id) return;
			conversationId = id;
			options.onConversationId?.(id);
		};
		const notifyProjectId = (id: string | null | undefined) => {
			if (!id || projectId === id) return;
			projectId = id;
			options.onProjectId?.(id);
		};
		const notifyRemoteId = (id: string | null | undefined) => {
			if (!id || liveInstanceId === id) return;
			liveInstanceId = id;
			options.onRemoteInstanceId?.(id);
		};

		let agyLogPollTimer: ReturnType<typeof setInterval> | null = null;
		let agyLogOffset = 0;

		const stopAgyLogPoll = () => {
			if (agyLogPollTimer !== null) {
				clearInterval(agyLogPollTimer);
				agyLogPollTimer = null;
			}
		};

		const scanAgyInternalLog = () => {
			if (!agyLogPath || !fs.existsSync(agyLogPath)) return;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(agyLogPath);
			} catch {
				return;
			}
			if (stat.size <= agyLogOffset) return;

			let text = "";
			try {
				const fd = fs.openSync(agyLogPath, "r");
				try {
					const len = stat.size - agyLogOffset;
					const buf = Buffer.alloc(len);
					fs.readSync(fd, buf, 0, len, agyLogOffset);
					agyLogOffset = stat.size;
					text = buf.toString("utf8");
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				return;
			}

			if (!liveInstanceId) {
				const m = text.match(LOG_REMOTE_ID_RE);
				if (m && m[1]) notifyRemoteId(m[1]);
			}
			if (!projectId) {
				const m = text.match(LOG_PROJECT_ID_RE);
				if (m && m[1]) notifyProjectId(m[1]);
			}
			if (!conversationId) {
				const m = text.match(LOG_CONV_ID_RE);
				if (m && m[1]) notifyConvId(m[1]);
			}

			if (projectId && conversationId && (!expectLiveRemoteId || liveInstanceId)) {
				stopAgyLogPoll();
			}
		};

		const handleStreamJsonLine = (rawLine: string) => {
			const trimmed = rawLine.trim();
			if (!trimmed.startsWith("{")) return;
			let parsedEvent: any;
			try {
				parsedEvent = JSON.parse(trimmed);
			} catch {
				return;
			}

			if (typeof parsedEvent.conversation_id === "string" && parsedEvent.conversation_id) {
				notifyConvId(parsedEvent.conversation_id);
			}

			if (parsedEvent.event === "step_update" && parsedEvent.step_update) {
				const su = parsedEvent.step_update;
				if (typeof su.conversation_id === "string" && su.conversation_id) {
					notifyConvId(su.conversation_id);
				}
				const label = formatLiveStepLabel(su);
				if (label && label !== lastStepLabel) {
					lastStepLabel = label;
					options.onStepUpdate?.(label, typeof su.step_index === "number" ? su.step_index : 0);
				}
			} else if (parsedEvent.event === "result" && parsedEvent.result) {
				const r = parsedEvent.result;
				if (typeof r.conversation_id === "string" && r.conversation_id) {
					notifyConvId(r.conversation_id);
				}
				if (typeof r.error === "string" && r.error.trim()) {
					streamError = r.error.trim();
				}
			}
		};

		const child = spawn(resolvedExe, finalArgs, {
			cwd: options.cwd || undefined,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		options.onSpawn?.(child.pid ?? null);
		if (logStream && child.pid) {
			logStream.write(`[${new Date().toISOString()}] PID=${child.pid}\n`);
		}

		if (agyLogPath) {
			agyLogPollTimer = setInterval(scanAgyInternalLog, 1000);
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout += text;
			logStream?.write(text);

			if (usingStreamJson) {
				stdoutLineBuf += text;
				const lines = stdoutLineBuf.split(/\r?\n/);
				stdoutLineBuf = lines.pop() ?? "";
				for (const line of lines) {
					handleStreamJsonLine(line);
				}
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr += text;
			logStream?.write(`[stderr] ${text}`);
		});

		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			stopAgyLogPoll();
			logStream?.write(`\n[ERROR] ${err.message}\n`);
			logStream?.end();
			reject(new Error(`Failed to start ${parsed.displayName}: ${err.message}`));
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			if (usingStreamJson && stdoutLineBuf.trim()) {
				handleStreamJsonLine(stdoutLineBuf);
				stdoutLineBuf = "";
			}
			scanAgyInternalLog();
			stopAgyLogPoll();

			logStream?.write(
				`\n[${new Date().toISOString()}] Exit code=${code}, signal=${signal || "none"}, conv=${conversationId || "none"}, project=${projectId || "none"}\n`
			);
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
				agyLogPath,
				conversationId,
				projectId,
				liveInstanceId,
				streamError,
			});
		});
	});
}
