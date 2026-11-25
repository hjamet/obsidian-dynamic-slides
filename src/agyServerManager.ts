/**
 * agyServerManager.ts — Unified Antigravity connection & Remote Control manager for SlideFlow:
 *
 * 1. **Primary mode — Running Antigravity Desktop Hub (`backendMode: "hub"`)**:
 *    - Automatically discovers the live `Antigravity.exe` language server via
 *      `~/.gemini/antigravity/daemon/hub_<httpPort>.json` + `GetRemoteControlInfo`.
 *    - Routes every SlideFlow `/one-shot` conversation directly into the running Antigravity
 *      Desktop App under the configured project (`Obsidian`) — streaming live inside BOTH the
 *      Desktop App and its single Remote Control instance (`eustache-radiant-flare`), with
 *      zero duplicate `obsidian-<host>` daemon and zero stale snapshots.
 *    - Continuously monitors Hub health (every 5s + on `online` / sleep-wake) and adapts
 *      transparently if `language_server.exe` restarts on a new port.
 *
 * 2. **Fallback mode — Managed `agy remote-control serve` (`backendMode: "cli-daemon"`)**:
 *    - Automatically activates when Antigravity Desktop App is closed (and `agyServerAutoStart`
 *      is enabled), and cleanly stands down if Antigravity Desktop App opens later.
 *    - **Bulletproof automatic reconnection**:
 *      - 4s grace window on routine Boq WebChannel reconnects (no UI flicker during 20-min refreshes).
 *      - 30s stall watchdog: if stuck in connecting/reconnecting (`Unknown SID`, post-sleep wedge),
 *        automatically restarts with a fresh OAuth token sync from the OS keyring.
 *      - Capped exponential-backoff auto-restart (`2s -> 4s -> 8s -> 15s -> 30s -> 60s`) on any
 *        unexpected exit or OAuth token loss (only halts if `agy` is genuinely signed out).
 *      - Automatic recovery on `window` `"online"` event and OS sleep/wake clock jumps (`> 25s`).
 */

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveExecutablePath } from "./cliRunner";
import { isPidAlive } from "./activeJobsTracker";
import {
	AntigravityHubInfo,
	discoverLiveAntigravityHub,
	readDesktopInstallationInstanceId,
	readDesktopRemoteControlHostname,
} from "./antigravityHubClient";

export type AgyServerStatus = "stopped" | "starting" | "connected" | "error";
export type AgyBackendMode = "hub" | "cli-daemon" | "none";

export interface AgyProjectInfo {
	id: string;
	name: string;
	matchedBy?: "id" | "name" | "workspace" | "none";
}

export interface AgyServerSnapshot {
	status: AgyServerStatus;
	backendMode: AgyBackendMode;
	statusDetail: string | null;
	pid: number | null;
	hubPort: number | null;
	remoteControlEnabled: boolean;
	instanceId: string | null;
	companionOrigin: string;
	hostname: string;
	projectName: string;
	projectId: string | null;
	accountEmail: string | null;
	startedAt: string | null;
	lastError: string | null;
	logPath: string | null;
	reconnectAttempt: number;
}

export interface AgyServerConfig {
	cliCommandTemplate: string;
	projectName: string;
	serverName: string;
	autoStart: boolean;
}

const REMOTE_CONTROL_ID_RE = /\[remote-control-([a-zA-Z0-9-]+)\]/;
const CONNECTED_RE = /\[remote-control-([a-zA-Z0-9-]+)\]\s+Connection status:\s+Connected/i;
const DISCONNECTED_RE =
	/\[remote-control-[a-zA-Z0-9-]+\]\s+(?:Connection loop exited|Reconnection attempt|WebChannel error callback|Connection status:\s+Disconnected)/i;
const HEADLESS_AUTH_EMAIL_RE = /Headless auth:\s+authenticated as\s+"([^"]+)"/i;
const AUTH_LOSS_RE =
	/(?:\[auth-status\]\s+rpc=has_auth_token\s+has_token=false|Auth probe:\s+OAuth server rejected|Headless auth:\s+no valid auth|OAuth session expired or revoked)/i;

const HEALTH_CHECK_INTERVAL_MS = 5_000;
const CLI_LOG_POLL_INTERVAL_MS = 1_500;
const TRANSIENT_DISCONNECT_GRACE_MS = 4_000;
const STALL_WATCHDOG_MS = 30_000;
const STABLE_CONNECTION_RESET_MS = 20_000;
const CLOCK_JUMP_THRESHOLD_MS = 25_000;
const RECONNECT_BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

interface ShortCommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

function runShortCommand(
	exe: string,
	args: string[],
	timeoutMs: number
): Promise<ShortCommandResult> {
	return new Promise((resolve) => {
		const child = spawn(exe, args, {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, signal, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// Ignore kill race
			}
		}, timeoutMs);

		child.stdout?.on("data", (buf: Buffer) => {
			stdout += buf.toString("utf8");
		});
		child.stderr?.on("data", (buf: Buffer) => {
			stderr += buf.toString("utf8");
		});
		child.on("close", (code, signal) => finish(code, signal));
		child.on("error", (err: Error) => {
			stderr = stderr ? `${stderr}\n${err.message}` : err.message;
			finish(-1, null);
		});
	});
}

export function getDaemonTokenFilePath(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function getOfficialDaemonPidFilePath(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-cli-daemon.pid");
}

/**
 * Headless `agy remote-control serve` reads exclusively from `~/.gemini/antigravity-cli/antigravity-oauth-token`
 * (file-based token storage) and never falls back to the OS keyring used by interactive `agy`.
 */
export function isDaemonTokenFileUsable(tokenPath: string = getDaemonTokenFilePath()): boolean {
	if (!fs.existsSync(tokenPath)) return false;
	try {
		const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
		const tok = parsed?.token ?? parsed;
		if (!tok || typeof tok !== "object") return false;
		if (typeof tok.refresh_token === "string" && tok.refresh_token.trim().length > 0) {
			return true;
		}
		if (typeof tok.access_token === "string" && tok.access_token.trim().length > 0) {
			if (typeof tok.expiry === "string" && tok.expiry.trim()) {
				const expMs = Date.parse(tok.expiry);
				return Number.isFinite(expMs) && expMs > Date.now() + 60_000;
			}
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

async function isPidAgyProcess(pid: number): Promise<boolean> {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (process.platform === "win32") {
		const res = await runShortCommand(
			"tasklist",
			["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
			4000
		);
		return res.code === 0 && res.stdout.toLowerCase().includes("agy");
	}
	const res = await runShortCommand("ps", ["-p", String(pid), "-o", "comm="], 4000);
	return res.code === 0 && res.stdout.toLowerCase().includes("agy");
}

export function getDefaultAgyServerName(): string {
	const raw = (os.hostname() || "obsidian").toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
	const clean = raw.replace(/^-+|-+$/g, "") || "local";
	return `obsidian-${clean}`;
}

export function buildAgyServerHomeUrl(
	instanceId: string | null | undefined,
	projectId?: string | null,
	companionOrigin: string = "https://antigravity.google.com"
): string | null {
	if (!instanceId) return null;
	const origin = (companionOrigin || "https://antigravity.google.com").replace(/\/+$/, "");
	const base = `${origin}/r/${encodeURIComponent(instanceId)}`;
	if (projectId && projectId.trim()) {
		return `${base}?p=${encodeURIComponent(`?project=${projectId.trim()}`)}`;
	}
	return base;
}

export function buildAgyConversationUrl(
	instanceId: string | null | undefined,
	conversationId: string | null | undefined,
	projectId?: string | null,
	companionOrigin: string = "https://antigravity.google.com"
): string | null {
	if (!instanceId || !conversationId) return null;
	const origin = (companionOrigin || "https://antigravity.google.com").replace(/\/+$/, "");
	const inner =
		projectId && projectId.trim()
			? `c/${conversationId}?project=${projectId.trim()}`
			: `c/${conversationId}`;
	return `${origin}/r/${encodeURIComponent(instanceId)}?p=${encodeURIComponent(inner)}`;
}

function normalizeFsPathForMatch(rawPathOrUri: string): string {
	let s = (rawPathOrUri || "").trim();
	if (!s) return "";
	if (/^file:\/\//i.test(s)) {
		s = s.replace(/^file:\/\/\/?/i, "");
		try {
			s = decodeURIComponent(s);
		} catch {
			// Keep undecoded string
		}
	}
	s = s.replace(/\\/g, "/").replace(/\/+$/, "");
	if (/^\/[a-z]:\//i.test(s)) {
		s = s.slice(1);
	}
	return process.platform === "win32" ? s.toLowerCase() : s;
}

export function listAvailableAgyProjects(): AgyProjectInfo[] {
	const projectsDir = path.join(os.homedir(), ".gemini", "config", "projects");
	if (!fs.existsSync(projectsDir)) return [];
	let files: string[];
	try {
		files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}

	const out: AgyProjectInfo[] = [];
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf8"));
			const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
			const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
			if (!id || parsed?.sidecar) continue;
			if (id === "default-cli-project" || id === "outside-of-project") continue;
			out.push({ id, name: name || id });
		} catch {
			// Skip malformed project JSON
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveAgyProjectInfo(
	projectNameOrId: string,
	vaultBasePath?: string
): AgyProjectInfo {
	const query = (projectNameOrId || "").trim();
	const projectsDir = path.join(os.homedir(), ".gemini", "config", "projects");
	if (!fs.existsSync(projectsDir)) {
		return { id: "", name: query, matchedBy: "none" };
	}

	let files: string[];
	try {
		files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return { id: "", name: query, matchedBy: "none" };
	}

	const parsedProjects: any[] = [];
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf8"));
			if (parsed && typeof parsed === "object" && typeof parsed.id === "string" && parsed.id.trim()) {
				parsedProjects.push(parsed);
			}
		} catch {
			// Skip malformed file
		}
	}

	const lowerQuery = query.toLowerCase();
	if (lowerQuery) {
		// Pass 1: exact ID match
		for (const parsed of parsedProjects) {
			const id = String(parsed.id).trim();
			const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
			if (id.toLowerCase() === lowerQuery) {
				return { id, name: name || query, matchedBy: "id" };
			}
		}
		// Pass 2: exact name match (preferring non-sidecar projects)
		const nonSidecars = parsedProjects.filter((p) => !p.sidecar);
		for (const parsed of [...nonSidecars, ...parsedProjects.filter((p) => p.sidecar)]) {
			const id = String(parsed.id).trim();
			const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
			if (name.toLowerCase() === lowerQuery) {
				return { id, name: name || query, matchedBy: "name" };
			}
		}
	}

	// Pass 3: match vault directory against projectResources.resources[].folderUri (excluding sidecars)
	const normVault = normalizeFsPathForMatch(vaultBasePath || "");
	if (normVault) {
		for (const parsed of parsedProjects) {
			if (parsed.sidecar) continue;
			const id = String(parsed.id).trim();
			if (id === "default-cli-project" || id === "outside-of-project") continue;
			const resources = parsed?.projectResources?.resources;
			if (!Array.isArray(resources)) continue;
			for (const res of resources) {
				const uri = res?.folderUri || res?.gitFolder?.folderUri || "";
				if (uri && normalizeFsPathForMatch(String(uri)) === normVault) {
					const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
					return { id, name: name || query || id, matchedBy: "workspace" };
				}
			}
		}
	}

	return { id: "", name: query, matchedBy: "none" };
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
	private activeHub: AntigravityHubInfo | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
	private stallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
	private stableConnTimer: ReturnType<typeof setTimeout> | null = null;

	private logByteOffset: number = 0;
	private stoppingIntentionally: boolean = false;
	private startInFlight: boolean = false;
	private healthCheckInFlight: boolean = false;
	private launchEpoch: number = 0;
	private reconnectAttempt: number = 0;
	private lastTickWallClockMs: number = Date.now();
	private onlineListener: (() => void) | null = null;
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
		const proj = resolveAgyProjectInfo(cfg.projectName, this.getVaultBasePath());
		this.snapshot = {
			status: "stopped",
			backendMode: "none",
			statusDetail: null,
			pid: null,
			hubPort: null,
			remoteControlEnabled: false,
			instanceId: readDesktopInstallationInstanceId() || readPersistentDaemonInstanceId(),
			companionOrigin: "https://antigravity.google.com",
			hostname: readDesktopRemoteControlHostname() || (cfg.serverName || "").trim() || getDefaultAgyServerName(),
			projectName: proj.name || cfg.projectName || "Obsidian",
			projectId: proj.id || null,
			accountEmail: null,
			startedAt: null,
			lastError: null,
			logPath: null,
			reconnectAttempt: 0,
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
		const proj = resolveAgyProjectInfo(cfg.projectName, this.getVaultBasePath());
		const nextProjName = proj.name || cfg.projectName || "Obsidian";
		const nextProjId = proj.id || null;
		const nextHost =
			this.snapshot.backendMode === "hub"
				? this.activeHub?.hostname || readDesktopRemoteControlHostname()
				: (cfg.serverName || "").trim() || getDefaultAgyServerName();

		if (
			this.snapshot.projectName !== nextProjName ||
			this.snapshot.projectId !== nextProjId ||
			this.snapshot.hostname !== nextHost
		) {
			this.snapshot.projectName = nextProjName;
			this.snapshot.projectId = nextProjId;
			this.snapshot.hostname = nextHost;
			this.emit();
		}
	}

	public getServerHomeUrl(): string | null {
		const instanceId =
			this.snapshot.instanceId ||
			(this.snapshot.backendMode === "hub"
				? readDesktopInstallationInstanceId()
				: readPersistentDaemonInstanceId());
		if (instanceId && instanceId !== this.snapshot.instanceId) {
			this.snapshot.instanceId = instanceId;
		}
		return buildAgyServerHomeUrl(instanceId, this.snapshot.projectId, this.snapshot.companionOrigin);
	}

	public getConversationUrl(
		conversationId: string | null | undefined,
		projectId?: string | null,
		overrideInstanceId?: string | null
	): string | null {
		const instanceId =
			overrideInstanceId ||
			this.snapshot.instanceId ||
			readDesktopInstallationInstanceId() ||
			readPersistentDaemonInstanceId();
		const effectiveProjectId = projectId || this.snapshot.projectId;
		return buildAgyConversationUrl(
			instanceId,
			conversationId,
			effectiveProjectId,
			this.snapshot.companionOrigin
		);
	}

	/**
	 * Always returns a freshly verified Antigravity Desktop Hub when available (re-probing
	 * dynamically if Antigravity started or restarted on a new port), updating internal state.
	 */
	public async getLiveHub(): Promise<AntigravityHubInfo | null> {
		const hub = await discoverLiveAntigravityHub(2500);
		if (hub) {
			this.applyHubConnectedState(hub);
			return hub;
		}
		if (this.snapshot.backendMode === "hub") {
			this.activeHub = null;
		}
		return null;
	}

	private getPidFilePath(): string {
		return path.join(this.ensureJobsLogDir(), "agy_server.pid");
	}

	private getServerLogPath(): string {
		return path.join(this.ensureJobsLogDir(), "agy_server.log");
	}

	private clearAllCliTimers(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.disconnectGraceTimer !== null) {
			clearTimeout(this.disconnectGraceTimer);
			this.disconnectGraceTimer = null;
		}
		if (this.stallWatchdogTimer !== null) {
			clearTimeout(this.stallWatchdogTimer);
			this.stallWatchdogTimer = null;
		}
		if (this.stableConnTimer !== null) {
			clearTimeout(this.stableConnTimer);
			this.stableConnTimer = null;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private stopHealthMonitor(): void {
		if (this.healthTimer !== null) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
		if (this.onlineListener && typeof window !== "undefined") {
			window.removeEventListener("online", this.onlineListener);
			this.onlineListener = null;
		}
	}

	private ensureHealthMonitorRunning(): void {
		if (this.healthTimer === null) {
			this.lastTickWallClockMs = Date.now();
			this.healthTimer = setInterval(() => {
				const now = Date.now();
				const elapsed = now - this.lastTickWallClockMs;
				this.lastTickWallClockMs = now;
				const wokeFromSleep = elapsed > CLOCK_JUMP_THRESHOLD_MS;
				void this.runHealthCheck(wokeFromSleep);
			}, HEALTH_CHECK_INTERVAL_MS);
		}
		if (!this.onlineListener && typeof window !== "undefined") {
			this.onlineListener = () => {
				void this.runHealthCheck(true);
			};
			window.addEventListener("online", this.onlineListener);
		}
	}

	private killCliChildOnly(): void {
		this.clearAllCliTimers();
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null && !child.killed) {
			try {
				child.kill();
			} catch (err) {
				console.error("[SlideFlow AGY Server] Failed to kill CLI server child:", err);
			}
		}
		try {
			const pidFile = this.getPidFilePath();
			if (fs.existsSync(pidFile)) {
				fs.unlinkSync(pidFile);
			}
		} catch {
			// Ignore cleanup race
		}
	}

	private applyHubConnectedState(hub: AntigravityHubInfo): void {
		const cfg = this.getConfig();
		const proj = resolveAgyProjectInfo(cfg.projectName, this.getVaultBasePath());
		const hadCliChild = this.child !== null;
		if (hadCliChild) {
			// Prevent duplicate `obsidian-<host>` Remote Control instance alongside Antigravity Hub
			this.launchEpoch++;
			this.killCliChildOnly();
		}
		this.clearReconnectTimer();
		this.reconnectAttempt = 0;
		this.startInFlight = false;
		this.stoppingIntentionally = false;
		this.activeHub = hub;

		const nextDetail = hub.remoteControlEnabled
			? null
			: "Hub local (Remote Web désactivé dans Antigravity)";
		const changed =
			this.snapshot.status !== "connected" ||
			this.snapshot.backendMode !== "hub" ||
			this.snapshot.pid !== hub.pid ||
			this.snapshot.hubPort !== hub.httpPort ||
			this.snapshot.instanceId !== hub.instanceId ||
			this.snapshot.hostname !== hub.hostname ||
			this.snapshot.remoteControlEnabled !== hub.remoteControlEnabled ||
			this.snapshot.statusDetail !== nextDetail ||
			this.snapshot.projectId !== (proj.id || null) ||
			this.snapshot.projectName !== (proj.name || cfg.projectName || "Obsidian") ||
			this.snapshot.lastError !== null;

		this.snapshot.status = "connected";
		this.snapshot.backendMode = "hub";
		this.snapshot.statusDetail = nextDetail;
		this.snapshot.pid = hub.pid;
		this.snapshot.hubPort = hub.httpPort;
		this.snapshot.remoteControlEnabled = hub.remoteControlEnabled;
		this.snapshot.instanceId = hub.instanceId;
		this.snapshot.companionOrigin = hub.companionOrigin;
		this.snapshot.hostname = hub.hostname;
		this.snapshot.projectName = proj.name || cfg.projectName || "Obsidian";
		this.snapshot.projectId = proj.id || null;
		this.snapshot.lastError = null;
		this.snapshot.reconnectAttempt = 0;
		if (!this.snapshot.startedAt) {
			this.snapshot.startedAt = new Date().toISOString();
		}

		if (changed) {
			this.emit();
		}
	}

	private async runHealthCheck(forceHeal: boolean): Promise<void> {
		if (this.stoppingIntentionally || this.healthCheckInFlight) return;
		this.healthCheckInFlight = true;
		try {
			const hub = await discoverLiveAntigravityHub(2200);
			if (hub) {
				this.applyHubConnectedState(hub);
				return;
			}

			// No live Desktop Hub right now
			if (this.snapshot.backendMode === "hub") {
				this.activeHub = null;
				this.snapshot.hubPort = null;
				this.snapshot.pid = null;
				const cfg = this.getConfig();
				if (cfg.autoStart) {
					await this.startCliDaemon({ forceReseed: false });
				} else {
					this.snapshot.backendMode = "none";
					this.snapshot.status = "stopped";
					this.snapshot.statusDetail = "Antigravity fermé";
					this.emit();
				}
				return;
			}

			// In CLI daemon mode: verify child liveness and heal after sleep/wake or network return
			const cliAlive = this.child !== null && this.child.exitCode === null && !this.child.killed;
			if (forceHeal) {
				if (!cliAlive && !this.startInFlight && this.getConfig().autoStart) {
					this.clearReconnectTimer();
					await this.startCliDaemon({ forceReseed: !isDaemonTokenFileUsable() });
				} else if (cliAlive && this.snapshot.status !== "connected") {
					// After sleep/wake or network bounce, refresh the CLI daemon cleanly instead of waiting on a wedged WebChannel
					this.scheduleAutoReconnect("Reconnexion après mise en veille / réseau…", true, 500);
				}
			} else if (!cliAlive && !this.startInFlight && this.reconnectTimer === null && this.getConfig().autoStart) {
				if (this.snapshot.status === "error" || this.snapshot.status === "connected") {
					this.scheduleAutoReconnect("Reprise automatique du serveur AGY…", !isDaemonTokenFileUsable());
				}
			}
		} finally {
			this.healthCheckInFlight = false;
		}
	}

	private scheduleAutoReconnect(
		detail: string,
		forceReseed: boolean,
		explicitDelayMs?: number
	): void {
		if (this.stoppingIntentionally) return;
		if (this.reconnectTimer !== null) return;

		const stepIdx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_STEPS_MS.length - 1);
		const delayMs = explicitDelayMs ?? RECONNECT_BACKOFF_STEPS_MS[stepIdx];
		this.reconnectAttempt++;

		this.killCliChildOnly();
		this.startInFlight = false;
		this.snapshot.backendMode = "cli-daemon";
		this.snapshot.status = "starting";
		this.snapshot.pid = null;
		this.snapshot.reconnectAttempt = this.reconnectAttempt;
		this.snapshot.statusDetail =
			delayMs >= 2000
				? `${detail} (tentative #${this.reconnectAttempt} dans ${Math.round(delayMs / 1000)}s)`
				: detail;
		this.emit();

		const scheduledEpoch = this.launchEpoch;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.stoppingIntentionally || scheduledEpoch !== this.launchEpoch) return;
			void this.start({ forceReseed });
		}, delayMs);
	}

	private armStallWatchdog(myEpoch: number): void {
		if (this.stallWatchdogTimer !== null) {
			clearTimeout(this.stallWatchdogTimer);
		}
		this.stallWatchdogTimer = setTimeout(() => {
			this.stallWatchdogTimer = null;
			if (this.stoppingIntentionally || myEpoch !== this.launchEpoch) return;
			if (this.snapshot.backendMode === "cli-daemon" && this.snapshot.status !== "connected") {
				this.scheduleAutoReconnect("Reconnexion AGY bloquée — redémarrage auto", true, 1_500);
			}
		}, STALL_WATCHDOG_MS);
	}

	private async cleanupStaleManagedPid(): Promise<void> {
		const pidFile = this.getPidFilePath();
		if (!fs.existsSync(pidFile)) return;
		try {
			const raw = fs.readFileSync(pidFile, "utf8").trim();
			const oldPid = parseInt(raw, 10);
			if (
				Number.isInteger(oldPid) &&
				oldPid > 0 &&
				isPidAlive(oldPid) &&
				(!this.child || this.child.pid !== oldPid)
			) {
				if (await isPidAgyProcess(oldPid)) {
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

	/**
	 * Stops any competing official `agy remote-control start` daemon sharing the same
	 * installation UUID so two daemons never kick each other off WebChannel.
	 */
	private async stopCompetingOfficialDaemon(resolvedExe: string): Promise<void> {
		const daemonPidFile = getOfficialDaemonPidFilePath();
		if (!fs.existsSync(daemonPidFile)) return;
		let pid = NaN;
		try {
			pid = parseInt(fs.readFileSync(daemonPidFile, "utf8").trim(), 10);
		} catch {
			return;
		}
		if (
			Number.isInteger(pid) &&
			pid > 0 &&
			isPidAlive(pid) &&
			(!this.child || this.child.pid !== pid)
		) {
			await runShortCommand(resolvedExe, ["remote-control", "stop"], 10_000);
		}
	}

	/**
	 * Uses `agy remote-control start --session` to run `(*Daemon).SeedToken()` (exporting the
	 * OS keyring OAuth token to `~/.gemini/antigravity-cli/antigravity-oauth-token`), then
	 * immediately runs `agy remote-control stop` so zero detached daemon or OS logon key remains.
	 */
	private async seedDaemonToken(
		resolvedExe: string,
		hostname: string
	): Promise<{ ok: boolean; signedOut: boolean; error: string | null }> {
		const startRes = await runShortCommand(
			resolvedExe,
			["remote-control", "start", "--session", "--name", hostname],
			20_000
		);

		const mayHaveSpawnedOrRegistered =
			startRes.code === 0 ||
			startRes.timedOut ||
			fs.existsSync(getOfficialDaemonPidFilePath()) ||
			/registry Run key|logon task/i.test(startRes.stderr);

		if (mayHaveSpawnedOrRegistered) {
			await runShortCommand(resolvedExe, ["remote-control", "stop"], 10_000);
		}

		if (isDaemonTokenFileUsable()) {
			return { ok: true, signedOut: false, error: null };
		}

		const combined = `${startRes.stderr}\n${startRes.stdout}`.trim();
		if (/not signed in/i.test(combined)) {
			return {
				ok: false,
				signedOut: true,
				error:
					"Non connecté à AGY : ouvrez un terminal, lancez « agy » pour vous connecter, puis cliquez sur Démarrer.",
			};
		}
		const detail = combined.replace(/\s+/g, " ").slice(0, 140);
		return {
			ok: false,
			signedOut: false,
			error: detail
				? `Échec de synchronisation du jeton AGY (${startRes.code ?? "?"}): ${detail}`
				: `Échec de synchronisation du jeton AGY (code ${startRes.code ?? "?"})`,
		};
	}

	private pollServerLog(myEpoch: number): void {
		if (myEpoch !== this.launchEpoch) return;
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
		let sawAuthLoss = false;
		const lines = chunk.split(/\r?\n/);
		for (const line of lines) {
			if (!line) continue;
			const idMatch = line.match(REMOTE_CONTROL_ID_RE);
			if (idMatch && idMatch[1] && this.snapshot.instanceId !== idMatch[1]) {
				this.snapshot.instanceId = idMatch[1];
				changed = true;
			}
			const emailMatch = line.match(HEADLESS_AUTH_EMAIL_RE);
			if (emailMatch && emailMatch[1]) {
				if (this.snapshot.accountEmail !== emailMatch[1]) {
					this.snapshot.accountEmail = emailMatch[1];
					changed = true;
				}
				sawAuthLoss = false;
			}
			if (AUTH_LOSS_RE.test(line)) {
				sawAuthLoss = true;
			}
			const connMatch = line.match(CONNECTED_RE);
			if (connMatch) {
				if (connMatch[1] && this.snapshot.instanceId !== connMatch[1]) {
					this.snapshot.instanceId = connMatch[1];
				}
				if (this.disconnectGraceTimer !== null) {
					clearTimeout(this.disconnectGraceTimer);
					this.disconnectGraceTimer = null;
				}
				if (this.stallWatchdogTimer !== null) {
					clearTimeout(this.stallWatchdogTimer);
					this.stallWatchdogTimer = null;
				}
				if (this.snapshot.status !== "connected") {
					this.snapshot.status = "connected";
					this.snapshot.statusDetail = null;
					this.snapshot.lastError = null;
					this.snapshot.remoteControlEnabled = true;
					changed = true;
				}
				if (this.stableConnTimer === null && this.reconnectAttempt > 0) {
					this.stableConnTimer = setTimeout(() => {
						this.stableConnTimer = null;
						if (this.snapshot.status === "connected" && myEpoch === this.launchEpoch) {
							this.reconnectAttempt = 0;
							this.snapshot.reconnectAttempt = 0;
						}
					}, STABLE_CONNECTION_RESET_MS);
				}
			} else if (DISCONNECTED_RE.test(line)) {
				if (this.stableConnTimer !== null) {
					clearTimeout(this.stableConnTimer);
					this.stableConnTimer = null;
				}
				// Grace window: routine Boq WebChannel renewals reconnect in <500ms; only surface UI state if still down after 4s
				if (this.snapshot.status === "connected" && this.disconnectGraceTimer === null) {
					this.disconnectGraceTimer = setTimeout(() => {
						this.disconnectGraceTimer = null;
						if (myEpoch !== this.launchEpoch || this.stoppingIntentionally) return;
						if (this.snapshot.status === "connected") {
							this.snapshot.status = "starting";
							this.snapshot.statusDetail = "Reconnexion AGY…";
							this.emit();
							this.armStallWatchdog(myEpoch);
						}
					}, TRANSIENT_DISCONNECT_GRACE_MS);
				}
			}
		}

		if (sawAuthLoss && !this.stoppingIntentionally) {
			this.scheduleAutoReconnect("Jeton AGY expiré — resynchronisation auto", true);
			return;
		}

		if (changed) {
			this.emit();
		}
	}

	/**
	 * Connects to the running Antigravity Desktop Hub when available; otherwise starts
	 * SlideFlow's managed `agy remote-control serve` fallback daemon with auto-reconnection.
	 */
	public async start(options?: { forceReseed?: boolean }): Promise<void> {
		this.stoppingIntentionally = false;
		this.clearReconnectTimer();
		this.ensureHealthMonitorRunning();

		// Priority 1: Always prefer the live Antigravity Desktop App Hub (single unified system!)
		const hub = await discoverLiveAntigravityHub(2500);
		if (hub) {
			this.applyHubConnectedState(hub);
			return;
		}

		// Priority 2: Fallback to managed `agy remote-control serve` when Desktop App is not running
		await this.startCliDaemon(options);
	}

	/**
	 * Called on manual "Actualiser" click or pre-flight: re-discovers Hub or heals a
	 * disconnected/stalled/errored AGY server automatically.
	 */
	public async ensureConnected(): Promise<void> {
		const hub = await discoverLiveAntigravityHub(2500);
		if (hub) {
			this.applyHubConnectedState(hub);
			return;
		}

		const cfg = this.getConfig();
		if (this.snapshot.backendMode === "hub") {
			this.activeHub = null;
			this.snapshot.hubPort = null;
			this.snapshot.pid = null;
		}

		const cliAlive = this.child !== null && this.child.exitCode === null && !this.child.killed;
		if (!cliAlive && !this.startInFlight && cfg.autoStart) {
			this.clearReconnectTimer();
			await this.startCliDaemon({ forceReseed: !isDaemonTokenFileUsable() });
		} else if (cliAlive && this.snapshot.status !== "connected") {
			await this.restart();
		}
	}

	private async startCliDaemon(options?: { forceReseed?: boolean }): Promise<void> {
		if (
			(this.child && this.child.exitCode === null && !this.child.killed) ||
			this.startInFlight
		) {
			return;
		}

		const myEpoch = ++this.launchEpoch;
		this.startInFlight = true;
		this.stoppingIntentionally = false;
		this.activeHub = null;

		const cfg = this.getConfig();
		const proj = resolveAgyProjectInfo(cfg.projectName, this.getVaultBasePath());
		const hostname = (cfg.serverName || "").trim() || getDefaultAgyServerName();

		this.snapshot.backendMode = "cli-daemon";
		this.snapshot.hubPort = null;
		this.snapshot.projectName = proj.name || cfg.projectName || "Obsidian";
		this.snapshot.projectId = proj.id || null;
		this.snapshot.hostname = hostname;
		this.snapshot.companionOrigin = "https://antigravity.google.com";
		this.snapshot.instanceId = readPersistentDaemonInstanceId();

		let resolvedExe: string;
		try {
			const exeToken = extractAgyExecutableFromTemplate(cfg.cliCommandTemplate);
			resolvedExe = resolveExecutablePath(exeToken);
		} catch (err: any) {
			this.startInFlight = false;
			this.snapshot.status = "error";
			this.snapshot.statusDetail = null;
			this.snapshot.lastError = err?.message || String(err);
			this.emit();
			return;
		}

		try {
			syncCliRemoteControlHostname(hostname);
		} catch (err: any) {
			console.error("[SlideFlow AGY Server] Failed to sync cliRemoteControlHostname:", err);
		}

		this.snapshot.status = "starting";
		this.snapshot.statusDetail = "Préparation du serveur AGY…";
		this.snapshot.lastError = null;
		this.emit();

		await this.cleanupStaleManagedPid();
		if (myEpoch !== this.launchEpoch) {
			this.startInFlight = false;
			return;
		}

		await this.stopCompetingOfficialDaemon(resolvedExe);
		if (myEpoch !== this.launchEpoch) {
			this.startInFlight = false;
			return;
		}

		let seededThisLaunch = false;
		if (options?.forceReseed || !isDaemonTokenFileUsable()) {
			this.snapshot.statusDetail = "Synchronisation du jeton AGY…";
			this.emit();
			const seed = await this.seedDaemonToken(resolvedExe, hostname);
			if (myEpoch !== this.launchEpoch) {
				this.startInFlight = false;
				return;
			}
			if (!seed.ok) {
				this.startInFlight = false;
				if (seed.signedOut) {
					this.snapshot.status = "error";
					this.snapshot.statusDetail = null;
					this.snapshot.lastError = seed.error;
					this.emit();
					return;
				}
				// Transient network/sync failure -> auto-retry with backoff!
				this.snapshot.lastError = seed.error;
				this.scheduleAutoReconnect("Reprise après échec synchro jeton", true);
				return;
			}
			seededThisLaunch = true;
		}

		this.spawnServeProcess(resolvedExe, hostname, myEpoch, seededThisLaunch);
	}

	private spawnServeProcess(
		resolvedExe: string,
		hostname: string,
		myEpoch: number,
		alreadySeeded: boolean
	): void {
		if (myEpoch !== this.launchEpoch) {
			this.startInFlight = false;
			return;
		}

		const logPath = this.getServerLogPath();
		try {
			fs.writeFileSync(logPath, "", "utf8");
		} catch (err: any) {
			this.startInFlight = false;
			this.snapshot.status = "error";
			this.snapshot.statusDetail = null;
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
		this.startInFlight = false;
		this.snapshot.backendMode = "cli-daemon";
		this.snapshot.status = "starting";
		this.snapshot.statusDetail = "Connexion AGY…";
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
		this.armStallWatchdog(myEpoch);

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
			this.clearAllCliTimers();
			this.snapshot.pid = null;
			if (!this.stoppingIntentionally && myEpoch === this.launchEpoch) {
				this.snapshot.lastError = err.message;
				this.scheduleAutoReconnect("Erreur processus AGY — relance auto", false);
			}
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			const wasOurs = this.child === child;
			if (wasOurs) {
				this.child = null;
				this.clearAllCliTimers();
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
			if (this.stoppingIntentionally || myEpoch !== this.launchEpoch) {
				if (this.snapshot.backendMode !== "hub") {
					this.snapshot.status = "stopped";
					this.snapshot.statusDetail = null;
					this.snapshot.lastError = null;
					this.emit();
				}
				return;
			}

			const isAuthExit = code === 3 || /not signed in/i.test(stderrTail);
			if (isAuthExit && !alreadySeeded) {
				this.startInFlight = true;
				this.snapshot.status = "starting";
				this.snapshot.statusDetail = "Resynchronisation du jeton AGY…";
				this.snapshot.lastError = null;
				this.emit();

				void this.seedDaemonToken(resolvedExe, hostname).then((seed) => {
					if (myEpoch !== this.launchEpoch || this.stoppingIntentionally) {
						this.startInFlight = false;
						return;
					}
					if (!seed.ok) {
						this.startInFlight = false;
						if (seed.signedOut) {
							this.snapshot.status = "error";
							this.snapshot.statusDetail = null;
							this.snapshot.lastError = seed.error;
							this.emit();
							return;
						}
						this.snapshot.lastError = seed.error;
						this.scheduleAutoReconnect("Reprise synchro jeton AGY", true);
						return;
					}
					this.spawnServeProcess(resolvedExe, hostname, myEpoch, true);
				});
				return;
			}

			if (isAuthExit && alreadySeeded) {
				this.snapshot.status = "error";
				this.snapshot.statusDetail = null;
				this.snapshot.lastError =
					"Non connecté à AGY : ouvrez un terminal, lancez « agy » pour vous connecter, puis cliquez sur Démarrer.";
				this.emit();
				return;
			}

			// Any other unexpected crash/disconnect -> automatic exponential-backoff reconnect!
			const detail = stderrTail.trim().replace(/\s+/g, " ").slice(0, 100);
			this.snapshot.lastError = detail
				? `Déconnexion (${code ?? signal ?? "?"}): ${detail}`
				: `Déconnexion serveur AGY (code ${code ?? signal ?? "?"})`;
			this.scheduleAutoReconnect("Reconnexion auto AGY", !isDaemonTokenFileUsable());
		});

		this.clearAllCliTimers();
		this.armStallWatchdog(myEpoch);
		this.pollTimer = setInterval(() => {
			this.pollServerLog(myEpoch);
		}, CLI_LOG_POLL_INTERVAL_MS);
	}

	public stop(): void {
		this.launchEpoch++;
		this.stoppingIntentionally = true;
		this.startInFlight = false;
		this.clearReconnectTimer();
		this.stopHealthMonitor();
		this.killCliChildOnly();
		this.activeHub = null;

		this.snapshot.status = "stopped";
		this.snapshot.backendMode = "none";
		this.snapshot.statusDetail = null;
		this.snapshot.pid = null;
		this.snapshot.hubPort = null;
		this.snapshot.lastError = null;
		this.snapshot.reconnectAttempt = 0;
		this.emit();
	}

	public async restart(): Promise<void> {
		this.launchEpoch++;
		this.stoppingIntentionally = true;
		this.startInFlight = false;
		this.clearReconnectTimer();
		this.killCliChildOnly();
		this.activeHub = null;
		this.reconnectAttempt = 0;

		const epochAfterStop = this.launchEpoch;
		await new Promise((r) => setTimeout(r, 350));
		if (this.launchEpoch !== epochAfterStop) return;
		await this.start({ forceReseed: true });
	}
}
