/**
 * ReviewStore — Persistent transactional review comment store for SlideFlow
 * (`.obsidian/plugins/slideflow/pending_reviews.json`).
 *
 * - Always persisted across sessions in BOTH Clipboard mode and Direct CLI (`agy`) mode.
 * - Direct CLI (`agy`) WIP isolation:
 *   When comments are sent to `agy`, they are IMMEDIATELY moved out of the visible `comments` queue
 *   into `wipBatches` bound to `{ jobId, pid }`, leaving the visible queue clean for the next project!
 *   - On `exitCode === 0`: ONLY that `jobId`'s WIP batch is purged permanently.
 *   - On error OR if the OS PID disappears without a positive exit confirmation: ONLY that `jobId`'s
 *     comments are restored back into the visible queue stamped with `failedReason` / `failedAt`,
 *     ready to be re-sent!
 * - Serialized write chain prevents any race between concurrent `agy` completions and user edits.
 */

import { App } from "obsidian";
import * as path from "path";
import { CommentScopeType } from "./contextExtractor";
import { CommentImageAttachment, deleteTempImageSafe } from "./commentImages";

export type { CommentImageAttachment };

export const GENERAL_NOTE_PATH = "__general__";

export function isGeneralComment(
	c: Pick<ReviewComment, "scopeType" | "notePath">
): boolean {
	return c.scopeType === "general" || c.notePath === GENERAL_NOTE_PATH;
}

export interface ReviewComment {
	id: string;
	projectRootPath: string;
	notePath: string;
	noteTitle: string;
	sectionHeading: string;
	sectionLevel: number;
	stackDepth?: number; // DocumentStack navigation depth (0 = initial note, 1 = sub-note / project clicked from dashboard, etc.)
	lineStart: number; // 1-indexed
	lineEnd: number; // 1-indexed
	scopeType?: CommentScopeType;
	scopeLabel?: string;
	contextKey?: string;
	selectionQuote?: string;
	selectionPrefix?: string;
	selectionSuffix?: string;
	excerpt: string;
	hadDiff: boolean;
	oldExcerpt?: string | null;
	commentText: string;
	images?: CommentImageAttachment[];
	createdAt: string;
	updatedAt?: string;
	copiedAt?: string;
	failedBatchId?: string | null;
	failedReason?: string | null;
	failedAt?: string | null;
}

export interface CliSessionBatch {
	kind: "retry" | "new";
	groupKey: string;
	comments: ReviewComment[];
}

/**
 * Splits pending queue comments into independent CLI (`agy`) sessions so that:
 * - Each previously failed WIP batch (identified by `failedBatchId`, falling back to
 *   `projectRootPath` / `notePath` for legacy failed items) is retried in its OWN isolated session
 *   and launched FIRST.
 * - New (non-failed) comments are NEVER mixed into a failed retry session; they run in their own
 *   separate session(s) (also separated if they belong to distinct non-empty `projectRootPath`s).
 */
export function partitionCommentsForCliSessions(comments: ReviewComment[]): CliSessionBatch[] {
	if (!comments || comments.length === 0) return [];

	const failedGroups = new Map<string, ReviewComment[]>();
	const newGroups = new Map<string, ReviewComment[]>();

	for (const c of comments) {
		const isFailed = Boolean(c.failedAt || c.failedReason || c.failedBatchId);
		if (isFailed) {
			const key = c.failedBatchId
				? `retry:batch:${c.failedBatchId}`
				: `retry:proj:${(c.projectRootPath || c.notePath || "__failed__").toLowerCase()}`;
			const bucket = failedGroups.get(key) || [];
			bucket.push(c);
			failedGroups.set(key, bucket);
		} else {
			const key = `new:proj:${(c.projectRootPath || "__current__").toLowerCase()}`;
			const bucket = newGroups.get(key) || [];
			bucket.push(c);
			newGroups.set(key, bucket);
		}
	}

	const sessions: CliSessionBatch[] = [];
	for (const [groupKey, list] of failedGroups.entries()) {
		sessions.push({ kind: "retry", groupKey, comments: list });
	}
	for (const [groupKey, list] of newGroups.entries()) {
		sessions.push({ kind: "new", groupKey, comments: list });
	}
	return sessions;
}

export interface WipCommentBatch {
	jobId: string;
	pid: number | null;
	cli: string;
	model: string;
	startedAt: string;
	comments: ReviewComment[];
}

interface PendingReviewsFile {
	version: number;
	comments: ReviewComment[];
	wipBatches?: WipCommentBatch[];
}

function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r?\n/g, " ");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function wrapCdata(raw: string): string {
	const clean = raw.replace(/\r\n/g, "\n").trim();
	const safe = clean.replace(/\]\]>/g, "]]]]><![CDATA[>");
	return `<![CDATA[\n${safe}\n]]>`;
}

function appendCommentXmlLines(lines: string[], item: ReviewComment, indent: string): void {
	const imgs = item.images || [];
	if (imgs.length === 0) {
		lines.push(`${indent}<comment>${escapeXmlText(item.commentText)}</comment>`);
		return;
	}
	lines.push(`${indent}<comment>`);
	if (item.commentText && item.commentText.trim().length > 0) {
		lines.push(`${indent}  ${escapeXmlText(item.commentText)}`);
	}
	lines.push(`${indent}  <attachments>`);
	for (const img of imgs) {
		lines.push(
			`${indent}    <image path="${escapeXmlAttr(img.path)}" mime="${escapeXmlAttr(img.mimeType)}" />`
		);
	}
	lines.push(`${indent}  </attachments>`);
	lines.push(`${indent}</comment>`);
}

export class ReviewStore {
	private app: App;
	private pluginDir: string;
	private comments: ReviewComment[] = [];
	private wipBatches: WipCommentBatch[] = [];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(app: App, pluginDir: string) {
		this.app = app;
		this.pluginDir = pluginDir;
	}

	private get pendingFilePath(): string {
		return `${this.pluginDir}/pending_reviews.json`;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(fn, fn);
		this.writeChain = next.then(() => undefined, () => undefined);
		return next;
	}

	private async saveToDiskUnlocked(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.pluginDir))) {
			await adapter.mkdir(this.pluginDir);
		}
		const payload: PendingReviewsFile = {
			version: 2,
			comments: this.comments,
			wipBatches: this.wipBatches,
		};
		await adapter.write(this.pendingFilePath, JSON.stringify(payload, null, 2));
	}

	public loadFromDisk(): Promise<ReviewComment[]> {
		return this.enqueue(async () => {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.pendingFilePath))) {
				this.comments = [];
				this.wipBatches = [];
				return this.comments;
			}
			const raw = await adapter.read(this.pendingFilePath);
			const parsed = JSON.parse(raw) as PendingReviewsFile;
			this.comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
			this.wipBatches = Array.isArray(parsed?.wipBatches) ? parsed.wipBatches : [];
			return [...this.comments];
		});
	}

	public getAll(): ReviewComment[] {
		return [...this.comments];
	}

	public getCount(): number {
		return this.comments.length;
	}

	public getWipBatches(): WipCommentBatch[] {
		return this.wipBatches.map((b) => ({ ...b, comments: [...b.comments] }));
	}

	public getWipCommentCount(): number {
		return this.wipBatches.reduce((sum, b) => sum + b.comments.length, 0);
	}

	public getForSlide(notePath: string, sectionHeading: string): ReviewComment[] {
		return this.comments.filter(
			(c) => c.notePath === notePath && c.sectionHeading === sectionHeading
		);
	}

	public getCountForNote(notePath: string): number {
		return this.comments.filter((c) => c.notePath === notePath).length;
	}

	public hasUncopiedComments(): boolean {
		return this.comments.some((c) => !c.copiedAt);
	}

	public hasUnsentComments(): boolean {
		return this.comments.length > 0;
	}

	public getAllReferencedImagePaths(): Set<string> {
		const paths = new Set<string>();
		for (const c of this.comments) {
			for (const img of c.images || []) {
				if (img?.path) paths.add(path.resolve(img.path).toLowerCase());
			}
		}
		for (const b of this.wipBatches) {
			for (const c of b.comments) {
				for (const img of c.images || []) {
					if (img?.path) paths.add(path.resolve(img.path).toLowerCase());
				}
			}
		}
		return paths;
	}

	private cleanupUnreferencedImages(candidatePaths: string[]): void {
		if (candidatePaths.length === 0) return;
		const stillUsed = this.getAllReferencedImagePaths();
		for (const p of candidatePaths) {
			if (!p) continue;
			if (!stillUsed.has(path.resolve(p).toLowerCase())) {
				deleteTempImageSafe(p);
			}
		}
	}

	public addComment(
		input: Omit<ReviewComment, "id" | "createdAt">
	): Promise<ReviewComment> {
		return this.enqueue(async () => {
			const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const item: ReviewComment = {
				...input,
				images: input.images && input.images.length > 0 ? [...input.images] : undefined,
				id,
				createdAt: new Date().toISOString(),
			};
			this.comments.push(item);
			await this.saveToDiskUnlocked();
			return item;
		});
	}

	public updateComment(
		id: string,
		newText: string,
		newImages?: CommentImageAttachment[]
	): Promise<ReviewComment | null> {
		return this.enqueue(async () => {
			const target = this.comments.find((c) => c.id === id);
			if (!target) return null;
			const oldImagePaths = (target.images || []).map((img) => img.path);
			target.commentText = newText.trim();
			if (newImages !== undefined) {
				target.images = newImages.length > 0 ? [...newImages] : undefined;
			}
			target.updatedAt = new Date().toISOString();
			target.copiedAt = undefined;
			await this.saveToDiskUnlocked();
			if (newImages !== undefined && oldImagePaths.length > 0) {
				this.cleanupUnreferencedImages(oldImagePaths);
			}
			return target;
		});
	}

	public deleteComment(id: string): Promise<boolean> {
		return this.enqueue(async () => {
			const target = this.comments.find((c) => c.id === id);
			if (!target) return false;
			const removedPaths = (target.images || []).map((img) => img.path);
			this.comments = this.comments.filter((c) => c.id !== id);
			await this.saveToDiskUnlocked();
			this.cleanupUnreferencedImages(removedPaths);
			return true;
		});
	}

	public markAllCopied(): Promise<void> {
		return this.enqueue(async () => {
			const now = new Date().toISOString();
			for (const c of this.comments) {
				c.copiedAt = now;
			}
			await this.saveToDiskUnlocked();
		});
	}

	public clearAll(): Promise<number> {
		return this.enqueue(async () => {
			const count = this.comments.length;
			const removedPaths = this.comments.flatMap((c) => (c.images || []).map((img) => img.path));
			this.comments = [];
			await this.saveToDiskUnlocked();
			this.cleanupUnreferencedImages(removedPaths);
			return count;
		});
	}

	/**
	 * Atomically moves the specified comments out of the active visible queue into an isolated
	 * WIP batch tied to `jobId` (and later `pid`), immediately clearing the visible queue so
	 * the user can start reviewing another project in parallel!
	 */
	public moveCommentsToWip(
		commentIds: string[],
		meta: { jobId: string; cli: string; model: string; startedAt: string }
	): Promise<ReviewComment[]> {
		return this.enqueue(async () => {
			const idSet = new Set(commentIds);
			const moved: ReviewComment[] = [];
			const remaining: ReviewComment[] = [];

			for (const c of this.comments) {
				if (idSet.has(c.id)) {
					// Clear any stale failed state when re-submitting
					const clean: ReviewComment = { ...c };
					delete clean.failedBatchId;
					delete clean.failedReason;
					delete clean.failedAt;
					moved.push(clean);
				} else {
					remaining.push(c);
				}
			}

			if (moved.length === 0) return [];

			this.comments = remaining;
			this.wipBatches.push({
				jobId: meta.jobId,
				pid: null,
				cli: meta.cli,
				model: meta.model,
				startedAt: meta.startedAt,
				comments: moved,
			});
			await this.saveToDiskUnlocked();
			return moved;
		});
	}

	public setWipBatchPid(jobId: string, pid: number | null): Promise<void> {
		return this.enqueue(async () => {
			const batch = this.wipBatches.find((b) => b.jobId === jobId);
			if (!batch || !pid) return;
			batch.pid = pid;
			await this.saveToDiskUnlocked();
		});
	}

	/**
	 * Permanently purges ONLY the WIP batch belonging to `jobId` after exit code === 0.
	 */
	public purgeWipBatch(jobId: string): Promise<number> {
		return this.enqueue(async () => {
			const idx = this.wipBatches.findIndex((b) => b.jobId === jobId);
			if (idx === -1) return 0;
			const batch = this.wipBatches[idx];
			const count = batch.comments.length;
			const removedPaths = batch.comments.flatMap((c) => (c.images || []).map((img) => img.path));
			this.wipBatches.splice(idx, 1);
			await this.saveToDiskUnlocked();
			this.cleanupUnreferencedImages(removedPaths);
			return count;
		});
	}

	/**
	 * Restores ONLY `jobId`'s WIP comments back into the visible queue stamped with `failedReason` /
	 * `failedAt`, ready to be inspected and re-sent!
	 */
	public restoreWipBatchAsFailed(jobId: string, reason: string): Promise<number> {
		return this.enqueue(async () => {
			const idx = this.wipBatches.findIndex((b) => b.jobId === jobId);
			if (idx === -1) return 0;
			const batch = this.wipBatches[idx];
			this.wipBatches.splice(idx, 1);

			const nowIso = new Date().toISOString();
			const existingIds = new Set(this.comments.map((c) => c.id));
			const restored: ReviewComment[] = [];

			for (const c of batch.comments) {
				if (existingIds.has(c.id)) continue;
				restored.push({
					...c,
					failedBatchId: jobId,
					failedReason: reason || "Command failed",
					failedAt: nowIso,
				});
			}

			// Put restored failed comments at the top so they are immediately visible in Review Queue
			this.comments = [...restored, ...this.comments];
			await this.saveToDiskUnlocked();
			return restored.length;
		});
	}

	public getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as any;
		if (typeof adapter.getBasePath === "function") {
			return adapter.getBasePath();
		}
		return "";
	}

	/**
	 * Formats comments as unambiguous XML (`/one-shot` + `<slideflow_review>`).
	 * Deduplicates source context when multiple comments share the same `(notePath, contextKey)`.
	 */
	public formatExport(
		includeOneShotPrefix: boolean = true,
		subset?: ReviewComment[]
	): string {
		const list = subset ?? this.comments;
		if (list.length === 0) return "";

		const basePath = this.getVaultBasePath();
		const generalComments: ReviewComment[] = [];
		const noteGroups = new Map<string, ReviewComment[]>();
		for (const c of list) {
			if (isGeneralComment(c)) {
				generalComments.push(c);
				continue;
			}
			const arr = noteGroups.get(c.notePath) || [];
			arr.push(c);
			noteGroups.set(c.notePath, arr);
		}

		const lines: string[] = [];
		if (includeOneShotPrefix) {
			lines.push("/one-shot");
			lines.push("");
		}

		lines.push(
			`<slideflow_review count="${list.length}" notes="${noteGroups.size}">`
		);

		if (generalComments.length > 0) {
			lines.push(`  <general_comments>`);
			for (const item of generalComments) {
				appendCommentXmlLines(lines, item, "    ");
			}
			lines.push(`  </general_comments>`);
		}

		for (const [notePath, noteItems] of noteGroups.entries()) {
			const refPath = basePath
				? path.join(basePath, ...notePath.split("/"))
				: notePath;
			lines.push(`  <note path="${escapeXmlAttr(refPath)}">`);

			const contextGroups = new Map<string, ReviewComment[]>();
			for (const c of noteItems) {
				const key =
					c.contextKey ||
					`${c.sectionHeading}::${c.scopeType || "viewport"}::${c.excerpt}::${c.oldExcerpt || ""}`;
				const bucket = contextGroups.get(key) || [];
				bucket.push(c);
				contextGroups.set(key, bucket);
			}

			for (const groupItems of contextGroups.values()) {
				const rep = groupItems[0];
				const lineAttr =
					rep.lineEnd > rep.lineStart
						? `${rep.lineStart}-${rep.lineEnd}`
						: `${rep.lineStart}`;
				const scopeAttr = rep.scopeLabel || "Slide";

				lines.push(
					`    <target section="${escapeXmlAttr(rep.sectionHeading)}" lines="${escapeXmlAttr(lineAttr)}" scope="${escapeXmlAttr(scopeAttr)}">`
				);

				if (rep.hadDiff) {
					const oldText =
						rep.oldExcerpt && rep.oldExcerpt.trim().length > 0
							? rep.oldExcerpt
							: "(Newly added content — absent from previous version)";
					lines.push(`      <previous_text>${wrapCdata(oldText)}</previous_text>`);
					lines.push(`      <current_text>${wrapCdata(rep.excerpt)}</current_text>`);
				} else {
					lines.push(`      <context>${wrapCdata(rep.excerpt)}</context>`);
				}

				lines.push(`      <comments>`);
				for (const item of groupItems) {
					appendCommentXmlLines(lines, item, "        ");
				}
				lines.push(`      </comments>`);
				lines.push(`    </target>`);
			}

			lines.push(`  </note>`);
		}

		lines.push(`</slideflow_review>`);
		return lines.join("\n") + "\n";
	}
}
