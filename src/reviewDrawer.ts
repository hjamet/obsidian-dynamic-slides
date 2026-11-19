/**
 * ReviewDrawer — Panneau récapitulatif multi-notes des commentaires en attente (`R`).
 */

import { ReviewComment } from "./reviewStore";

export interface ReviewDrawerCallbacks {
	onJumpToComment: (comment: ReviewComment) => void;
	onDeleteComment: (commentId: string) => Promise<void>;
	onCopyExport: (includeOneShotPrefix: boolean, clearAfter: boolean) => Promise<void>;
	onClearAll: () => Promise<void>;
	onClose: () => void;
}

export class ReviewDrawer {
	private parentEl: HTMLElement;
	private callbacks: ReviewDrawerCallbacks;
	private backdropEl: HTMLElement | null = null;
	private isOpenFlag: boolean = false;
	private boundKeyHandler: (evt: KeyboardEvent) => void;

	constructor(parentEl: HTMLElement, callbacks: ReviewDrawerCallbacks) {
		this.parentEl = parentEl;
		this.callbacks = callbacks;
		this.boundKeyHandler = this.handleKeyDown.bind(this);
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	public open(comments: ReviewComment[]): void {
		this.close(false);
		this.isOpenFlag = true;

		this.backdropEl = this.parentEl.createDiv({ cls: "slideflow-drawer-backdrop" });
		this.backdropEl.addEventListener("click", (evt) => {
			if (evt.target === this.backdropEl) {
				evt.stopPropagation();
				this.close(true);
			}
		});

		const panelEl = this.backdropEl.createDiv({ cls: "slideflow-drawer-panel" });
		panelEl.addEventListener("click", (evt) => evt.stopPropagation());

		const headerEl = panelEl.createDiv({ cls: "slideflow-drawer-header" });
		headerEl.createEl("h3", {
			cls: "slideflow-drawer-title",
			text: `Review Queue (${comments.length})`,
		});

		const closeBtn = headerEl.createEl("button", {
			cls: "slideflow-drawer-close-btn",
			text: "✕",
			attr: { type: "button", title: "Close (Esc)" },
		});
		closeBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.close(true);
		});

		const listEl = panelEl.createDiv({ cls: "slideflow-drawer-list" });
		this.renderList(listEl, comments);

		const footerEl = panelEl.createDiv({ cls: "slideflow-drawer-footer" });

		const copyOneShotBtn = footerEl.createEl("button", {
			cls: "slideflow-drawer-primary-btn",
			attr: { type: "button" },
		});
		copyOneShotBtn.innerHTML = `Copy /one-shot <strong>Ctrl+↵</strong>`;
		copyOneShotBtn.disabled = comments.length === 0;
		copyOneShotBtn.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			await this.callbacks.onCopyExport(true, false);
		});

		const copyRawBtn = footerEl.createEl("button", {
			cls: "slideflow-drawer-secondary-btn",
			text: "Copy plain",
			attr: { type: "button" },
		});
		copyRawBtn.disabled = comments.length === 0;
		copyRawBtn.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			await this.callbacks.onCopyExport(false, false);
		});

		const clearBtn = footerEl.createEl("button", {
			cls: "slideflow-drawer-danger-btn",
			text: "Clear queue",
			attr: { type: "button", title: "Archives a local backup then clears queue" },
		});
		clearBtn.disabled = comments.length === 0;
		clearBtn.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			await this.callbacks.onClearAll();
			this.close(true);
		});

		window.addEventListener("keydown", this.boundKeyHandler, true);
	}

	private renderList(listEl: HTMLElement, comments: ReviewComment[]): void {
		listEl.empty();
		if (comments.length === 0) {
			listEl.createDiv({
				cls: "slideflow-drawer-empty",
				text: "No pending comments. Press C (text) or V (voice), or highlight text on any slide.",
			});
			return;
		}

		const groups = new Map<string, ReviewComment[]>();
		for (const c of comments) {
			const arr = groups.get(c.notePath) || [];
			arr.push(c);
			groups.set(c.notePath, arr);
		}

		for (const [notePath, items] of groups.entries()) {
			const groupEl = listEl.createDiv({ cls: "slideflow-drawer-group" });
			groupEl.createDiv({
				cls: "slideflow-drawer-group-title",
				text: `${items[0].noteTitle} (${notePath})`,
			});

			for (const c of items) {
				const itemEl = groupEl.createDiv({ cls: "slideflow-drawer-item" });
				const metaEl = itemEl.createDiv({ cls: "slideflow-drawer-item-meta" });
				metaEl.createSpan({
					cls: "slideflow-drawer-item-heading",
					text: c.sectionHeading,
				});
				if (c.scopeLabel) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-scope-badge",
						text: c.scopeLabel,
					});
				}
				if (c.hadDiff) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-diff-badge",
						text: "+old diff",
					});
				}
				if (c.copiedAt) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-copied-badge",
						text: "copied",
					});
				}

				itemEl.createDiv({
					cls: "slideflow-drawer-item-body",
					text: c.commentText,
				});

				const actionsEl = itemEl.createDiv({ cls: "slideflow-drawer-item-actions" });
				const jumpBtn = actionsEl.createEl("button", {
					cls: "slideflow-mini-action-btn",
					text: "Go to slide",
					attr: { type: "button" },
				});
				jumpBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.close(false);
					this.callbacks.onJumpToComment(c);
				});

				const delBtn = actionsEl.createEl("button", {
					cls: "slideflow-mini-action-btn danger",
					text: "Delete",
					attr: { type: "button" },
				});
				delBtn.addEventListener("click", async (evt) => {
					evt.stopPropagation();
					await this.callbacks.onDeleteComment(c.id);
					itemEl.remove();
					if (groupEl.querySelectorAll(".slideflow-drawer-item").length === 0) {
						groupEl.remove();
					}
				});
			}
		}
	}

	private handleKeyDown(evt: KeyboardEvent): void {
		if (!this.isOpenFlag) return;
		if (evt.key === "Escape" || evt.code === "Escape" || evt.key.toLowerCase() === "r") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close(true);
			return;
		}
		if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
			evt.preventDefault();
			evt.stopPropagation();
			void this.callbacks.onCopyExport(true, false);
			return;
		}
		evt.stopPropagation();
	}

	public close(invokeCallback: boolean = true): void {
		if (!this.isOpenFlag && !this.backdropEl) return;
		this.isOpenFlag = false;
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		if (this.backdropEl) {
			this.backdropEl.remove();
			this.backdropEl = null;
		}
		if (invokeCallback) {
			this.callbacks.onClose();
		}
	}
}
