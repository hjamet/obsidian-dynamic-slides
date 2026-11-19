/**
 * ReviewStore — File de staging transactionnelle hors notes (`.obsidian/plugins/slideflow/pending_reviews.json`).
 *
 * - Zéro pollution des notes Markdown du coffre.
 * - Zéro perte : chaque ajout/édition/suppression est immédiatement sauvegardé sur disque,
 *   et chaque export `/one-shot` est archivé dans `sent_reviews_archive.json` (30 derniers lots).
 * - Regroupement dédupliqué : plusieurs commentaires sur une même slide / portée (zoom, sélection, viewport)
 *   ne copient le texte source QU'UNE SEULE FOIS suivi de tous les commentaires dessous !
 * - Capture `oldExcerpt` (ancien texte avant diff) ET `excerpt` (nouveau texte actuel) sur les zones avec diff.
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
	lineEnd: number;   // 1-indexed
	scopeType?: CommentScopeType;
	scopeLabel?: string;
	contextKey?: string;
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

interface SentBatchArchiveEntry {
	exportedAt: string;
	includeOneShotPrefix: boolean;
	count: number;
	comments: ReviewComment[];
	formattedText: string;
}

interface SentReviewsArchiveFile {
	version: number;
	batches: SentBatchArchiveEntry[];
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

	private get archiveFilePath(): string {
		return `${this.pluginDir}/sent_reviews_archive.json`;
	}

	public async load(): Promise<ReviewComment[]> {
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

	private async save(): Promise<void> {
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
		await this.save();
		return item;
	}

	public async updateComment(id: string, newText: string): Promise<ReviewComment | null> {
		const target = this.comments.find((c) => c.id === id);
		if (!target) return null;
		target.commentText = newText.trim();
		target.updatedAt = new Date().toISOString();
		await this.save();
		return target;
	}

	public async deleteComment(id: string): Promise<boolean> {
		const before = this.comments.length;
		this.comments = this.comments.filter((c) => c.id !== id);
		if (this.comments.length !== before) {
			await this.save();
			return true;
		}
		return false;
	}

	public async markAllCopied(): Promise<void> {
		const now = new Date().toISOString();
		for (const c of this.comments) {
			c.copiedAt = now;
		}
		await this.save();
	}

	public async archiveBatch(formattedText: string, includeOneShotPrefix: boolean): Promise<void> {
		if (this.comments.length === 0) return;
		const adapter = this.app.vault.adapter;
		let archive: SentReviewsArchiveFile = { version: 1, batches: [] };
		if (await adapter.exists(this.archiveFilePath)) {
			const raw = await adapter.read(this.archiveFilePath);
			const parsed = JSON.parse(raw) as SentReviewsArchiveFile;
			if (parsed && Array.isArray(parsed.batches)) {
				archive = parsed;
			}
		}
		archive.batches.unshift({
			exportedAt: new Date().toISOString(),
			includeOneShotPrefix,
			count: this.comments.length,
			comments: JSON.parse(JSON.stringify(this.comments)),
			formattedText,
		});
		if (archive.batches.length > 30) {
			archive.batches = archive.batches.slice(0, 30);
		}
		await adapter.write(this.archiveFilePath, JSON.stringify(archive, null, 2));
	}

	public async clearAll(archiveFirst: boolean = true): Promise<number> {
		const count = this.comments.length;
		if (count === 0) return 0;
		if (archiveFirst) {
			const formatted = this.formatExport(true);
			await this.archiveBatch(formatted, true);
		}
		this.comments = [];
		await this.save();
		return count;
	}

	public getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as any;
		if (typeof adapter.getBasePath === "function") {
			return adapter.getBasePath();
		}
		return "";
	}

	private quoteBlock(text: string): string {
		const clean = text.replace(/\r\n/g, "\n").trim();
		if (!clean) return "> *(vide)*";
		return clean
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
	}

	/**
	 * Exporte tous les commentaires en dédupliquant le contexte :
	 * Si plusieurs commentaires portent sur la même slide / même viewport / même zoom / même sélection,
	 * le texte source n'est affiché QU'UNE SEULE FOIS, suivi de la liste des commentaires dessous.
	 */
	public formatExport(includeOneShotPrefix: boolean = true): string {
		if (this.comments.length === 0) return "";

		const basePath = this.getVaultBasePath();
		const noteGroups = new Map<string, ReviewComment[]>();
		for (const c of this.comments) {
			const arr = noteGroups.get(c.notePath) || [];
			arr.push(c);
			noteGroups.set(c.notePath, arr);
		}

		const noteCount = noteGroups.size;
		const totalCount = this.comments.length;
		const lines: string[] = [];

		if (includeOneShotPrefix) {
			lines.push("/one-shot");
			lines.push("");
		}

		lines.push(
			`Review comments from SlideFlow (${totalCount} comment${totalCount > 1 ? "s" : ""} across ${noteCount} note${noteCount > 1 ? "s" : ""}):`
		);
		lines.push("");

		for (const [notePath, noteItems] of noteGroups.entries()) {
			const refPath = basePath
				? path.join(basePath, ...notePath.split("/"))
				: notePath;
			lines.push(`### @[${refPath}]`);
			lines.push("");

			// Group items inside this note by exact deduplicated contextKey
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
				const scopeTag = rep.scopeLabel ? ` · ${rep.scopeLabel}` : "";
				const lineSpan =
					rep.lineEnd > rep.lineStart
						? `lines ${rep.lineStart}–${rep.lineEnd}`
						: `line ${rep.lineStart}`;
				lines.push(`#### Section: \`${rep.sectionHeading}\` (${lineSpan}${scopeTag})`);
				lines.push("");

				if (rep.hadDiff) {
					const oldText =
						rep.oldExcerpt && rep.oldExcerpt.trim().length > 0
							? rep.oldExcerpt
							: "(Newly added content — absent from previous version)";
					lines.push("**Previous text (before diff):**");
					lines.push(this.quoteBlock(oldText));
					lines.push("");
					lines.push("**Current text:**");
					lines.push(this.quoteBlock(rep.excerpt));
				} else {
					lines.push("**Context:**");
					lines.push(this.quoteBlock(rep.excerpt));
				}
				lines.push("");

				if (groupItems.length === 1) {
					lines.push(`**Comment:** ${groupItems[0].commentText}`);
				} else {
					lines.push("**Comments:**");
					groupItems.forEach((item, idx) => {
						lines.push(`${idx + 1}. ${item.commentText}`);
					});
				}
				lines.push("");
			}
		}

		return lines.join("\n").trim() + "\n";
	}
}
