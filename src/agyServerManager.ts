/**
 * agyServerManager.ts — Manages the Obsidian-lifecycle Antigravity Remote Control
 * server (`agy remote-control serve`) so Henri always has a single, persistent-URL
 * web instance (`https://antigravity.google.com/r/<uuid>-v2`) that starts with
 * Obsidian and stops cleanly when Obsidian closes or restarts.
 *
 * - Runs as a direct child process (`detached: false`, `windowsHide: true`) instead of
 *   registering OS Scheduled Tasks or Windows Registry Run keys.
 * - Uses `~/.gemini/antigravity-cli/antigravity_state.pbtxt` (`installation_uuid`) so
 *   the Remote Control URL stays 100% fixed across Obsidian restarts.
 * - Resolves the target Antigravity project (`Obsidian` by default) by name or ID from
 *   `~/.gemini/config/projects/*.json` for multi-PC portability.
 */

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveExecutablePath } from "./cliRunner";
import { isPidAlive } from "./activeJobsTracker";

export type AgyServerStatus = "stopped" | "starting" | "connected" | "error";

export interface AgyProjectInfo {
	id: string;
	name: string;
}

export interface AgyServerSnapshot {
	status: AgyServerStatus;
	pid: number | null;
	instanceId: string | null;
	hostname: string;
	projectName: string;
	projectId: string | null;
	accountEmail: string | null;
	startedAt: string | null;
	lastError: string | null;
	logPath: string | null;
}

export interface AgyServerConfig {
	cliCommandTemplate: string;
	projectName: string;
	serverName: string;
}

const REMOTE_CONTROL_ID_RE = /\[remote-control-([a-zA-Z0-9-]+)\]/;
const CONNECTED_RE = /\[remote-control-([a-zA-Z0-9-]+)\]\s+Connection status:\s+Connected/i;
const DISCONNECTED_RE =
	/\[remote-control-[a-zA-Z0-9-]+\]\s+(?:Connection loop exited|Reconnection attempt)/i;

export function getDefaultAgyServerName(): string {
	const raw = (os.hostname() || "obsidian").toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
	const clean = raw.replace(/^-+|-+$/g, "") || "local";
	return `obsidian-${clean}`;
}

export function buildAgyServerHomeUrl(
	instanceId: string | null | undefined,
	projectId?: string | null
): string | null {
	if (!instanceId) return null;
	const base = `https://antigravity.google.com/r/${encodeURIComponent(instanceId)}`;
	if (projectId && projectId.trim()) {
		return `${base}?p=${encodeURIComponent(`?project=${projectId.trim()}`)}`;
	}
	return base;
}

export function buildAgyConversationUrl(
	instanceId: string | null | undefined,
	conversationId: string | null | undefined,
	projectId?: string | null
): string | null {
	if (!instanceId || !conversationId) return null;
	const inner =
		projectId && projectId.trim()
			? `c/${conversationId}?project=${projectId.trim()}`
			: `c/${conversationId}`;
	return `https://antigravity.google.com/r/${encodeURIComponent(instanceId)}?p=${encodeURIComponent(inner)}`;
}

export function resolveAgyProjectInfo(projectNameOrId: string): AgyProjectInfo {
	const query = (projectNameOrId || "").trim();
	if (!query) {
		return { id: "", name: "" };
	}

	const projectsDir = path.join(os.homedir(), ".gemini", "config", "projects");
	if (!fs.existsSync(projectsDir)) {
		return { id: "", name: query };
	}

	const lowerQuery = query.toLowerCase();
	let files: string[];
	try {
		files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return { id: "", name: query };
	}

	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf8"));
			const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
			const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
			if (!id) continue;
			if (id.toLowerCase() === lowerQuery || name.toLowerCase() === lowerQuery) {
				return { id, name: name || query };
			}
		} catch {
			// Skip malformed project file
		}
	}

	return { id: "", name: query };
}

export function readPersistentDaemonInstanceId(): string | null {
	const statePath = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity_state.pbtxt");
	if (!fs.existsSync(statePath)) return null;
	try {
		const raw = fs.readFileSync(statePath, "utf8");
		const m = raw.match(/installation_uuid\s*:\s*"([a-f0-9-]+)"/i);
		if (m && m[1]) {
			return `${m[1]}-v2`;
		}
	} catch {
		return null;
	}
	return null;
}

function syncCliRemoteControlHostname(hostname: string): void {
	const trimmed = hostname.trim();
	if (!trimmed) return;
	const configPath = path.join(os.homedir(), ".gemini", "config", "config.json");
	if (!fs.existsSync(configPath)) return;

	const raw = fs.readFileSync(configPath, "utf8");
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") return;
	if (!parsed.userSettings || typeof parsed.userSettings !== "object") {
		parsed.userSettings = {};
	}
	if (parsed.userSettings.cliRemoteControlHostname === trimmed) {
		return;
	}
	parsed.userSettings.cliRemoteControlHostname = trimmed;
	fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

function extractAgyExecutableFromTemplate(template: string): string {
	const trimmed = (template || "").trim();
	if (!trimmed) return "agy";
	const m = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
	const token = (m?.[1] || m?.[2] || m?.[3] || "agy").trim();
	const base = path.basename(token).toLowerCase();
	if (base === "agy" || base === "agy.exe") {
		return token;
	}
	return "agy";
}

export class AgyServerManager {
	private getVaultBasePath: () => string;
	private ensureJobsLogDir: () => string;
	private getConfig: () => AgyServerConfig;

	private child: ChildProcess | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private logByteOffset: number = 0;
	private stoppingIntentionally: boolean = false;
	private listeners: Set<(snap: AgyServerSnapshot) => void> = new Set();

	private snapshot: AgyServerSnapshot;

	constructor(
		getVaultBasePath: () => string,
		ensureJobsLogDir: () => string,
		getConfig: () => AgyServerConfig
	) {
		this.getVaultBasePath = getVaultBasePath;
		this.ensureJobsLogDir = ensureJobsLogDir;
		this.getConfig = getConfig;

		const cfg = this.getConfig();
		const proj = resolveAgyProjectInfo(cfg.projectName);
		this.snapshot = {
			status: "stopped",
			pid: null,
			instanceId: readPersistentDaemonInstanceId(),
			hostname: (cfg.serverName || "").trim() || getDefaultAgyServerName(),
			projectName: proj.name || cfg.projectName || "Obsidian",
			projectId: proj.id || null,
			accountEmail: null,
			startedAt: null,
			lastError: null,
			logPath: null,
		};
	}

	public subscribe(listener: (snap: AgyServerSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		const snap = this.getSnapshot();
		for (const fn of this.listeners) {
			try {
				fn(snap);
			} catch (err) {
				console.error("[SlideFlow AGY Server] Listener error:", err);
			}
		}
	}

	public getSnapshot(): AgyServerSnapshot {
		return { ...this.snapshot };
	}

	public refreshProjectConfig(): void {
		const cfg = this.getConfig();
		const proj = resolveAgyProjectInfo(cfg.projectName);
		const desiredHost = (cfg.serverName || "").trim() || getDefaultAgyServerName();
		const nextProjName = proj.name || cfg.projectName || "Obsidian";
		const nextProjId = proj.id || null;

		if (
			this.snapshot.projectName !== nextProjName ||
			this.snapshot.projectId !== nextProjId ||
			this.snapshot.hostname !== desiredHost
		) {
			this.snapshot.projectName = nextProjName;
			this.snapshot.projectId = nextProjId;
			this.snapshot.hostname = desiredHost;
			this.emit();
		}
	}

	public getServerHomeUrl(): string | null {
		const instanceId = this.snapshot.instanceId || readPersistentDaemonInstanceId();
		if (instanceId && instanceId !== this.snapshot.instanceId) {
			this.snapshot.instanceId = instanceId;
		}
		return buildAgyServerHomeUrl(instanceId, this.snapshot.projectId);
	}

	public getConversationUrl(
		conversationId: string | null | undefined,
		projectId?: string | null,
		overrideInstanceId?: string | null
	): string | null {
		const instanceId =
			overrideInstanceId || this.snapshot.instanceId || readPersistentDaemonInstanceId();
		const effectiveProjectId = projectId || this.snapshot.projectId;
		return buildAgyConversationUrl(instanceId, conversationId, effectiveProjectId);
	}

	private getPidFilePath(): string {
		return path.join(this.ensureJobsLogDir(), "agy_server.pid");
	}

	private getServerLogPath(): string {
		return path.join(this.ensureJobsLogDir(), "agy_server.log");
	}

	private cleanupStaleManagedPid(): void {
		const pidFile = this.getPidFilePath();
		if (!fs.existsSync(pidFile)) return;
		try {
			const raw = fs.readFileSync(pidFile, "utf8").trim();
			const oldPid = parseInt(raw, 10);
			if (Number.isInteger(oldPid) && oldPid > 0 && isPidAlive(oldPid)) {
				// Avoid killing an unrelated PID if it is already our live child
				if (!this.child || this.child.pid !== oldPid) {
					try {
						process.kill(oldPid);
					} catch {
						// Ignore if already exited
					}
				}
			}
		} catch {
			// Ignore corrupt pid file
		}
		try {
			fs.unlinkSync(pidFile);
		} catch {
			// Ignore unlink race
		}
	}

	private stopLogPolling(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private pollServerLog(): void {
		const logPath = this.snapshot.logPath;
		if (!logPath || !fs.existsSync(logPath)) return;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(logPath);
		} catch {
			return;
		}

		if (stat.size <= this.logByteOffset) return;

		let chunk = "";
		try {
			const fd = fs.openSync(logPath, "r");
			try {
				const len = stat.size - this.logByteOffset;
				const buf = Buffer.alloc(len);
				fs.readSync(fd, buf, 0, len, this.logByteOffset);
				this.logByteOffset = stat.size;
				chunk = buf.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return;
		}

		if (!chunk) return;

		let changed = false;
		const lines = chunk.split(/\r?\n/);
		for (const line of lines) {
			if (!line) continue;
			const idMatch = line.match(REMOTE_CONTROL_ID_RE);
			if (idMatch && idMatch[1] && this.snapshot.instanceId !== idMatch[1]) {
				this.snapshot.instanceId = idMatch[1];
				changed = true;
			}
			const connMatch = line.match(CONNECTED_RE);
			if (connMatch) {
				if (connMatch[1] && this.snapshot.instanceId !== connMatch[1]) {
					this.snapshot.instanceId = connMatch[1];
				}
				if (this.snapshot.status !== "connected") {
					this.snapshot.status = "connected";
					this.snapshot.lastError = null;
					changed = true;
				}
			} else if (DISCONNECTED_RE.test(line)) {
				if (this.snapshot.status === "connected") {
					this.snapshot.status = "starting";
					changed = true;
				}
			}
		}

		if (changed) {
			this.emit();
		}
	}

	public start(): void {
		if (this.child && this.child.exitCode === null && !this.child.killed) {
			return;
		}

		const cfg = this.getConfig();
		const proj = resolveAgyProjectInfo(cfg.projectName);
		const hostname = (cfg.serverName || "").trim() || getDefaultAgyServerName();

		this.snapshot.projectName = proj.name || cfg.projectName || "Obsidian";
		this.snapshot.projectId = proj.id || null;
		this.snapshot.hostname = hostname;

		let resolvedExe: string;
		try {
			const exeToken = extractAgyExecutableFromTemplate(cfg.cliCommandTemplate);
			resolvedExe = resolveExecutablePath(exeToken);
		} catch (err: any) {
			this.snapshot.status = "error";
			this.snapshot.lastError = err?.message || String(err);
			this.emit();
			return;
		}

		try {
			syncCliRemoteControlHostname(hostname);
		} catch (err: any) {
			console.error("[SlideFlow AGY Server] Failed to sync cliRemoteControlHostname:", err);
		}

		this.cleanupStaleManagedPid();

		const logPath = this.getServerLogPath();
		try {
			fs.writeFileSync(logPath, "", "utf8");
		} catch (err: any) {
			this.snapshot.status = "error";
			this.snapshot.lastError = `Cannot write server log: ${err?.message || String(err)}`;
			this.emit();
			return;
		}

		this.logByteOffset = 0;
		this.stoppingIntentionally = false;

		const args = ["--log-file", logPath, "remote-control", "serve"];
		const child = spawn(resolvedExe, args, {
			cwd: this.getVaultBasePath() || undefined,
			shell: false,
			detached: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		this.child = child;
		this.snapshot.status = "starting";
		this.snapshot.pid = child.pid ?? null;
		this.snapshot.startedAt = new Date().toISOString();
		this.snapshot.lastError = null;
		this.snapshot.logPath = logPath;
		if (!this.snapshot.instanceId) {
			this.snapshot.instanceId = readPersistentDaemonInstanceId();
		}

		if (child.pid) {
			try {
				fs.writeFileSync(this.getPidFilePath(), String(child.pid), "utf8");
			} catch {
				// Non-fatal
			}
		}

		this.emit();

		child.stdout?.on("data", (buf: Buffer) => {
			const text = buf.toString("utf8");
			const authMatch = text.match(/Authenticated as\s+(\S+)/i);
			if (authMatch && authMatch[1] && this.snapshot.accountEmail !== authMatch[1]) {
				this.snapshot.accountEmail = authMatch[1];
				this.emit();
			}
		});

		let stderrTail = "";
		child.stderr?.on("data", (buf: Buffer) => {
			stderrTail = (stderrTail + buf.toString("utf8")).slice(-500);
		});

		child.on("error", (err: Error) => {
			if (this.child === child) {
				this.child = null;
			}
			this.stopLogPolling();
			this.snapshot.status = "error";
			this.snapshot.pid = null;
			this.snapshot.lastError = err.message;
			this.emit();
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			const wasOurs = this.child === child;
			if (wasOurs) {
				this.child = null;
				this.stopLogPolling();
			}
			try {
				const pidFile = this.getPidFilePath();
				if (fs.existsSync(pidFile)) {
					const stored = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
					if (stored === child.pid) {
						fs.unlinkSync(pidFile);
					}
				}
			} catch {
				// Ignore cleanup race
			}

			if (!wasOurs) return;

			this.snapshot.pid = null;
			if (this.stoppingIntentionally) {
				this.snapshot.status = "stopped";
				this.snapshot.lastError = null;
			} else {
				const detail = stderrTail.trim().replace(/\s+/g, " ").slice(0, 140);
				this.snapshot.status = "error";
				this.snapshot.lastError = detail
					? `Arrêté (${code ?? signal ?? "?"}): ${detail}`
					: `Serveur interrompu (code ${code ?? signal ?? "?"})`;
			}
			this.emit();
		});

		this.stopLogPolling();
		this.pollTimer = setInterval(() => {
			this.pollServerLog();
		}, 1500);
	}

	public stop(): void {
		this.stoppingIntentionally = true;
		this.stopLogPolling();

		const child = this.child;
		this.child = null;

		if (child && child.exitCode === null && !child.killed) {
			try {
				child.kill();
			} catch (err) {
				console.error("[SlideFlow AGY Server] Failed to kill server child:", err);
			}
		}

		try {
			const pidFile = this.getPidFilePath();
			if (fs.existsSync(pidFile)) {
				fs.unlinkSync(pidFile);
			}
		} catch {
			// Ignore
		}

		this.snapshot.status = "stopped";
		this.snapshot.pid = null;
		this.snapshot.lastError = null;
		this.emit();
	}

	public async restart(): Promise<void> {
		this.stop();
		await new Promise((r) => setTimeout(r, 350));
		this.start();
	}
}
