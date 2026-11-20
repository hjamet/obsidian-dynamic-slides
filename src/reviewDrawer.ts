/**
 * ReviewDrawer — Keyboard-first multi-note review queue panel (`R`).
 *
 * Keyboard navigation:
 * - ArrowUp / ArrowDown : move selection across comments
 * - Enter               : jump to slide AND open the selected comment for editing
 * - Delete              : open inline confirmation modal (Enter confirms, Esc cancels)
 * - Ctrl+I              : focus general comment input at bottom (Enter submits, Shift+Enter newline, Esc blurs)
 * - Ctrl+Enter          : copy XML (clipboard mode) or launch CLI & move batch to WIP (direct CLI mode)
 * - Esc / R             : close drawer
 *
 * Failed CLI batches reappear here stamped with a red `failed` badge ready to be re-sent.
 */

import { ConfirmOverlayModal } from "./confirmModal";
import { GENERAL_NOTE_PATH, isGeneralComment, ReviewComment } from "./reviewStore";
import { stripHeadingLinksToPlainText } from "./headingUtils";
import { readImageAsDataUrl } from "./commentImages";

export interface ReviewDrawerOpenOptions {
	comments: ReviewComment[];
	directCliEnabled: boolean;
	cliDisplayName: string;
	wipBatchCount?: number;
	wipCommentCount?: number;
	focusGeneralInput?: boolean;
}

export interface ReviewDrawerCallbacks {
	onAddGeneralComment: (commentText: string) => Promise<ReviewComment | null>;
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
	private wipBadgeEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private generalInputEl: HTMLTextAreaElement | null = null;
	private generalAddBtnEl: HTMLButtonElement | null = null;
	private primaryBtnEl: HTMLButtonElement | null = null;
	private clearBtnEl: HTMLButtonElement | null = null;

	private isOpenFlag: boolean = false;
	private isSubmittingGeneral: boolean = false;
	private directCliEnabled: boolean = false;
	private cliDisplayName: string = "CLI";
	private wipBatchCount: number = 0;
	private wipCommentCount: number = 0;
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
		this.parentEl.addClass("is-review-drawer-open");
		this.comments = [...options.comments];
		this.directCliEnabled = options.directCliEnabled;
		this.cliDisplayName = options.cliDisplayName || "CLI";
		this.wipBatchCount = options.wipBatchCount || 0;
		this.wipCommentCount = options.wipCommentCount || 0;
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
		const titleWrap = headerEl.createDiv({ cls: "slideflow-drawer-title-wrap" });
		this.titleEl = titleWrap.createEl("h3", {
			cls: "slideflow-drawer-title",
			text: `Review Queue (${this.comments.length})`,
		});
		this.wipBadgeEl = titleWrap.createSpan({ cls: "slideflow-drawer-wip-pill" });

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
		hintsEl.innerHTML = `<span><strong>↑↓</strong> select</span><span><strong>↵</strong> edit</span><span><strong>Del</strong> delete</span><span><strong>Ctrl+I</strong> general</span><span><strong>Ctrl+↵</strong> ${this.directCliEnabled ? `send to ${this.cliDisplayName}` : "copy XML"}</span>`;

		this.listEl = panelEl.createDiv({ cls: "slideflow-drawer-list" });
		this.renderList();

		const generalBoxEl = panelEl.createDiv({ cls: "slideflow-drawer-general-box" });
		this.generalInputEl = generalBoxEl.createEl("textarea", {
			cls: "slideflow-drawer-general-input",
			attr: {
				rows: "2",
				placeholder: "Add a general comment… (Ctrl+I · Enter to add, Shift+Enter newline)",
			},
		});
		this.generalInputEl.addEventListener("input", () => {
			this.autoResizeGeneralInput();
			this.updateGeneralAddButtonState();
		});

		this.generalAddBtnEl = generalBoxEl.createEl("button", {
			cls: "slideflow-drawer-general-add-btn",
			attr: {
				type: "button",
				title: "Add general comment (Enter)",
			},
		});
		this.generalAddBtnEl.innerHTML = `<span>Add</span> <strong>↵</strong>`;
		this.generalAddBtnEl.disabled = true;
		this.generalAddBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.submitGeneralComment();
		});

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

		if (options.focusGeneralInput) {
			window.requestAnimationFrame(() => this.focusGeneralInput());
		}
	}

	public focusGeneralInput(): void {
		if (!this.isOpenFlag || !this.generalInputEl) return;
		this.generalInputEl.focus();
		const len = this.generalInputEl.value.length;
		this.generalInputEl.setSelectionRange(len, len);
	}

	private autoResizeGeneralInput(): void {
		if (!this.generalInputEl) return;
		this.generalInputEl.style.height = "auto";
		const nextHeight = Math.min(110, Math.max(40, this.generalInputEl.scrollHeight));
		this.generalInputEl.style.height = `${nextHeight}px`;
	}

	private updateGeneralAddButtonState(): void {
		if (!this.generalAddBtnEl || !this.generalInputEl) return;
		this.generalAddBtnEl.disabled =
			this.isSubmittingGeneral || this.generalInputEl.value.trim().length === 0;
	}

	private async submitGeneralComment(): Promise<boolean> {
		if (!this.generalInputEl || this.isSubmittingGeneral) return false;
		const trimmed = this.generalInputEl.value.trim();
		if (!trimmed) return false;

		this.isSubmittingGeneral = true;
		this.updateGeneralAddButtonState();
		try {
			const created = await this.callbacks.onAddGeneralComment(trimmed);
			if (!created) return false;

			if (this.generalInputEl) {
				this.generalInputEl.value = "";
				this.autoResizeGeneralInput();
			}

			if (!this.comments.some((c) => c.id === created.id)) {
				this.comments = [...this.comments, created];
				this.renderList();
				this.updateHeaderAndFooter();
			}

			const newIdx = this.flatRows.findIndex((r) => r.comment.id === created.id);
			if (newIdx !== -1) {
				this.selectedIndex = newIdx;
				this.applySelectionHighlight(true);
			}
			return true;
		} finally {
			this.isSubmittingGeneral = false;
			this.updateGeneralAddButtonState();
		}
	}

	public refresh(
		comments: ReviewComment[],
		wipBatchCount?: number,
		wipCommentCount?: number
	): void {
		if (!this.isOpenFlag) return;
		const prevSelectedId =
			this.selectedIndex >= 0 && this.selectedIndex < this.flatRows.length
				? this.flatRows[this.selectedIndex].comment.id
				: null;

		this.comments = [...comments];
		if (wipBatchCount !== undefined) this.wipBatchCount = wipBatchCount;
		if (wipCommentCount !== undefined) this.wipCommentCount = wipCommentCount;

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
		if (this.wipBadgeEl) {
			if (this.wipBatchCount > 0) {
				this.wipBadgeEl.style.display = "inline-flex";
				this.wipBadgeEl.setText(
					`${this.wipBatchCount} ${this.cliDisplayName} WIP (${this.wipCommentCount})`
				);
				this.wipBadgeEl.setAttribute(
					"title",
					`${this.wipCommentCount} comment(s) running in background. They will auto-purge on success or reappear as failed if the process fails.`
				);
			} else {
				this.wipBadgeEl.style.display = "none";
			}
		}
		if (this.primaryBtnEl) {
			if (this.directCliEnabled) {
				const hasFailed = this.comments.some((c) => Boolean(c.failedAt || c.failedReason));
				this.primaryBtnEl.innerHTML = hasFailed
					? `<span>Send / Retry with ${this.cliDisplayName}</span> <strong>Ctrl+↵</strong>`
					: `<span>Send to ${this.cliDisplayName}</span> <strong>Ctrl+↵</strong>`;
				this.primaryBtnEl.disabled = this.comments.length === 0;
			} else {
				this.primaryBtnEl.innerHTML = `<span>Copy /one-shot (XML)</span> <strong>Ctrl+↵</strong>`;
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
			const msg =
				this.wipBatchCount > 0
					? `Queue is clear for your next project (${this.wipBatchCount} ${this.cliDisplayName} batch running in background).`
					: "No comments yet. Press C (text), V (voice), highlight text on a slide, or press Ctrl+I for a general comment.";
			this.listEl.createDiv({
				cls: "slideflow-drawer-empty",
				text: msg,
			});
			return;
		}

		const noteGroups = new Map<string, ReviewComment[]>();
		const generalItems: ReviewComment[] = [];
		for (const c of this.comments) {
			if (isGeneralComment(c)) {
				generalItems.push(c);
				continue;
			}
			const arr = noteGroups.get(c.notePath) || [];
			arr.push(c);
			noteGroups.set(c.notePath, arr);
		}

		const orderedGroups: Array<[string, ReviewComment[]]> = Array.from(noteGroups.entries());
		if (generalItems.length > 0) {
			orderedGroups.push([GENERAL_NOTE_PATH, generalItems]);
		}

		for (const [notePath, items] of orderedGroups) {
			const isGeneralGroup = notePath === GENERAL_NOTE_PATH;
			const groupEl = this.listEl.createDiv({ cls: "slideflow-drawer-group" });
			groupEl.createDiv({
				cls: `slideflow-drawer-group-title${isGeneralGroup ? " is-general" : ""}`,
				text: isGeneralGroup ? "General" : `${items[0].noteTitle} (${notePath})`,
			});

			for (const c of items) {
				const rowIdx = this.flatRows.length;
				const isGeneral = isGeneralComment(c);
				const isFailed = Boolean(c.failedAt || c.failedReason);
				const itemEl = groupEl.createDiv({
					cls: `slideflow-drawer-item${isFailed ? " is-failed" : ""}${isGeneral ? " is-general" : ""}`,
				});
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
				if (!isGeneral) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-heading",
						text: stripHeadingLinksToPlainText(c.sectionHeading) || c.sectionHeading,
					});
				}
				if (c.scopeLabel) {
					metaEl.createSpan({
						cls: `slideflow-drawer-item-scope-badge${isGeneral ? " is-general" : ""}`,
						text: c.scopeLabel,
					});
				}
				if (c.hadDiff) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-diff-badge",
						text: "+old diff",
					});
				}
				if (c.images && c.images.length > 0) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-img-badge",
						text: `${c.images.length} img`,
					});
				}
				if (isFailed) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-failed-badge",
						text: "failed",
						attr: {
							title: c.failedReason || "Previous CLI command failed — ready to retry",
						},
					});
				} else if (c.copiedAt) {
					metaEl.createSpan({
						cls: "slideflow-drawer-item-copied-badge",
						text: "copied",
					});
				}

				if (c.commentText && c.commentText.trim().length > 0) {
					itemEl.createDiv({
						cls: "slideflow-drawer-item-body",
						text: c.commentText,
					});
				}

				if (c.images && c.images.length > 0) {
					const strip = itemEl.createDiv({ cls: "slideflow-drawer-item-images" });
					for (const img of c.images) {
						const imgEl = strip.createEl("img", {
							cls: "slideflow-drawer-item-thumb",
							attr: { alt: img.fileName, title: `${img.fileName}\n${img.path}` },
						});
						void readImageAsDataUrl(img.path, img.mimeType).then((dataUrl) => {
							if (dataUrl && imgEl.isConnected) imgEl.src = dataUrl;
						});
					}
				}

				const actionsEl = itemEl.createDiv({ cls: "slideflow-drawer-item-actions" });
				const editBtn = actionsEl.createEl("button", {
					cls: "slideflow-mini-action-btn",
					text: "Edit",
					attr: {
						type: "button",
						title: isGeneral
							? "Edit general comment (Enter)"
							: "Jump to slide and edit (Enter)",
					},
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
			message: isGeneralComment(target)
				? "Remove this general comment?"
				: `Remove this comment from "${target.sectionHeading}"?`,
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
			(evt.ctrlKey || evt.metaKey) &&
			!evt.altKey &&
			!evt.shiftKey &&
			evt.key.toLowerCase() === "i"
		) {
			evt.preventDefault();
			evt.stopPropagation();
			this.focusGeneralInput();
			return;
		}

		const isInputFocused = Boolean(
			this.generalInputEl && document.activeElement === this.generalInputEl
		);
		if (isInputFocused) {
			if (evt.key === "Escape" || evt.code === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				this.generalInputEl?.blur();
				return;
			}
			if ((evt.ctrlKey || evt.metaKey) && (evt.key === "Enter" || evt.code === "Enter")) {
				evt.preventDefault();
				evt.stopPropagation();
				void (async () => {
					if (this.generalInputEl && this.generalInputEl.value.trim().length > 0) {
						await this.submitGeneralComment();
					}
					if (this.comments.length > 0) {
						await this.callbacks.onPrimaryAction();
					}
				})();
				return;
			}
			if (
				(evt.key === "Enter" || evt.code === "Enter") &&
				!evt.shiftKey &&
				!evt.ctrlKey &&
				!evt.metaKey &&
				!evt.altKey
			) {
				evt.preventDefault();
				evt.stopPropagation();
				void this.submitGeneralComment();
				return;
			}
			evt.stopPropagation();
			return;
		}

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
		this.parentEl.removeClass("is-review-drawer-open");
		if (!this.isOpenFlag && !this.backdropEl) return;
		this.isOpenFlag = false;
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		if (this.backdropEl) {
			this.backdropEl.remove();
			this.backdropEl = null;
		}
		this.titleEl = null;
		this.wipBadgeEl = null;
		this.listEl = null;
		this.generalInputEl = null;
		this.generalAddBtnEl = null;
		this.primaryBtnEl = null;
		this.clearBtnEl = null;
		this.isSubmittingGeneral = false;
		this.flatRows = [];
		this.selectedIndex = -1;
		if (invokeCallback) {
			this.callbacks.onClose();
		}
	}
}
