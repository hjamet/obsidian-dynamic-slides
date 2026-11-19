/**
 * ReviewStore — Persistent review comment store for SlideFlow (`.obsidian/plugins/slideflow/pending_reviews.json`).
 *
 * - Always persisted across sessions in BOTH Clipboard mode and Direct CLI (`agy`) mode so no comment
 *   is ever lost on exit.
 * - Clipboard mode: comments are cleared manually via "Clear queue" in the Review Queue (`R`).
 * - Direct CLI (`agy`) mode: sent comments are automatically cleared ONLY after the CLI command
 *   finishes with exit code 0.
 * - Clean XML export (`/one-shot` + `<slideflow_review>`) so Markdown code blocks, headings,
 *   and blockquotes inside notes never collide with the comment structure.
 */

import { App } from "obsidian";
import * as path from "path";
import { CommentScopeType } from "./contextExtractor";

export interface ReviewComment {
	id: string;
	projectRootPath: string;
	notePath: string;
	noteTitle: string;
	sectionHeading: string;
	sectionLevel: number;
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
	createdAt: string;
	updatedAt?: string;
	copiedAt?: string;
}

interface PendingReviewsFile {
	version: number;
	comments: ReviewComment[];
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

export class ReviewStore {
	private app: App;
	private pluginDir: string;
	private comments: ReviewComment[] = [];

	constructor(app: App, pluginDir: string) {
		this.app = app;
		this.pluginDir = pluginDir;
	}

	private get pendingFilePath(): string {
		return `${this.pluginDir}/pending_reviews.json`;
	}

	public async loadFromDisk(): Promise<ReviewComment[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.pendingFilePath))) {
			this.comments = [];
			return this.comments;
		}
		const raw = await adapter.read(this.pendingFilePath);
		const parsed = JSON.parse(raw) as PendingReviewsFile;
		this.comments = Array.isArray(parsed?.comments) ? parsed.comments : [];
		return this.comments;
	}

	private async saveToDisk(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.pluginDir))) {
			await adapter.mkdir(this.pluginDir);
		}
		const payload: PendingReviewsFile = {
			version: 1,
			comments: this.comments,
		};
		await adapter.write(this.pendingFilePath, JSON.stringify(payload, null, 2));
	}

	public getAll(): ReviewComment[] {
		return [...this.comments];
	}

	public getCount(): number {
		return this.comments.length;
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

	public hasUnsentComments(inFlightIds?: Set<string>): boolean {
		return this.comments.some((c) => !inFlightIds?.has(c.id));
	}

	public async addComment(
		input: Omit<ReviewComment, "id" | "createdAt">
	): Promise<ReviewComment> {
		const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const item: ReviewComment = {
			...input,
			id,
			createdAt: new Date().toISOString(),
		};
		this.comments.push(item);
		await this.saveToDisk();
		return item;
	}

	public async updateComment(id: string, newText: string): Promise<ReviewComment | null> {
		const target = this.comments.find((c) => c.id === id);
		if (!target) return null;
		target.commentText = newText.trim();
		target.updatedAt = new Date().toISOString();
		target.copiedAt = undefined;
		await this.saveToDisk();
		return target;
	}

	public async deleteComment(id: string): Promise<boolean> {
		const before = this.comments.length;
		this.comments = this.comments.filter((c) => c.id !== id);
		if (this.comments.length !== before) {
			await this.saveToDisk();
			return true;
		}
		return false;
	}

	public async removeCommentsByIds(ids: string[]): Promise<number> {
		const idSet = new Set(ids);
		const before = this.comments.length;
		this.comments = this.comments.filter((c) => !idSet.has(c.id));
		const removed = before - this.comments.length;
		if (removed > 0) {
			await this.saveToDisk();
		}
		return removed;
	}

	public async markAllCopied(): Promise<void> {
		const now = new Date().toISOString();
		for (const c of this.comments) {
			c.copiedAt = now;
		}
		await this.saveToDisk();
	}

	public async clearAll(): Promise<number> {
		const count = this.comments.length;
		this.comments = [];
		await this.saveToDisk();
		return count;
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
		const noteGroups = new Map<string, ReviewComment[]>();
		for (const c of list) {
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
					lines.push(`        <comment>${escapeXmlText(item.commentText)}</comment>`);
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
