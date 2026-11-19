/**
 * ReviewDrawer — Keyboard-first multi-note review queue panel (`R`).
 *
 * Keyboard navigation:
 * - ArrowUp / ArrowDown : move selection across comments
 * - Enter               : jump to slide AND open the selected comment for editing
 * - Delete              : open inline confirmation modal (Enter confirms, Esc cancels)
 * - Ctrl+Enter          : copy XML (clipboard mode) or launch CLI & auto-clear on exit 0 (direct CLI mode)
 * - Esc / R             : close drawer
 *
 * Footer buttons:
 * - Clipboard mode : Copy /one-shot (XML) + Clear queue (manual clear with confirmation)
 * - Direct CLI mode: Send to <cli> (auto-clears on successful exit code 0)
 */

import { ConfirmOverlayModal } from "./confirmModal";
import { ReviewComment } from "./reviewStore";

export interface ReviewDrawerOpenOptions {
	comments: ReviewComment[];
	directCliEnabled: boolean;
	cliDisplayName: string;
	inFlightIds?: Set<string>;
}

export interface ReviewDrawerCallbacks {
	onEditComment: (comment: ReviewComment) => void | Promise<void>;
	onDeleteComment: (commentId: string) => Promise<void>;
	onClearAll: () => Promise<void>;
	onPrimaryAction: () => Promise<void>;
	onClose: () => void;
}

export class ReviewDrawer {
	private parentEl: HTMLElement;
	private callbacks: ReviewDrawerCallbacks;
	private confirmModal: ConfirmOverlayModal;

	private backdropEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private primaryBtnEl: HTMLButtonElement | null = null;
	private clearBtnEl: HTMLButtonElement | null = null;

	private isOpenFlag: boolean = false;
	private directCliEnabled: boolean = false;
	private cliDisplayName: string = "CLI";
	private inFlightIds: Set<string> = new Set();
	private comments: ReviewComment[] = [];
	private flatRows: Array<{ comment: ReviewComment; el: HTMLElement }> = [];
	private selectedIndex: number = -1;

	private boundKeyHandler: (evt: KeyboardEvent) => void;

	constructor(parentEl: HTMLElement, callbacks: ReviewDrawerCallbacks) {
		this.parentEl = parentEl;
		this.callbacks = callbacks;
		this.confirmModal = new ConfirmOverlayModal(parentEl);
		this.boundKeyHandler = this.handleKeyDown.bind(this);
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	public open(options: ReviewDrawerOpenOptions): void {
		this.close(false);
		this.isOpenFlag = true;
		this.comments = [...options.comments];
		this.directCliEnabled = options.directCliEnabled;
		this.cliDisplayName = options.cliDisplayName || "CLI";
		this.inFlightIds = new Set(options.inFlightIds || []);
		this.selectedIndex = this.comments.length > 0 ? 0 : -1;

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
		this.titleEl = headerEl.createEl("h3", {
			cls: "slideflow-drawer-title",
			text: `Review Queue (${this.comments.length})`,
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

		const hintsEl = panelEl.createDiv({ cls: "slideflow-drawer-hints" });
		hintsEl.innerHTML = `<span><strong>↑↓</strong> select</span><span><strong>↵</strong> edit</span><span><strong>Del</strong> delete</span><span><strong>Ctrl+↵</strong> ${this.directCliEnabled ? `send to ${this.cliDisplayName}` : "copy XML"}</span>`;

		this.listEl = panelEl.createDiv({ cls: "slideflow-drawer-list" });
		this.renderList();

		const footerEl = panelEl.createDiv({ cls: "slideflow-drawer-footer" });

		this.primaryBtnEl = footerEl.createEl("button", {
			cls: "slideflow-drawer-primary-btn",
			attr: { type: "button" },
		});
		this.primaryBtnEl.addEventListener("click", async (evt) => {
			evt.stopPropagation();
			if (this.comments.length === 0) return;
			await this.callbacks.onPrimaryAction();
		});

		// In Clipboard mode, comments are manually cleared via "Clear queue"
		if (!this.directCliEnabled) {
			this.clearBtnEl = footerEl.createEl("button", {
				cls: "slideflow-drawer-danger-btn",
				text: "Clear queue",
				attr: { type: "button", title: "Remove all comments from the review queue" },
			});
			this.clearBtnEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.promptClearAll();
			});
		} else {
			this.clearBtnEl = null;
		}

		this.updateHeaderAndFooter();
		window.addEventListener("keydown", this.boundKeyHandler, true);
	}

	public refresh(comments: ReviewComment[], inFlightIds?: Set<string>): void {
		if (!this.isOpenFlag) return;
		const prevSelectedId =
			this.selectedIndex >= 0 && this.selectedIndex < this.flatRows.length
				? this.flatRows[this.selectedIndex].comment.id
				: null;

		this.comments = [...comments];
		if (inFlightIds) {
			this.inFlightIds = new Set(inFlightIds);
		}

		this.renderList();

		if (this.flatRows.length === 0) {
			this.selectedIndex = -1;
		} else if (prevSelectedId) {
			const idx = this.flatRows.findIndex((r) => r.comment.id === prevSelectedId);
			this.selectedIndex = idx !== -1 ? idx : Math.min(this.selectedIndex, this.flatRows.length - 1);
		} else {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.flatRows.length - 1));
		}

		this.applySelectionHighlight(false);
		this.updateHeaderAndFooter();
	}

	private updateHeaderAndFooter(): void {
		if (this.titleEl) {
			this.titleEl.setText(`Review Queue (${this.comments.length})`);
		}
		if (this.primaryBtnEl) {
			const unsentCount = this.comments.filter((c) => !this.inFlightIds.has(c.id)).length;
			if (this.directCliEnabled) {
				this.primaryBtnEl.innerHTML =
					unsentCount === 0 && this.comments.length > 0
						? `Sending to ${this.cliDisplayName}…`
						: `Send to ${this.cliDisplayName} <strong>Ctrl+↵</strong>`;
				this.primaryBtnEl.disabled = unsentCount === 0;
			} else {
				this.primaryBtnEl.innerHTML = `Copy /one-shot (XML) <strong>Ctrl+↵</strong>`;
				this.primaryBtnEl.disabled = this.comments.length === 0;
			}
		}
		if (this.clearBtnEl) {
			this.clearBtnEl.disabled = this.comments.length === 0;
		}
	}

	private renderList(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		this.flatRows = [];

		if (this.comments.length === 0) {
			this.listEl.createDiv({
				cls: "slideflow-drawer-empty",
				text: "No comments yet. Press C (text) or V (voice), or highlight text on any slide.",
			});
			return;
		}

		const groups = new Map<string, ReviewComment[]>();
		for (const c of this.comments) {
			const arr = groups.get(c.notePath) || [];
			arr.push(c);
			groups.set(c.notePath, arr);
		}

		for (const [notePath, items] of groups.entries()) {
			const groupEl = this.listEl.createDiv({ cls: "slideflow-drawer-group" });
			groupEl.createDiv({
				cls: "slideflow-drawer-group-title",
				text: `${items[0].noteTitle} (${notePath})`,
			});

			for (const c of items) {
				const rowIdx = this.flatRows.length;
				const itemEl = groupEl.createDiv({ cls: "slideflow-drawer-item" });
				itemEl.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.selectedIndex = rowIdx;
					this.applySelectionHighlight(false);
				});
				itemEl.addEventListener("dblclick", (evt) => {
					evt.stopPropagation();
					this.triggerEditComment(c);
				});

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
				if (this.inFlightIds.has(c.id)) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-copied-badge",
						text: "sending…",
					});
				} else if (c.copiedAt) {
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
				const editBtn = actionsEl.createEl("button", {
					cls: "slideflow-mini-action-btn",
					text: "Edit",
					attr: { type: "button", title: "Jump to slide and edit (Enter)" },
				});
				editBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.triggerEditComment(c);
				});

				const delBtn = actionsEl.createEl("button", {
					cls: "slideflow-mini-action-btn danger",
					text: "Delete",
					attr: { type: "button", title: "Delete comment (Del)" },
				});
				delBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.selectedIndex = rowIdx;
					this.applySelectionHighlight(false);
					this.promptDeleteSelected();
				});

				this.flatRows.push({ comment: c, el: itemEl });
			}
		}

		if (this.selectedIndex >= this.flatRows.length) {
			this.selectedIndex = this.flatRows.length - 1;
		}
		this.applySelectionHighlight(false);
	}

	private applySelectionHighlight(scrollIntoView: boolean): void {
		this.flatRows.forEach((row, idx) => {
			const isSelected = idx === this.selectedIndex;
			row.el.toggleClass("is-selected", isSelected);
			if (isSelected && scrollIntoView) {
				row.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		});
	}

	private triggerEditComment(comment: ReviewComment): void {
		this.close(false);
		void this.callbacks.onEditComment(comment);
	}

	private promptDeleteSelected(): void {
		if (this.selectedIndex < 0 || this.selectedIndex >= this.flatRows.length) return;
		const target = this.flatRows[this.selectedIndex].comment;
		const preview =
			target.commentText.length > 160
				? target.commentText.slice(0, 160) + "…"
				: target.commentText;

		this.confirmModal.open({
			title: "Delete comment?",
			message: `Remove this comment from "${target.sectionHeading}"?`,
			quotePreview: preview,
			confirmLabelHtml: `Delete <strong>↵</strong>`,
			confirmVariant: "danger",
			confirmShortcut: "Enter",
			cancelLabelHtml: `Cancel <strong>Esc</strong>`,
			onConfirm: async () => {
				const prevIdx = this.selectedIndex;
				await this.callbacks.onDeleteComment(target.id);
				this.comments = this.comments.filter((c) => c.id !== target.id);
				this.selectedIndex =
					this.comments.length === 0 ? -1 : Math.min(prevIdx, this.comments.length - 1);
				this.renderList();
				this.updateHeaderAndFooter();
			},
			onCancel: () => {
				// Return focus smoothly to drawer
			},
		});
	}

	private promptClearAll(): void {
		if (this.comments.length === 0) return;
		const n = this.comments.length;
		this.confirmModal.open({
			title: `Clear all ${n} comment${n > 1 ? "s" : ""}?`,
			message: `This will permanently remove all ${n} comment${n > 1 ? "s" : ""} from the review queue.`,
			confirmLabelHtml: `Clear queue <strong>↵</strong>`,
			confirmVariant: "danger",
			confirmShortcut: "Enter",
			cancelLabelHtml: `Cancel <strong>Esc</strong>`,
			onConfirm: async () => {
				await this.callbacks.onClearAll();
				this.comments = [];
				this.selectedIndex = -1;
				this.renderList();
				this.updateHeaderAndFooter();
			},
			onCancel: () => {
				// Keep drawer open
			},
		});
	}

	private handleKeyDown(evt: KeyboardEvent): void {
		if (!this.isOpenFlag) return;
		if (this.confirmModal.isOpen()) return;

		if (
			evt.key === "Escape" ||
			evt.code === "Escape" ||
			(!evt.ctrlKey && !evt.metaKey && !evt.altKey && evt.key.toLowerCase() === "r")
		) {
			evt.preventDefault();
			evt.stopPropagation();
			this.close(true);
			return;
		}

		if ((evt.ctrlKey || evt.metaKey) && (evt.key === "Enter" || evt.code === "Enter")) {
			evt.preventDefault();
			evt.stopPropagation();
			if (this.comments.length > 0) {
				void this.callbacks.onPrimaryAction();
			}
			return;
		}

		if (evt.key === "ArrowDown" || evt.code === "ArrowDown") {
			evt.preventDefault();
			evt.stopPropagation();
			if (this.flatRows.length > 0) {
				this.selectedIndex =
					this.selectedIndex < 0 ? 0 : (this.selectedIndex + 1) % this.flatRows.length;
				this.applySelectionHighlight(true);
			}
			return;
		}

		if (evt.key === "ArrowUp" || evt.code === "ArrowUp") {
			evt.preventDefault();
			evt.stopPropagation();
			if (this.flatRows.length > 0) {
				this.selectedIndex =
					this.selectedIndex < 0
						? this.flatRows.length - 1
						: (this.selectedIndex - 1 + this.flatRows.length) % this.flatRows.length;
				this.applySelectionHighlight(true);
			}
			return;
		}

		if ((evt.key === "Enter" || evt.code === "Enter") && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
			evt.preventDefault();
			evt.stopPropagation();
			if (this.selectedIndex >= 0 && this.selectedIndex < this.flatRows.length) {
				this.triggerEditComment(this.flatRows[this.selectedIndex].comment);
			}
			return;
		}

		if (evt.key === "Delete" || evt.code === "Delete") {
			evt.preventDefault();
			evt.stopPropagation();
			this.promptDeleteSelected();
			return;
		}

		evt.stopPropagation();
	}

	public close(invokeCallback: boolean = true): void {
		this.confirmModal.close();
		if (!this.isOpenFlag && !this.backdropEl) return;
		this.isOpenFlag = false;
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		if (this.backdropEl) {
			this.backdropEl.remove();
			this.backdropEl = null;
		}
		this.titleEl = null;
		this.listEl = null;
		this.primaryBtnEl = null;
		this.clearBtnEl = null;
		this.flatRows = [];
		this.selectedIndex = -1;
		if (invokeCallback) {
			this.callbacks.onClose();
		}
	}
}
