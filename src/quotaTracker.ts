/**
 * quotaTracker.ts — Live AI Quota Indicators for the SlideFlow AGY Sidebar:
 *
 * Fetches real-time quotas directly from official endpoints (zero local estimation):
 * 1. Antigravity Gemini & Antigravity Claude via `agy --output-format json -p /usage`
 * 2. Claude Code (Opus) via Anthropic OAuth (`~/.claude/.credentials.json` +
 *    `https://api.anthropic.com/api/oauth/usage`, with automatic token refresh using
 *    `User-Agent: axios/1.7.9` to avoid Cloudflare 429 on `claude-code/*`).
 *
 * Evaluates each bucket against the weekly linear pace target (96% used by reset time)
 * and refreshes automatically on Obsidian startup, whenever any `agy` conversation ends,
 * or on manual click in the sidebar.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { resolveExecutablePath } from "./cliRunner";

export type QuotaVerdict = "pause" | "use_more" | "optimal" | "use_less" | "unavailable";

export interface QuotaEntry {
	id: "antigravity_gemini" | "antigravity_claude" | "claude_code_opus";
	label: string;
	verdict: QuotaVerdict;
	verdictBadge: string;
	remaining7dPct: number | null;
	targetRemaining7dPct: number | null;
	remaining5hPct: number | null;
	reset7dIso: string | null;
	reset5hIso: string | null;
	deltaPct: number | null;
	error: string | null;
}

export interface QuotaSnapshot {
	loading: boolean;
	updatedAt: string | null;
	entries: QuotaEntry[];
}

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_USER_AGENT = "axios/1.7.9";

function extractAgyExecutable(template: string): string {
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

function evalQuotaBucket(
	used5h: number,
	used7d: number,
	remHours7d: number
): { targetUsedPct: number; targetRemPct: number; deltaPct: number; verdict: QuotaVerdict; verdictBadge: string } {
	const elapsedFraction = Math.max(0, Math.min(1, (168 - remHours7d) / 168));
	const targetUsedPct = 96 * elapsedFraction;
	const targetRemPct = 100 - targetUsedPct;
	const deltaPct = used7d - targetUsedPct;

	if (used5h >= 85 || used7d >= 96) {
		return { targetUsedPct, targetRemPct, deltaPct, verdict: "pause", verdictBadge: "Pause" };
	}
	if (used7d === 0 || deltaPct < -8) {
		return { targetUsedPct, targetRemPct, deltaPct, verdict: "use_more", verdictBadge: "Utiliser +" };
	}
	if (deltaPct >= -8 && deltaPct <= 8) {
		return { targetUsedPct, targetRemPct, deltaPct, verdict: "optimal", verdictBadge: "Optimal" };
	}
	return { targetUsedPct, targetRemPct, deltaPct, verdict: "use_less", verdictBadge: "Utiliser −" };
}

function unavailableEntry(
	id: QuotaEntry["id"],
	label: string,
	error: string
): QuotaEntry {
	return {
		id,
		label,
		verdict: "unavailable",
		verdictBadge: "Indispo",
		remaining7dPct: null,
		targetRemaining7dPct: null,
		remaining5hPct: null,
		reset7dIso: null,
		reset5hIso: null,
		deltaPct: null,
		error,
	};
}

function runAgyUsageCommand(cliTemplate: string): Promise<any> {
	return new Promise((resolve, reject) => {
		let exe: string;
		try {
			exe = resolveExecutablePath(extractAgyExecutable(cliTemplate));
		} catch (err) {
			reject(err);
			return;
		}

		const child = spawn(exe, ["--output-format", "json", "-p", "/usage"], {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill();
			} catch {
				// ignore kill race
			}
			reject(new Error("Timeout (15s) sur `agy -p /usage`"));
		}, 15_000);

		child.stdout?.on("data", (buf: Buffer) => {
			stdout += buf.toString("utf8");
		});
		child.stderr?.on("data", (buf: Buffer) => {
			stderr += buf.toString("utf8");
		});
		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`agy -p /usage exit ${code}: ${(stderr || stdout).trim().slice(0, 140)}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (err: any) {
				reject(new Error(`JSON invalide de agy /usage : ${err?.message || String(err)}`));
			}
		});
	});
}

function httpsJsonRequest(
	urlStr: string,
	options: {
		method?: "GET" | "POST";
		headers?: Record<string, string>;
		body?: string;
		timeoutMs?: number;
	} = {}
): Promise<{ statusCode: number; data: any; rawText: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const req = https.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search}`,
				method: options.method || "GET",
				headers: options.headers || {},
			},
			(res) => {
				let rawText = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					rawText += chunk;
				});
				res.on("end", () => {
					const statusCode = res.statusCode ?? 0;
					let data: any = null;
					try {
						data = rawText ? JSON.parse(rawText) : null;
					} catch {
						data = null;
					}
					resolve({ statusCode, data, rawText });
				});
			}
		);

		req.setTimeout(options.timeoutMs ?? 12_000, () => {
			req.destroy(new Error("Délai réseau dépassé"));
		});
		req.on("error", (err) => reject(err));
		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

async function refreshClaudeOAuthToken(credPath: string, credData: any): Promise<string> {
	const oauth = credData?.claudeAiOauth || {};
	const refreshToken = oauth.refreshToken;
	if (!refreshToken) {
		throw new Error("Session Claude Code expirée (exécuter 'claude auth login').");
	}
	const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : String(oauth.scopes || "");
	const payload = JSON.stringify({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		scope: scopes,
	});

	const resp = await httpsJsonRequest("https://platform.claude.com/v1/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_USER_AGENT,
			Accept: "application/json",
			"Content-Length": String(Buffer.byteLength(payload, "utf8")),
		},
		body: payload,
		timeoutMs: 15_000,
	});

	if (resp.statusCode === 429) {
		throw new Error("OAuth Anthropic rate-limité (HTTP 429)");
	}
	if (resp.statusCode === 400 || resp.statusCode === 401) {
		throw new Error("Session Claude Code expirée (exécuter 'claude auth login')");
	}
	if (resp.statusCode !== 200 || !resp.data?.access_token) {
		throw new Error(`Échec refresh OAuth Claude (HTTP ${resp.statusCode})`);
	}

	oauth.accessToken = resp.data.access_token;
	if (resp.data.refresh_token) {
		oauth.refreshToken = resp.data.refresh_token;
	}
	if (typeof resp.data.expires_in === "number") {
		oauth.expiresAt = Date.now() + resp.data.expires_in * 1000;
	}
	credData.claudeAiOauth = oauth;
	fs.writeFileSync(credPath, JSON.stringify(credData, null, 2), "utf8");
	return oauth.accessToken;
}

async function fetchAgyQuotaEntries(cliTemplate: string, nowMs: number): Promise<[QuotaEntry, QuotaEntry]> {
	try {
		const payload = await runAgyUsageCommand(cliTemplate);
		const groups: any[] = payload?.command?.data?.groups || [];
		const geminiGroup = groups.find((g) => g?.name === "Gemini Models");
		const claudeGroup = groups.find((g) => g?.name === "Claude and GPT models");

		const buildEntry = (
			id: "antigravity_gemini" | "antigravity_claude",
			label: string,
			group: any
		): QuotaEntry => {
			if (!group || !Array.isArray(group.buckets)) {
				return unavailableEntry(id, label, `Groupe absent de agy /usage`);
			}
			const bW = group.buckets.find((b: any) => b?.window === "weekly");
			const b5 = group.buckets.find((b: any) => b?.window === "5h");
			if (!bW || !b5 || typeof bW.remaining_fraction !== "number" || typeof b5.remaining_fraction !== "number") {
				return unavailableEntry(id, label, "Buckets weekly/5h absents");
			}
			const rem7d = bW.remaining_fraction * 100;
			const used7d = 100 - rem7d;
			const rem5h = b5.remaining_fraction * 100;
			const used5h = 100 - rem5h;
			const reset7dIso = typeof bW.reset_time === "string" ? bW.reset_time : null;
			const reset5hIso = typeof b5.reset_time === "string" ? b5.reset_time : null;
			const rstMs = reset7dIso ? Date.parse(reset7dIso) : NaN;
			const remHours7d = Number.isFinite(rstMs) ? Math.max(0, (rstMs - nowMs) / 3_600_000) : 0;
			const ev = evalQuotaBucket(used5h, used7d, remHours7d);

			return {
				id,
				label,
				verdict: ev.verdict,
				verdictBadge: ev.verdictBadge,
				remaining7dPct: rem7d,
				targetRemaining7dPct: ev.targetRemPct,
				remaining5hPct: rem5h,
				reset7dIso,
				reset5hIso,
				deltaPct: ev.deltaPct,
				error: null,
			};
		};

		return [
			buildEntry("antigravity_gemini", "Antigravity Gemini", geminiGroup),
			buildEntry("antigravity_claude", "Antigravity Claude", claudeGroup),
		];
	} catch (err: any) {
		const msg = err?.message || String(err);
		return [
			unavailableEntry("antigravity_gemini", "Antigravity Gemini", msg),
			unavailableEntry("antigravity_claude", "Antigravity Claude", msg),
		];
	}
}

async function fetchClaudeCodeQuotaEntry(nowMs: number): Promise<QuotaEntry> {
	const label = "Claude Code (Opus)";
	const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
	if (!fs.existsSync(credPath)) {
		return unavailableEntry("claude_code_opus", label, "Identifiants ~/.claude/.credentials.json introuvables");
	}

	let credData: any;
	try {
		credData = JSON.parse(fs.readFileSync(credPath, "utf8"));
	} catch (err: any) {
		return unavailableEntry("claude_code_opus", label, `Credentials illisibles: ${err?.message || err}`);
	}

	const oauth = credData?.claudeAiOauth || {};
	let token: string = oauth.accessToken || "";
	const refreshToken: string = oauth.refreshToken || "";
	const expiresAt: number = Number(oauth.expiresAt) || 0;

	if (!token && !refreshToken) {
		return unavailableEntry("claude_code_opus", label, "Non connecté à Claude Code");
	}

	try {
		if (expiresAt > 0 && nowMs >= expiresAt - 60_000) {
			token = await refreshClaudeOAuthToken(credPath, credData);
		}
		if (!token) {
			return unavailableEntry("claude_code_opus", label, "accessToken manquant");
		}

		const queryUsage = (accessToken: string) =>
			httpsJsonRequest("https://api.anthropic.com/api/oauth/usage", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
					"User-Agent": CLAUDE_USER_AGENT,
					Accept: "application/json",
				},
				timeoutMs: 10_000,
			});

		let resp = await queryUsage(token);
		if (resp.statusCode === 401 && refreshToken) {
			token = await refreshClaudeOAuthToken(credPath, credData);
			resp = await queryUsage(token);
		}
		if (resp.statusCode === 429) {
			return unavailableEntry("claude_code_opus", label, "API Claude rate-limitée (HTTP 429)");
		}
		if (resp.statusCode !== 200 || !resp.data) {
			return unavailableEntry("claude_code_opus", label, `HTTP ${resp.statusCode}`);
		}

		const fh = resp.data.five_hour || {};
		const sd = resp.data.seven_day || {};
		if (typeof fh.utilization !== "number" || typeof sd.utilization !== "number" || !sd.resets_at) {
			return unavailableEntry("claude_code_opus", label, "Réponse usage Anthropic incomplète");
		}

		const used5h = Number(fh.utilization);
		const used7d = Number(sd.utilization);
		const rem5h = 100 - used5h;
		const rem7d = 100 - used7d;
		const reset7dIso = String(sd.resets_at);
		const reset5hIso = fh.resets_at ? String(fh.resets_at) : null;
		const rstMs = Date.parse(reset7dIso);
		const remHours7d = Number.isFinite(rstMs) ? Math.max(0, (rstMs - nowMs) / 3_600_000) : 0;
		const ev = evalQuotaBucket(used5h, used7d, remHours7d);

		return {
			id: "claude_code_opus",
			label,
			verdict: ev.verdict,
			verdictBadge: ev.verdictBadge,
			remaining7dPct: rem7d,
			targetRemaining7dPct: ev.targetRemPct,
			remaining5hPct: rem5h,
			reset7dIso,
			reset5hIso,
			deltaPct: ev.deltaPct,
			error: null,
		};
	} catch (err: any) {
		return unavailableEntry("claude_code_opus", label, err?.message || String(err));
	}
}

export class QuotaTracker {
	private getCliCommandTemplate: () => string;
	private listeners: Set<(snap: QuotaSnapshot) => void> = new Set();
	private inflight: Promise<QuotaSnapshot> | null = null;
	private snapshot: QuotaSnapshot = {
		loading: false,
		updatedAt: null,
		entries: [],
	};

	constructor(getCliCommandTemplate: () => string) {
		this.getCliCommandTemplate = getCliCommandTemplate;
	}

	public subscribe(listener: (snap: QuotaSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	public getSnapshot(): QuotaSnapshot {
		return {
			loading: this.snapshot.loading,
			updatedAt: this.snapshot.updatedAt,
			entries: this.snapshot.entries.map((e) => ({ ...e })),
		};
	}

	private emit(): void {
		const snap = this.getSnapshot();
		for (const fn of this.listeners) {
			try {
				fn(snap);
			} catch (err) {
				console.error("[SlideFlow QuotaTracker] Listener error:", err);
			}
		}
	}

	public refresh(): Promise<QuotaSnapshot> {
		if (this.inflight) {
			return this.inflight;
		}
		this.snapshot.loading = true;
		this.emit();

		const cliTemplate = this.getCliCommandTemplate();
		const nowMs = Date.now();

		this.inflight = Promise.all([
			fetchAgyQuotaEntries(cliTemplate, nowMs),
			fetchClaudeCodeQuotaEntry(nowMs),
		])
			.then(([[gemEntry, agyClaudeEntry], claudeCodeEntry]) => {
				this.snapshot = {
					loading: false,
					updatedAt: new Date().toISOString(),
					entries: [gemEntry, agyClaudeEntry, claudeCodeEntry],
				};
				this.emit();
				return this.getSnapshot();
			})
			.catch((err) => {
				console.error("[SlideFlow QuotaTracker] Refresh failed:", err);
				this.snapshot.loading = false;
				this.emit();
				return this.getSnapshot();
			})
			.finally(() => {
				this.inflight = null;
			});

		return this.inflight;
	}
}
