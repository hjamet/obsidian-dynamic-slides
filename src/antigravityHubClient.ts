/**
 * antigravityHubClient.ts — Direct HTTP+JSON client for the running Antigravity Desktop App
 * (`language_server.exe --subclient_type hub`), discovered dynamically via
 * `~/.gemini/antigravity/daemon/hub_<httpPort>.json`.
 *
 * Why this exists:
 * - Launching tasks via standalone `agy -p` spawns an isolated language server in
 *   `~/.gemini/antigravity-cli`, completely disconnected from the running Antigravity Desktop
 *   App (`~/.gemini/antigravity`) and never streaming live inside either the Desktop App or
 *   `agy remote-control serve` (which only sees stale disk snapshots).
 * - Talking directly to the running Antigravity Hub via `product.v1.ConversationService`
 *   creates and runs every SlideFlow `/one-shot` conversation natively inside the configured
 *   project (`Obsidian`), streaming live in both the Desktop App and its single Remote Control
 *   instance (`eustache-radiant-flare` / `<installation_uuid>-v2`), with zero 32 KB Windows
 *   CLI argument cap and zero extra Remote Control instances.
 */

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { isPidAlive } from "./activeJobsTracker";

export interface AntigravityHubInfo {
	pid: number;
	httpPort: number;
	httpsPort: number;
	csrfToken: string;
	lsVersion: string;
	remoteControlEnabled: boolean;
	instanceId: string | null;
	companionOrigin: string;
	hostname: string;
}

export interface HubCreatedConversation {
	conversationId: string;
	projectId: string;
	runState: string;
	instanceId: string | null;
	hubPort: number;
	hubPid: number;
}

export interface HubConversationStatus {
	id: string;
	projectId: string | null;
	runState: string;
	summary: string;
	updateTime: string | null;
}

export interface HubTranscriptProgress {
	liveStep: string | null;
	stepIndex: number;
	terminalState: "running" | "done" | "error" | "canceled" | "unknown";
	errorDetail: string | null;
	hasAgentResponse: boolean;
}

export interface HubMonitorOptions {
	conversationId: string;
	expectedProjectId: string;
	initialHub: AntigravityHubInfo;
	onStepUpdate?: (stepLabel: string, stepIndex: number) => void;
	onHubUpdated?: (hub: AntigravityHubInfo) => void;
	pollIntervalMs?: number;
	isStopped?: () => boolean;
}

export interface HubMonitorResult {
	exitCode: number;
	conversationId: string;
	projectId: string;
	instanceId: string | null;
	streamError: string | null;
	aborted?: boolean;
}

const KNOWN_MODEL_ALIASES: Record<string, string> = {
	"orchestrator (neon)": "gemini-pro-orchestrator-neon",
	"orchestrator (carbon)": "gemini-pro-orchestrator",
	"orchestrator (argon)": "gemini-pro-orchestrator-argon",
	"gpt-oss 120b (medium)": "gpt-oss-120b-medium",
};

function canonicalModelKey(value: string): string {
	return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Converts a CLI/display model label (e.g. "Gemini 4 Neon (XHigh)", "Claude Opus 5.5 (High)",
 * "Gemini 3.8 Flash (High)") or an already-normalized model ID into the slug expected by
 * `product.v1.ConversationService/CreateConversation`.
 */
export function normalizeHubModelId(rawModel: string | null | undefined): string | null {
	const trimmed = (rawModel || "").trim();
	if (!trimmed) return null;

	const low = trimmed.toLowerCase();
	if (KNOWN_MODEL_ALIASES[low]) {
		return KNOWN_MODEL_ALIASES[low];
	}

	// Already looks like a tier alias or API model slug (no spaces, no parens)
	if (/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
		return trimmed;
	}

	let slug = low
		.replace(/[()]/g, " ")
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	// Antigravity API keeps dots in `gemini-3.8-*` / `gemini-3.5-*` but dashes in `claude-*-5-5-*`
	if (slug.startsWith("claude-")) {
		slug = slug.replace(/\./g, "-");
	}

	return slug || null;
}

function getAntigravityAppDataDir(): string {
	return path.join(os.homedir(), ".gemini", "antigravity");
}

export function readDesktopRemoteControlHostname(): string {
	const configPath = path.join(os.homedir(), ".gemini", "config", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
			const host = parsed?.userSettings?.remoteControlHostname;
			if (typeof host === "string" && host.trim()) {
				return host.trim();
			}
		}
	} catch {
		// Fall through to OS hostname
	}
	return os.hostname() || "antigravity-desktop";
}

export function readDesktopInstallationInstanceId(): string | null {
	const statePath = path.join(getAntigravityAppDataDir(), "antigravity_state.pbtxt");
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

function hubHttpPost(
	port: number,
	csrfToken: string,
	apiPath: string,
	body: Record<string, any>,
	timeoutMs: number = 8000
): Promise<{ status: number; text: string; json: any }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: apiPath,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					"x-antigravity-csrf-token": csrfToken,
					"Content-Length": String(Buffer.byteLength(payload, "utf8")),
				},
				timeout: timeoutMs,
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.on("end", () => {
					let json: any = null;
					try {
						json = text ? JSON.parse(text) : null;
					} catch {
						json = null;
					}
					resolve({ status: res.statusCode ?? 0, text, json });
				});
			}
		);

		req.on("timeout", () => {
			req.destroy(new Error(`Antigravity Hub HTTP timeout (${timeoutMs}ms) on ${apiPath}`));
		});
		req.on("error", (err: Error) => {
			reject(err);
		});
		req.write(payload);
		req.end();
	});
}

/**
 * Discovers the currently running Antigravity Desktop App Hub (`language_server.exe --subclient_type hub`)
 * by reading `~/.gemini/antigravity/daemon/hub_*.json`, filtering immediately via `isPidAlive(pid)`
 * (safe `process.kill(pid, 0)` in Node/libuv), and verifying HTTP readiness via `GetRemoteControlInfo`.
 */
export async function discoverLiveAntigravityHub(
	timeoutMs: number = 2500
): Promise<AntigravityHubInfo | null> {
	const daemonDir = path.join(getAntigravityAppDataDir(), "daemon");
	if (!fs.existsSync(daemonDir)) {
		return null;
	}

	let entries: Array<{ filePath: string; mtimeMs: number }> = [];
	try {
		entries = fs
			.readdirSync(daemonDir)
			.filter((name) => /^hub_\d+\.json$/i.test(name))
			.map((name) => {
				const filePath = path.join(daemonDir, name);
				try {
					return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
				} catch {
					return null;
				}
			})
			.filter((e): e is { filePath: string; mtimeMs: number } => e !== null)
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return null;
	}

	const fallbackInstanceId = readDesktopInstallationInstanceId();
	const hostname = readDesktopRemoteControlHostname();

	for (const entry of entries) {
		let parsed: any;
		try {
			parsed = JSON.parse(fs.readFileSync(entry.filePath, "utf8"));
		} catch {
			continue;
		}
		const pid = Number(parsed?.pid);
		const httpPort = Number(parsed?.httpPort);
		const httpsPort = Number(parsed?.httpsPort) || 0;
		const csrfToken = typeof parsed?.csrfToken === "string" ? parsed.csrfToken.trim() : "";
		const lsVersion = typeof parsed?.lsVersion === "string" ? parsed.lsVersion.trim() : "";

		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(httpPort) || httpPort <= 0 || !csrfToken) {
			continue;
		}
		if (!isPidAlive(pid)) {
			continue;
		}

		try {
			const rc = await hubHttpPost(
				httpPort,
				csrfToken,
				"/exa.language_server_pb.LanguageServerService/GetRemoteControlInfo",
				{},
				timeoutMs
			);
			if (rc.status === 200 && rc.json && typeof rc.json === "object") {
				const instanceId =
					typeof rc.json.instanceId === "string" && rc.json.instanceId.trim()
						? rc.json.instanceId.trim()
						: fallbackInstanceId;
				const companionOrigin =
					typeof rc.json.companionOrigin === "string" && rc.json.companionOrigin.trim()
						? rc.json.companionOrigin.trim().replace(/\/+$/, "")
						: "https://antigravity.google.com";
				return {
					pid,
					httpPort,
					httpsPort,
					csrfToken,
					lsVersion,
					remoteControlEnabled: Boolean(rc.json.enabled),
					instanceId,
					companionOrigin,
					hostname,
				};
			}
		} catch {
			// Candidate hub is unresponsive or restarting; try next candidate
		}
	}

	return null;
}

function matchAvailableModelFromError(
	requestedModel: string,
	errorMessage: string
): string | null {
	const m = errorMessage.match(/available models:\s*([^()]+)/i);
	if (!m || !m[1]) return null;
	const candidates = m[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const targetKey = canonicalModelKey(requestedModel);
	if (!targetKey) return null;
	for (const cand of candidates) {
		if (canonicalModelKey(cand) === targetKey) {
			return cand;
		}
	}
	return null;
}

/**
 * Creates and launches a conversation directly inside the running Antigravity Desktop App Hub.
 * Fail-Fast: refuses to launch without an explicit `projectId` and verifies that the created
 * conversation's `metadata.projectId` matches the requested project.
 */
export async function createHubConversation(
	hub: AntigravityHubInfo,
	params: {
		projectId: string;
		title?: string;
		model?: string | null;
		prompt: string;
		tags?: string[];
	}
): Promise<HubCreatedConversation> {
	const projectId = (params.projectId || "").trim();
	if (!projectId) {
		throw new Error(
			"Impossible de lancer la conversation : aucun projectId Antigravity résolu (refus Fail-Fast de démarrer hors projet)."
		);
	}

	let modelId = normalizeHubModelId(params.model);

	const submit = async (selectedModel: string | null) => {
		const body: Record<string, any> = {
			projectId,
			prompt: [{ text: params.prompt }],
		};
		if (params.title && params.title.trim()) {
			body.title = params.title.trim();
		}
		if (selectedModel) {
			body.model = selectedModel;
		}
		if (params.tags && params.tags.length > 0) {
			body.tags = params.tags;
		}
		return hubHttpPost(
			hub.httpPort,
			hub.csrfToken,
			"/product.v1.ConversationService/CreateConversation",
			body,
			20_000
		);
	};

	let resp = await submit(modelId);

	// If model slug slightly differs from server catalog, resolve exact canonical match once
	if (resp.status === 400 && modelId && resp.json?.message) {
		const matched = matchAvailableModelFromError(modelId, String(resp.json.message));
		if (matched && matched !== modelId) {
			modelId = matched;
			resp = await submit(modelId);
		}
	}

	if (resp.status !== 200 || !resp.json?.conversation?.id) {
		const detail = resp.json?.message || resp.text || `HTTP ${resp.status}`;
		throw new Error(`Antigravity Hub CreateConversation failed (${resp.status}): ${detail}`);
	}

	const conv = resp.json.conversation;
	const createdId = String(conv.id).trim();
	const actualProjectId = String(conv.metadata?.projectId || "").trim();
	if (actualProjectId && actualProjectId !== projectId) {
		throw new Error(
			`Projet incohérent retourné par Antigravity Hub : attendu "${projectId}", reçu "${actualProjectId}".`
		);
	}

	return {
		conversationId: createdId,
		projectId: actualProjectId || projectId,
		runState: String(conv.state?.runState || "RUN_STATE_RUNNING"),
		instanceId: hub.instanceId,
		hubPort: hub.httpPort,
		hubPid: hub.pid,
	};
}

export async function getHubConversation(
	hub: AntigravityHubInfo,
	conversationId: string
): Promise<HubConversationStatus | null> {
	const resp = await hubHttpPost(
		hub.httpPort,
		hub.csrfToken,
		"/product.v1.ConversationService/GetConversation",
		{ conversationId },
		6000
	);
	if (resp.status === 404) {
		return null;
	}
	if (resp.status !== 200 || !resp.json) {
		const detail = resp.json?.message || resp.text || `HTTP ${resp.status}`;
		throw new Error(`GetConversation failed (${resp.status}): ${detail}`);
	}
	return {
		id: String(resp.json.id || conversationId),
		projectId: resp.json.metadata?.projectId ? String(resp.json.metadata.projectId) : null,
		runState: String(resp.json.state?.runState || ""),
		summary: String(resp.json.state?.summary || ""),
		updateTime: resp.json.state?.updateTime ? String(resp.json.state.updateTime) : null,
	};
}

function formatToolStepLabel(toolName: string, stepIndex: number): string {
	const suffix = stepIndex > 0 ? ` · #${stepIndex}` : "";
	let icon = "🔧";
	if (/read_file|view_file|list_dir|find_by_name|grep/i.test(toolName)) icon = "📖";
	else if (/edit|write|replace/i.test(toolName)) icon = "✏️";
	else if (/search_web|read_url/i.test(toolName)) icon = "🔍";
	else if (/mcp/i.test(toolName)) icon = "🔌";
	else if (/subagent/i.test(toolName)) icon = "🤖";
	return `${icon} ${toolName}${suffix}`;
}

/**
 * Inspects the tail of `~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl`
 * to display crisp live step labels and detect cancellations/errors cleanly.
 */
export function readHubConversationLiveProgress(conversationId: string): HubTranscriptProgress {
	const transcriptPath = path.join(
		getAntigravityAppDataDir(),
		"brain",
		conversationId,
		".system_generated",
		"logs",
		"transcript.jsonl"
	);
	if (!fs.existsSync(transcriptPath)) {
		return {
			liveStep: null,
			stepIndex: 0,
			terminalState: "unknown",
			errorDetail: null,
			hasAgentResponse: false,
		};
	}

	let chunk = "";
	try {
		const stat = fs.statSync(transcriptPath);
		const readLen = Math.min(stat.size, 32_768);
		if (readLen <= 0) {
			return {
				liveStep: null,
				stepIndex: 0,
				terminalState: "unknown",
				errorDetail: null,
				hasAgentResponse: false,
			};
		}
		const fd = fs.openSync(transcriptPath, "r");
		try {
			const buf = Buffer.alloc(readLen);
			fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
			chunk = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return {
			liveStep: null,
			stepIndex: 0,
			terminalState: "unknown",
			errorDetail: null,
			hasAgentResponse: false,
		};
	}

	const rawLines = chunk.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
	let lastObj: any = null;
	let lastStepIndex = 0;
	let lastLiveStep: string | null = null;
	let hasAgentResponse = false;

	for (const line of rawLines) {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		lastObj = obj;
		const idx = typeof obj.step_index === "number" ? obj.step_index : lastStepIndex;
		if (idx > lastStepIndex) lastStepIndex = idx;

		const type = String(obj.type || "").toUpperCase();
		const status = String(obj.status || "").toUpperCase();

		if (type === "PLANNER_RESPONSE") {
			hasAgentResponse = true;
			const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
			const lastTool = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;
			if (lastTool && typeof lastTool.name === "string" && lastTool.name) {
				lastLiveStep = formatToolStepLabel(lastTool.name, idx);
			} else if (status === "RUNNING") {
				lastLiveStep = `💬 Réponse en cours…${idx > 0 ? ` · #${idx}` : ""}`;
			} else {
				lastLiveStep = `💭 Analyse…${idx > 0 ? ` · #${idx}` : ""}`;
			}
		} else if (type === "USER_INPUT") {
			if (!lastLiveStep) {
				lastLiveStep = "🚀 Prompt envoyé (Obsidian)";
			}
		}
	}

	if (!lastObj) {
		return {
			liveStep: null,
			stepIndex: 0,
			terminalState: "unknown",
			errorDetail: null,
			hasAgentResponse: false,
		};
	}

	const lastStatus = String(lastObj.status || "").toUpperCase();
	const lastType = String(lastObj.type || "").toUpperCase();

	let terminalState: HubTranscriptProgress["terminalState"] = "unknown";
	let errorDetail: string | null = null;

	if (lastStatus === "RUNNING" || lastStatus === "PENDING") {
		terminalState = "running";
	} else if (lastStatus === "CANCELED" || lastStatus === "CANCELLED") {
		terminalState = "canceled";
		errorDetail = "Conversation annulée dans Antigravity";
	} else if (lastStatus === "ERROR" || lastStatus === "FAILED") {
		terminalState = "error";
		errorDetail =
			typeof lastObj.error === "string" && lastObj.error.trim()
				? lastObj.error.trim()
				: "Erreur pendant l'exécution dans Antigravity";
	} else if (lastStatus === "DONE" && (lastType === "PLANNER_RESPONSE" || hasAgentResponse)) {
		terminalState = "done";
	}

	return {
		liveStep: lastLiveStep,
		stepIndex: lastStepIndex,
		terminalState,
		errorDetail,
		hasAgentResponse,
	};
}

/**
 * Monitors a Hub-hosted conversation until it reaches `RUN_STATE_IDLE` (surviving Hub
 * port changes / restarts via automatic re-discovery).
 */
export async function monitorHubConversation(
	options: HubMonitorOptions
): Promise<HubMonitorResult> {
	const pollMs = Math.max(1000, options.pollIntervalMs ?? 2500);
	let currentHub = options.initialHub;
	let consecutiveHubErrors = 0;
	let lastStepLabel = "";
	let idleConfirmCount = 0;

	while (true) {
		if (options.isStopped?.()) {
			return {
				exitCode: 0,
				conversationId: options.conversationId,
				projectId: options.expectedProjectId,
				instanceId: currentHub.instanceId,
				streamError: null,
				aborted: true,
			};
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		if (options.isStopped?.()) {
			return {
				exitCode: 0,
				conversationId: options.conversationId,
				projectId: options.expectedProjectId,
				instanceId: currentHub.instanceId,
				streamError: null,
				aborted: true,
			};
		}

		let conv: HubConversationStatus | null = null;
		try {
			conv = await getHubConversation(currentHub, options.conversationId);
			consecutiveHubErrors = 0;
		} catch (err: any) {
			// Hub may have auto-restarted on a new port — try re-discovering seamlessly!
			const rediscovered = await discoverLiveAntigravityHub(2500);
			if (rediscovered) {
				currentHub = rediscovered;
				options.onHubUpdated?.(rediscovered);
				try {
					conv = await getHubConversation(currentHub, options.conversationId);
					consecutiveHubErrors = 0;
				} catch {
					consecutiveHubErrors++;
				}
			} else {
				consecutiveHubErrors++;
			}

			if (consecutiveHubErrors >= 6) {
				return {
					exitCode: 1,
					conversationId: options.conversationId,
					projectId: options.expectedProjectId,
					instanceId: currentHub.instanceId,
					streamError: `Antigravity Hub injoignable pendant le suivi (${err?.message || "connexion perdue"})`,
				};
			}
			continue;
		}

		if (!conv) {
			return {
				exitCode: 1,
				conversationId: options.conversationId,
				projectId: options.expectedProjectId,
				instanceId: currentHub.instanceId,
				streamError: "Conversation introuvable ou supprimée dans Antigravity Hub",
			};
		}

		const progress = readHubConversationLiveProgress(options.conversationId);
		if (progress.liveStep && progress.liveStep !== lastStepLabel) {
			lastStepLabel = progress.liveStep;
			options.onStepUpdate?.(progress.liveStep, progress.stepIndex);
		}

		if (conv.runState === "RUN_STATE_RUNNING" || conv.runState === "RUN_STATE_CANCELLING") {
			idleConfirmCount = 0;
			continue;
		}

		if (conv.runState === "RUN_STATE_IDLE") {
			idleConfirmCount++;
			// If transcript hasn't flushed yet on the very first instant after creation, wait 1 extra tick
			if (!progress.hasAgentResponse && idleConfirmCount < 2) {
				continue;
			}

			if (progress.terminalState === "canceled" || progress.terminalState === "error") {
				return {
					exitCode: 1,
					conversationId: options.conversationId,
					projectId: conv.projectId || options.expectedProjectId,
					instanceId: currentHub.instanceId,
					streamError: progress.errorDetail || "Conversation interrompue dans Antigravity",
				};
			}

			return {
				exitCode: 0,
				conversationId: options.conversationId,
				projectId: conv.projectId || options.expectedProjectId,
				instanceId: currentHub.instanceId,
				streamError: null,
			};
		}
	}
}
