/**
 * activeJobsTracker.ts — Tracks active & recent SlideFlow CLI (`agy`) jobs in
 * `_agents/slideflow_active_jobs.json` and synchronizes a live status block inside `🎯 Projets.md`.
 *
 * - Self-healing PID check (`process.kill(pid, 0)`) prevents zombie "running" entries if Obsidian reloads.
 * - Cleanly integrates with Project Memory (`dashboardUpdater.ts` & `project_memory_cli.py`) via
 *   `<!-- SLIDEFLOW_AGY_JOBS_START --> ... <!-- SLIDEFLOW_AGY_JOBS_END -->` markers.
 */

import { App, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";

export const ACTIVE_JOBS_FILE_PATH = "_agents/slideflow_active_jobs.json";
export const JOBS_BLOCK_START = "<!-- SLIDEFLOW_AGY_JOBS_START -->";
export const JOBS_BLOCK_END = "<!-- SLIDEFLOW_AGY_JOBS_END -->";

const DONE_RETENTION_MS = 15 * 60 * 1000; // keep completed notice for 15 min
const ERROR_RETENTION_MS = 60 * 60 * 1000; // keep error notice for 60 min

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
	errorSummary?: string | null;
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

function formatHHMM(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return "--:--";
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
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

function formatNotesLabel(notes: string[], dashboardPath: string = "🎯 Projets.md"): string {
	const ordered = orderNotesWithDashboardLast(notes, dashboardPath);
	if (ordered.length === 0) return "Revue SlideFlow";
	if (ordered.length === 1) return ordered[0];
	return `${ordered[0]} (+${ordered.length - 1} note${ordered.length - 1 > 1 ? "s" : ""})`;
}

export function pruneAndHealJobs(jobs: SlideFlowCliJob[], nowMs: number = Date.now()): {
	jobs: SlideFlowCliJob[];
	changed: boolean;
} {
	let changed = false;
	const kept: SlideFlowCliJob[] = [];

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
				changed = true;
			}
		}

		if (copy.status === "running") {
			kept.push(copy);
			continue;
		}

		const finTime = new Date(copy.finishedAt || copy.startedAt).getTime();
		const age = isNaN(finTime) ? Infinity : nowMs - finTime;
		const limit = copy.status === "error" ? ERROR_RETENTION_MS : DONE_RETENTION_MS;
		if (age <= limit) {
			kept.push(copy);
		} else {
			changed = true;
		}
	}

	return { jobs: kept, changed };
}

export function renderActiveJobsMarkdownBlock(
	jobs: SlideFlowCliJob[],
	dashboardPath: string = "🎯 Projets.md"
): string {
	if (!jobs || jobs.length === 0) return "";

	const running = jobs.filter((j) => j.status === "running");
	const recent = jobs.filter((j) => j.status !== "running");

	const lines: string[] = [JOBS_BLOCK_START];

	if (running.length > 0) {
		lines.push(`> 🤖 **Commandes \`agy\` en cours (${running.length})** :`);
		for (const j of running) {
			const label = formatNotesLabel(j.notes, dashboardPath);
			const modelPart = j.model ? ` · \`${j.model}\`` : "";
			const pidPart = j.pid ? ` · PID \`${j.pid}\`` : "";
			const timeStr = formatHHMM(j.startedAt);
			lines.push(
				`> - ⏳ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? "s" : ""}\`${modelPart} · démarré à \`${timeStr}\`${pidPart}`
			);
		}
	} else {
		lines.push(`> 🤖 **Dernières exécutions \`agy\`** :`);
	}

	for (const j of recent) {
		const label = formatNotesLabel(j.notes, dashboardPath);
		const modelPart = j.model ? ` · \`${j.model}\`` : "";
		const finStr = formatHHMM(j.finishedAt || j.startedAt);
		if (j.status === "done") {
			lines.push(
				`> - ✅ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? "s" : ""}\`${modelPart} · terminé à \`${finStr}\``
			);
		} else {
			const errPart = j.errorSummary ? ` — ${j.errorSummary.slice(0, 120)}` : "";
			lines.push(
				`> - ❌ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? "s" : ""}\`${modelPart} · échec \`exit ${j.exitCode ?? "?"}\` à \`${finStr}\`${errPart}`
			);
		}
	}

	lines.push(JOBS_BLOCK_END);
	return lines.join("\n");
}

export class ActiveJobsTracker {
	private app: App;
	private pluginDirRelative: string;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(app: App, pluginDirRelative: string) {
		this.app = app;
		this.pluginDirRelative = pluginDirRelative;
	}

	private getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as any;
		return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
	}

	private async resolveDashboardVaultPath(): Promise<string> {
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
		const payload: ActiveJobsPayload = { version: 1, jobs };
		await adapter.write(ACTIVE_JOBS_FILE_PATH, JSON.stringify(payload, null, 2));
	}

	public async orderNotesForJob(
		comments: Array<{ notePath: string; noteTitle?: string; stackDepth?: number }>
	): Promise<string[]> {
		const dashboardPath = await this.resolveDashboardVaultPath();
		const byNote = new Map<
			string,
			{ label: string; isDashboard: boolean; minDepth: number; firstIdx: number }
		>();

		comments.forEach((c, idx) => {
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
			// Configured Project File (e.g. 🎯 Projets) ALWAYS goes last (inside +X notes)
			if (a.isDashboard !== b.isDashboard) {
				return a.isDashboard ? 1 : -1;
			}
			// Lowest navigation depth first (Master Project Note before sub-notes)
			if (a.minDepth !== b.minDepth) {
				return a.minDepth - b.minDepth;
			}
			// First-seen tie-breaker
			return a.firstIdx - b.firstIdx;
		});

		return sorted.map((e) => e.label);
	}

	private async updateDashboardNote(jobs: SlideFlowCliJob[]): Promise<void> {
		const dashboardPath = await this.resolveDashboardVaultPath();
		const targetFile = this.app.vault.getAbstractFileByPath(dashboardPath);
		if (!(targetFile instanceof TFile)) return;

		const original = (await this.app.vault.read(targetFile)).replace(/\r\n/g, "\n");
		const block = renderActiveJobsMarkdownBlock(jobs, dashboardPath);
		const markerRe = new RegExp(
			`\\n?${JOBS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${JOBS_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
			"g"
		);

		let updated = original;
		if (markerRe.test(original)) {
			updated = original.replace(markerRe, block ? `\n\n${block}\n\n` : "\n\n");
		} else if (block) {
			const tableIdx = original.indexOf("\n| Title |");
			if (tableIdx !== -1) {
				updated =
					original.slice(0, tableIdx).replace(/\n+$/, "") +
					`\n\n${block}\n\n` +
					original.slice(tableIdx + 1);
			} else {
				updated = original.replace(/\n+$/, "") + `\n\n${block}\n`;
			}
		}

		updated = updated.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
		if (updated !== original) {
			await this.app.vault.modify(targetFile, updated);
		}
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
			const { jobs } = pruneAndHealJobs(raw);
			const filtered = jobs.filter((j) => j.id !== job.id);
			filtered.unshift(job);
			await this.saveJobsRaw(filtered);
			await this.updateDashboardNote(filtered);
		});
	}

	public updateJobPid(jobId: string, pid: number | null): Promise<void> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs } = pruneAndHealJobs(raw);
			const target = jobs.find((j) => j.id === jobId);
			if (target && pid) {
				target.pid = pid;
				await this.saveJobsRaw(jobs);
				await this.updateDashboardNote(jobs);
			}
		});
	}

	public completeJob(
		jobId: string,
		exitCode: number | null,
		errorSummary?: string | null
	): Promise<void> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs } = pruneAndHealJobs(raw);
			const target = jobs.find((j) => j.id === jobId);
			if (target) {
				target.status = exitCode === 0 ? "done" : "error";
				target.exitCode = exitCode;
				target.finishedAt = new Date().toISOString();
				target.errorSummary = errorSummary || null;
			}
			const cleaned = pruneAndHealJobs(jobs).jobs;
			await this.saveJobsRaw(cleaned);
			await this.updateDashboardNote(cleaned);
		});
	}

	public refreshAndSync(): Promise<SlideFlowCliJob[]> {
		return this.enqueue(async () => {
			const raw = await this.loadJobsRaw();
			const { jobs, changed } = pruneAndHealJobs(raw);
			if (changed) {
				await this.saveJobsRaw(jobs);
			}
			await this.updateDashboardNote(jobs);
			return jobs;
		});
	}
}
