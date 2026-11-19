/**
 * SlideCommentsRail — Right-side floating rail of compact comment icons for the active slide
 * (Antigravity-style).
 *
 * - Resting state: displays ONLY a small circular comment icon per comment on the current slide,
 *   anchored cleanly just outside the right edge of the slide card (clamped inside the viewport
 *   on wide/zoomed slides, hidden completely when the slide has 0 comments).
 * - Hovering any icon: reveals a floating popover card with full comment text, scope/quote
 *   metadata, and two action buttons (Edit & Delete). Opens to the right of the icon when margin
 *   space allows (zero overlap over slide text), automatically flipping to the left otherwise.
 * - Hovering a selection-scoped comment also softly pulses its amber `<mark>` highlight in the slide.
 * - Clicking an icon opens Edit immediately.
 */

import { AnchorRect } from "./contextExtractor";
import { ReviewComment } from "./reviewStore";
import { readImageAsDataUrl } from "./commentImages";

export interface SlideCommentsRailCallbacks {
	onEditComment: (comment: ReviewComment, anchorRect?: AnchorRect | null) => void;
	onDeleteComment: (commentId: string) => Promise<void>;
	getSlideContainer: () => HTMLElement | null;
}

const COMMENT_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const EDIT_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const DELETE_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

export class SlideCommentsRail {
	private parentEl: HTMLElement;
	private callbacks: SlideCommentsRailCallbacks;

	private railEl: HTMLElement;
	private popoverEl: HTMLElement | null = null;
	private activeCommentId: string | null = null;
	private hideTimerId: number | null = null;
	private comments: ReviewComment[] = [];
	private boundResizeHandler: () => void;

	constructor(parentEl: HTMLElement, callbacks: SlideCommentsRailCallbacks) {
		this.parentEl = parentEl;
		this.callbacks = callbacks;
		this.railEl = this.parentEl.createDiv({ cls: "slideflow-comments-rail" });
		this.railEl.style.display = "none";
		this.railEl.addEventListener("click", (evt) => evt.stopPropagation());
		this.railEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

		this.boundResizeHandler = () => this.positionRail();
		window.addEventListener("resize", this.boundResizeHandler);
	}

	public update(comments: ReviewComment[]): void {
		this.comments = [...comments];
		this.hidePopoverImmediate();
		this.railEl.empty();

		if (this.comments.length === 0) {
			this.railEl.style.display = "none";
			return;
		}

		this.railEl.style.display = "flex";

		for (let i = 0; i < this.comments.length; i++) {
			const comment = this.comments[i];
			const isFailed = Boolean(comment.failedAt || comment.failedReason);
			const btn = this.railEl.createEl("button", {
				cls: `slideflow-rail-icon-btn${isFailed ? " is-failed" : ""}`,
				attr: {
					type: "button",
					"data-comment-id": comment.id,
					"aria-label": `Comment ${i + 1}: ${comment.commentText.slice(0, 60)}`,
				},
			});
			btn.innerHTML = COMMENT_ICON_SVG;

			btn.addEventListener("mouseenter", () => {
				this.cancelHideTimer();
				this.showPopover(comment, btn);
			});

			btn.addEventListener("mouseleave", () => {
				this.scheduleHidePopover();
			});

			btn.addEventListener("focus", () => {
				this.cancelHideTimer();
				this.showPopover(comment, btn);
			});

			btn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				const anchor = this.findHighlightAnchorRect(comment.id);
				this.hidePopoverImmediate();
				this.callbacks.onEditComment(comment, anchor);
			});
		}

		this.positionRail();
		requestAnimationFrame(() => this.positionRail());
	}

	/**
	 * Anchors the vertical icon rail right beside the right border of the active slide card
	 * (Antigravity margin style), clamping cleanly inside the viewport on wide/zoomed slides.
	 */
	public positionRail(): void {
		if (this.comments.length === 0) return;
		const container = this.callbacks.getSlideContainer();
		const railWidth = 42;
		const edgeMargin = 16;

		if (container && container.isConnected) {
			const rect = container.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				const idealLeft = rect.right + 14;
				const maxLeft = window.innerWidth - railWidth - edgeMargin;
				const clampedLeft = Math.max(edgeMargin, Math.min(idealLeft, maxLeft));
				const centerY = Math.max(
					88,
					Math.min(window.innerHeight - 110, rect.top + rect.height / 2)
				);
				this.railEl.style.left = `${Math.round(clampedLeft)}px`;
				this.railEl.style.right = "auto";
				this.railEl.style.top = `${Math.round(centerY)}px`;
				return;
			}
		}

		this.railEl.style.left = "auto";
		this.railEl.style.right = "20px";
		this.railEl.style.top = "50%";
	}

	private cancelHideTimer(): void {
		if (this.hideTimerId !== null) {
			window.clearTimeout(this.hideTimerId);
			this.hideTimerId = null;
		}
	}

	private scheduleHidePopover(): void {
		this.cancelHideTimer();
		this.hideTimerId = window.setTimeout(() => {
			this.hidePopoverImmediate();
		}, 180);
	}

	private setLinkedHighlightHover(commentId: string | null): void {
		const prev = this.parentEl.querySelectorAll("mark.slideflow-comment-mark.is-hovered-from-rail");
		prev.forEach((el) => el.removeClass("is-hovered-from-rail"));

		if (!commentId) return;
		const marks = this.parentEl.querySelectorAll(
			`mark.slideflow-comment-mark[data-comment-id="${CSS.escape(commentId)}"]`
		);
		marks.forEach((el) => el.addClass("is-hovered-from-rail"));
	}

	private findHighlightAnchorRect(commentId: string): AnchorRect | null {
		const container = this.callbacks.getSlideContainer();
		if (!container) return null;
		const mark = container.querySelector(
			`mark.slideflow-comment-mark[data-comment-id="${CSS.escape(commentId)}"]`
		) as HTMLElement | null;
		if (!mark) return null;
		const r = mark.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return null;
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
	}

	private showPopover(comment: ReviewComment, anchorBtn: HTMLElement): void {
		if (this.activeCommentId === comment.id && this.popoverEl) {
			return;
		}
		this.hidePopoverImmediate();
		this.activeCommentId = comment.id;
		anchorBtn.addClass("is-active");
		this.setLinkedHighlightHover(comment.id);

		const isFailed = Boolean(comment.failedAt || comment.failedReason);
		const pop = this.parentEl.createDiv({
			cls: `slideflow-rail-popover${isFailed ? " is-failed" : ""}`,
		});
		pop.addEventListener("click", (evt) => evt.stopPropagation());
		pop.addEventListener("mousedown", (evt) => evt.stopPropagation());
		pop.addEventListener("mouseenter", () => this.cancelHideTimer());
		pop.addEventListener("mouseleave", () => this.scheduleHidePopover());

		// Header: scope badge + diff/failed badge + Edit & Delete buttons
		const header = pop.createDiv({ cls: "slideflow-rail-popover-header" });
		const badges = header.createDiv({ cls: "slideflow-rail-popover-badges" });
		badges.createSpan({
			cls: "slideflow-rail-scope-pill",
			text: comment.scopeLabel || "Slide",
		});
		if (comment.hadDiff) {
			badges.createSpan({
				cls: "slideflow-rail-diff-pill",
				text: "+diff",
			});
		}
		if (comment.images && comment.images.length > 0) {
			badges.createSpan({
				cls: "slideflow-rail-img-pill",
				text: `${comment.images.length} img`,
			});
		}
		if (isFailed) {
			badges.createSpan({
				cls: "slideflow-rail-failed-pill",
				text: "failed",
				attr: { title: comment.failedReason || "Previous send failed" },
			});
		}

		const actions = header.createDiv({ cls: "slideflow-rail-popover-actions" });

		const editBtn = actions.createEl("button", {
			cls: "slideflow-rail-action-btn is-edit",
			attr: { type: "button", title: "Edit comment", "aria-label": "Edit comment" },
		});
		editBtn.innerHTML = `${EDIT_ICON_SVG}<span>Edit</span>`;
		editBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const anchor = this.findHighlightAnchorRect(comment.id);
			this.hidePopoverImmediate();
			this.callbacks.onEditComment(comment, anchor);
		});

		const deleteBtn = actions.createEl("button", {
			cls: "slideflow-rail-action-btn is-delete",
			attr: { type: "button", title: "Delete comment", "aria-label": "Delete comment" },
		});
		deleteBtn.innerHTML = `${DELETE_ICON_SVG}<span>Delete</span>`;
		deleteBtn.addEventListener("click", async (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.hidePopoverImmediate();
			await this.callbacks.onDeleteComment(comment.id);
		});

		// Optional short quote excerpt for selection-scoped comments
		if (comment.scopeType === "selection" && comment.selectionQuote) {
			const quoteText =
				comment.selectionQuote.length > 96
					? comment.selectionQuote.slice(0, 96) + "…"
					: comment.selectionQuote;
			pop.createDiv({
				cls: "slideflow-rail-popover-quote",
				text: `“${quoteText}”`,
			});
		}

		// Comment body
		if (comment.commentText && comment.commentText.trim().length > 0) {
			pop.createDiv({
				cls: "slideflow-rail-popover-body",
				text: comment.commentText,
			});
		}

		if (comment.images && comment.images.length > 0) {
			const strip = pop.createDiv({ cls: "slideflow-rail-popover-images" });
			for (const img of comment.images) {
				const imgEl = strip.createEl("img", {
					cls: "slideflow-rail-popover-thumb",
					attr: { alt: img.fileName, title: `${img.fileName}\n${img.path}` },
				});
				void readImageAsDataUrl(img.path, img.mimeType).then((dataUrl) => {
					if (dataUrl && imgEl.isConnected) imgEl.src = dataUrl;
				});
			}
		}

		// Prefer opening to the RIGHT of the icon when right margin fits (zero overlap over slide text!),
		// automatically flipping to the LEFT when near the viewport right edge.
		const btnRect = anchorBtn.getBoundingClientRect();
		const popWidth = 300;
		const gap = 10;
		const margin = 16;

		const spaceRight = window.innerWidth - btnRect.right - margin;
		let left: number;
		if (spaceRight >= popWidth + gap) {
			left = btnRect.right + gap;
			pop.addClass("is-placed-right");
		} else {
			left = Math.max(margin, btnRect.left - popWidth - gap);
			pop.addClass("is-placed-left");
		}

		pop.style.left = `${Math.round(left)}px`;
		pop.style.width = `${popWidth}px`;

		const measuredHeight = pop.offsetHeight || 120;
		let top = btnRect.top + btnRect.height / 2 - measuredHeight / 2;
		top = Math.max(margin, Math.min(window.innerHeight - measuredHeight - margin, top));
		pop.style.top = `${Math.round(top)}px`;

		this.popoverEl = pop;
	}

	public hidePopoverImmediate(): void {
		this.cancelHideTimer();
		this.setLinkedHighlightHover(null);
		this.railEl
			.querySelectorAll(".slideflow-rail-icon-btn.is-active")
			.forEach((el) => el.removeClass("is-active"));
		if (this.popoverEl) {
			this.popoverEl.remove();
			this.popoverEl = null;
		}
		this.activeCommentId = null;
	}

	public destroy(): void {
		window.removeEventListener("resize", this.boundResizeHandler);
		this.hidePopoverImmediate();
		this.railEl.remove();
	}
}
