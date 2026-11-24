/**
 * activeJobsTracker.ts — Tracks active, interrupted, and recent SlideFlow CLI (`agy`) jobs in
 * `_agents/slideflow_active_jobs.json` for the dedicated SlideFlow AGY Sidebar View.
 *
 * - Self-healing PID check (`process.kill(pid, 0)`) prevents zombie "running" entries if Obsidian reloads.
 * - Retains finished jobs up to 24h capped at the 5 most recent (while keeping all running jobs and
 *   all failed jobs whose comments are still waiting for retry in ReviewStore).
 * - Cleans up any legacy `<!-- SLIDEFLOW_AGY_JOBS_START --> ... <!-- SLIDEFLOW_AGY_JOBS_END -->`
 *   Markdown block from `🎯 Projets.md` so the project dashboard stays 100% pure.
 */

import { App, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { GENERAL_NOTE_PATH } from "./reviewStore";

export const ACTIVE_JOBS_FILE_PATH = "_agents/slideflow_active_jobs.json";
export const JOBS_BLOCK_START = "<!-- SLIDEFLOW_AGY_JOBS_START -->";
export const JOBS_BLOCK_END = "<!-- SLIDEFLOW_AGY_JOBS_END -->";

const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000; // keep completed/error history for 24h
const MAX_FINISHED_JOBS = 5; // cap non-retryable history at 5 most recent entries

export interface SlideFlowCliJob {
	id: string;
	pid: number | null;
	cli: string;
	model: string;
	status: "running" | "done" | "error";
	startedAt: string;
	finishedAt?: string | null;
	exitCode?: number | null;
	commentCount: number;
	notes: string[];
	logPath?: string | null;
	agyLogPath?: string | null;
	errorSummary?: string | null;
	conversationId?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	liveInstanceId?: string | null;
	liveStep?: string | null;
}

interface ActiveJobsPayload {
	version: number;
	jobs: SlideFlowCliJob[];
}

export function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		if (err && err.code === "EPERM") {
			return true;
		}
		return false;
	}
}

export function extractModelLabelFromCommand(template: string): string {
	const m = template.match(/(?:--?model)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
	if (!m) return "";
	return (m[1] || m[2] || m[3] || "").trim();
}

function getDashboardMatchKeys(dashboardPath: string): Set<string> {
	const norm = (dashboardPath || "🎯 Projets.md").replace(/\\/g, "/").replace(/^\/+/, "").trim();
	const baseWithExt = norm.split("/").pop() || norm;
	const baseNoExt = baseWithExt.replace(/\.md$/i, "");
	const normNoExt = norm.replace(/\.md$/i, "");
	return new Set(
		[norm, normNoExt, baseWithExt, baseNoExt]
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function isDashboardNoteMatch(
	notePathOrTitle: string,
	dashboardPath: string
): boolean {
	if (!notePathOrTitle) return false;
	const keys = getDashboardMatchKeys(dashboardPath);
	const norm = notePathOrTitle.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
	const noExt = norm.replace(/\.md$/i, "");
	return keys.has(norm) || keys.has(noExt);
}

export function orderNotesWithDashboardLast(
	notes: string[],
	dashboardPath: string = "🎯 Projets.md"
): string[] {
	const unique = Array.from(new Set((notes || []).filter(Boolean)));
	const regular: string[] = [];
	const dashboard: string[] = [];
	for (const n of unique) {
		if (isDashboardNoteMatch(n, dashboardPath)) {
			dashboard.push(n);
		} else {
			regular.push(n);
		}
	}
	return [...regular, ...dashboard];
}

export function formatJobNotesLabel(notes: string[], dashboardPath: string = "🎯 Projets.md"): string {
	const ordered = orderNotesWithDashboardLast(notes, dashboardPath);
	if (ordered.length === 0) return "Revue SlideFlow";
	if (ordered.length === 1) return ordered[0];
	return `${ordered[0]} (+${ordered.length - 1} note${ordered.length - 1 > 1 ? "s" : ""})`;
}

export function pruneAndHealJobs(
	jobs: SlideFlowCliJob[],
	nowMs: number = Date.now(),
	protectedBatchIds?: Set<string>
): {
	jobs: SlideFlowCliJob[];
	changed: boolean;
} {
	let changed = false;
	const running: SlideFlowCliJob[] = [];
	const protectedErrors: SlideFlowCliJob[] = [];
	const finishedCandidates: SlideFlowCliJob[] = [];

	for (const job of jobs) {
		const copy: SlideFlowCliJob = { ...job };
		if (copy.status === "running") {
			if (copy.pid && !isPidAlive(copy.pid)) {
				// Fail-Fast: PID vanished without receiving exit code 0 confirmation
				copy.status = "error";
				copy.exitCode = copy.exitCode ?? -1;
				copy.errorSummary =
					copy.errorSummary || `PID ${copy.pid} terminé sans code de succès confirmé`;
				copy.finishedAt = copy.finishedAt || new Date(nowMs).toISOString();
				copy.liveStep = null;
				changed = true;
			}
		}

		if (copy.status === "running") {
			running.push(copy);
			continue;
		}

		if (copy.status === "error" && protectedBatchIds && protectedBatchIds.has(copy.id)) {
			protectedErrors.push(copy);
			continue;
		}

		const finTime = new Date(copy.finishedAt || copy.startedAt).getTime();
		const age = isNaN(finTime) ? Infinity : nowMs - finTime;
		if (age <= FINISHED_RETENTION_MS) {
			finishedCandidates.push(copy);
		} else {
			changed = true;
		}
	}

	finishedCandidates.sort((a, b) => {
		const ta = new Date(a.finishedAt || a.startedAt).getTime() || 0;
		const tb = new Date(b.finishedAt || b.startedAt).getTime() || 0;
		return tb - ta;
	});

	if (finishedCandidates.length > MAX_FINISHED_JOBS) {
		finishedCandidates.length = MAX_FINISHED_JOBS;
		changed = true;
	}

	return {
		jobs: [...running, ...protectedErrors, ...finishedCandidates],
		changed,
	};
}

export class ActiveJobsTracker {
	private app: App;
	private pluginDirRelative: string;
	private writeChain: Promise<void> = Promise.resolve();
	private cachedJobs: SlideFlowCliJob[] = [];
	private listeners: Set<(jobs: SlideFlowCliJob[]) => void> = new Set();
	private protectedIdsProvider: (() => Set<string>) | null = null;

	constructor(app: App, pluginDirRelative: string) {
		this.app = app;
		this.pluginDirRelative = pluginDirRelative;
	}

	public setProtectedBatchIdsProvider(provider: () => Set<string>): void {
		this.protectedIdsProvider = provider;
	}

	private getProtectedBatchIds(): Set<string> | undefined {
		return this.protectedIdsProvider ? this.protectedIdsProvider() : undefined;
	}

	public subscribe(listener: (jobs: SlideFlowCliJob[]) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(jobs: SlideFlowCliJob[]): void {
		this.cachedJobs = jobs.map((j) => ({ ...j, notes: [...(j.notes || [])] }));
		const snap = this.getCachedJobs();
		for (const fn of this.listeners) {
			try {
				fn(snap);
			} catch (err) {
				console.error("[SlideFlow ActiveJobsTracker] Listener error:", err);
			}
		}
	}

	public getCachedJobs(): SlideFlowCliJob[] {
		return this.cachedJobs.map((j) => ({ ...j, notes: [...(j.notes || [])] }));
	}

	private getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as any;
		return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
	}

	public async resolveDashboardVaultPath(): Promise<string> {
		const adapter = this.app.vault.adapter;
		const pmDataPath = ".obsidian/plugins/project-memory/data.json";
		try {
			if (await adapter.exists(pmDataPath)) {
				const raw = await adapter.read(pmDataPath);
				const parsed = JSON.parse(raw);
				const pf = (parsed?.projectFile || "").trim();
				if (pf) {
					const norm = pf.replace(/\\/g, "/").replace(/^\/+/, "");
					return norm.endsWith(".md") ? norm : `${norm}.md`;
				}
			}
		} catch {
			// fallback to default dashboard filename
		}
		return "🎯 Projets.md";
	}

	/**
	 * Removes any legacy `<!-- SLIDEFLOW_AGY_JOBS_START --> ... <!-- SLIDEFLOW_AGY_JOBS_END -->`
	 * block from `🎯 Projets.md` now that jobs live cleanly in the dedicated SlideFlow AGY Sidebar.
	 */
	public async stripLegacyDashboardBlock(): Promise<void> {
		const dashboardPath = await this.resolveDashboardVaultPath();
		const targetFile = this.app.vault.getAbstractFileByPath(dashboardPath);
		if (!(targetFile instanceof TFile)) return;

		const original = (await this.app.vault.read(targetFile)).replace(/\r\n/g, "\n");
		const markerRe = new RegExp(
			`\\n?${JOBS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${JOBS_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
			"g"
		);
		if (!markerRe.test(original)) return;

		const cleaned = original.replace(markerRe, "\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
		if (cleaned !== original) {
			await this.app.vault.modify(targetFile, cleaned);
		}
	}

	private async loadJobsRaw(): Promise<SlideFlowCliJob[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(ACTIVE_JOBS_FILE_PATH))) {
			return [];
		}
		try {
			const raw = await adapter.read(ACTIVE_JOBS_FILE_PATH);
			const parsed = JSON.parse(raw) as ActiveJobsPayload;
			return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
		} catch {
			return [];
		}
	}

	private async saveJobsRaw(jobs: SlideFlowCliJob[]): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parentDir = ACTIVE_JOBS_FILE_PATH.split("/").slice(0, -1).join("/");
		if (parentDir && !(await adapter.exists(parentDir))) {
			await adapter.mkdir(parentDir);
		}
		const payload: ActiveJobsPayload = { version: 2, jobs };
		await adapter.write(ACTIVE_JOBS_FILE_PATH, JSON.stringify(payload, null, 2));
	}

	public async orderNotesForJob(
		comments: Array<{
			notePath: string;
			noteTitle?: string;
			stackDepth?: number;
			scopeType?: string;
		}>
	): Promise<string[]> {
		const dashboardPath = await this.resolveDashboardVaultPath();
		const byNote = new Map<
			string,
			{ label: string; isDashboard: boolean; minDepth: number; firstIdx: number }
		>();

		comments.forEach((c, idx) => {
			if (c.scopeType === "general" || c.notePath === GENERAL_NOTE_PATH) return;
			const label = (c.noteTitle || c.notePath || "").trim();
			if (!label) return;
			const key = (c.notePath || label).replace(/\\/g, "/").toLowerCase();
			const isDash =
				isDashboardNoteMatch(c.notePath, dashboardPath) ||
				isDashboardNoteMatch(label, dashboardPath);
			const depth = typeof c.stackDepth === "number" ? c.stackDepth : 999;

			const existing = byNote.get(key);
			if (!existing) {
				byNote.set(key, { label, isDashboard: isDash, minDepth: depth, firstIdx: idx });
			} else if (depth < existing.minDepth) {
				existing.minDepth = depth;
			}
		});

		const sorted = Array.from(byNote.values()).sort((a, b) => {
			if (a.isDashboard !== b.isDashboard) {
				return a.isDashboard ? 1 : -1;
			}
			if (a.minDepth !== b.minDepth) {
				return a.minDepth - b.minDepth;
			}
			return a.firstIdx - b.firstIdx;
		});

		return sorted.map((e) => e.label);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(fn, fn);
		this.writeChain = next.then(() => undefined, () => undefined);
		return next;
	}

	public ensureJobsLogDir(): string {
		const base = this.getVaultBasePath();
		const dir = path.join(base, ...this.pluginDirRelative.replace(/\\/g, "/").split("/"), "jobs");
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	public registerJob(job: SlideFlowCliJob): Promise<void> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs } = pruneAndHealJobs(raw, Date.now(), this.getProtectedBatchIds());
			const filtered = jobs.filter((j) => j.id !== job.id);
			filtered.unshift(job);
			await this.saveJobsRaw(filtered);
			this.emit(filtered);
		});
	}

	public updateJobPid(jobId: string, pid: number | null): Promise<void> {
		if (!pid) return Promise.resolve();
		return this.updateJobMetadata(jobId, { pid }, true);
	}

	public updateJobMetadata(
		jobId: string,
		patch: Partial<SlideFlowCliJob>,
		persistToDisk: boolean = true
	): Promise<void> {
		if (!persistToDisk) {
			const target = this.cachedJobs.find((j) => j.id === jobId);
			if (target) {
				Object.assign(target, patch);
				this.emit(this.cachedJobs);
			}
			return Promise.resolve();
		}
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs } = pruneAndHealJobs(raw, Date.now(), this.getProtectedBatchIds());
			const target = jobs.find((j) => j.id === jobId);
			if (target) {
				Object.assign(target, patch);
				await this.saveJobsRaw(jobs);
				this.emit(jobs);
			}
		});
	}

	public completeJob(
		jobId: string,
		exitCode: number | null,
		errorSummary?: string | null,
		extraPatch?: Partial<SlideFlowCliJob>
	): Promise<void> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs } = pruneAndHealJobs(raw, Date.now(), this.getProtectedBatchIds());
			const target = jobs.find((j) => j.id === jobId);
			if (target) {
				target.status = exitCode === 0 ? "done" : "error";
				target.exitCode = exitCode;
				target.finishedAt = new Date().toISOString();
				target.errorSummary = errorSummary || null;
				target.liveStep = null;
				if (extraPatch) {
					Object.assign(target, extraPatch);
				}
			}
			const cleaned = pruneAndHealJobs(jobs, Date.now(), this.getProtectedBatchIds()).jobs;
			await this.saveJobsRaw(cleaned);
			this.emit(cleaned);
		});
	}

	public removeJob(jobId: string): Promise<void> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const filtered = raw.filter((j) => j.id !== jobId);
			if (filtered.length !== raw.length) {
				await this.saveJobsRaw(filtered);
			}
			this.emit(filtered);
		});
	}

	public refreshAndSync(): Promise<SlideFlowCliJob[]> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs, changed } = pruneAndHealJobs(raw, Date.now(), this.getProtectedBatchIds());
			if (changed) {
				await this.saveJobsRaw(jobs);
			}
			this.emit(jobs);
			return jobs;
		});
	}
}
