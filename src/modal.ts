import { App, Component, MarkdownRenderer } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { SectionNode } from "./parser";
import { renderSlideContent, unloadSlideContent, enhanceMermaidSvgElements } from "./renderer";
import { TOCComponent, TOCVisualMeta } from "./toc";
import { applyPersistentCommentHighlights } from "./commentHighlighter";
import {
	AnchorRect,
	collectActionableLinksInBlock,
	collectReadableBlocks,
	findHoverableMarkdownBlock,
	findPreferredLinkInBlock,
} from "./contextExtractor";
import { ReviewComment } from "./reviewStore";

export const SCROLL_PHASE = -1;

const MEDIA_SELECTOR = [
	"iframe",
	"img:not(.emoji):not(.svg-icon)",
	".mermaid",
	"svg.mermaid",
	".block-language-mermaid",
	"div[class*='block-language-mermaid']",
	".pdf-embed",
	".internal-embed[src$='.pdf' i]",
	".internal-embed[src*='.pdf#' i]",
	"pre",
	"table",
	"[class*='block-language-']:not(.callout)"
].join(", ");

export interface CockpitBarState {
	hasNoteDiff: boolean;
	diffEnabled: boolean;
	dirtySlidesCount: number;
	currentSlideHasDiff: boolean;
	currentSlideCommentsCount: number;
	totalPendingCommentsCount: number;
	directCliEnabled: boolean;
}

export type InternalLinkVisualState = "normal" | "dirty" | "already-open";

export interface SlideRenderDecoration {
	overrideMarkdown?: string;
}

export class PresentationModal extends Component {
	public static readonly MIN_ZOOM: number = 0.7;
	public static readonly MAX_ZOOM: number = 2.0;
	public static readonly ZOOM_STEP: number = 0.1;

	private appRef: App;
	private overlayEl: HTMLElement;
	private mainAreaEl: HTMLElement;
	private hoverToggleBtnEl: HTMLButtonElement;
	private contentEl: HTMLElement;
	private counterEl: HTMLElement;
	private leftHoverStackEl: HTMLElement;
	private actionDockEl: HTMLElement;
	private currentSlideComponent: Component | null = null;
	private onCloseCallback?: () => void;
	public onLinkClickCallback?: (href: string) => void;
	public onExternalPdfLinkClickCallback?: (href: string) => void;
	public onSectionClickCallback?: (nodeId: string) => void;
	public onZoomChangeCallback?: (zoom: number) => void;
	public onChildHeadingClickCallback?: (nodeId: string) => void;
	public onToggleDiffClickCallback?: () => void;
	public onCommentTextClickCallback?: () => void;
	public onCommentVoiceClickCallback?: () => void;
	public onToggleHighlightClickCallback?: () => void;
	public onOpenQueueClickCallback?: () => void;
	public onCopyOneShotClickCallback?: () => void;
	public onSelectionCommentCallback?: (range: Range, startWithVoice: boolean) => void;
	public onSelectionHighlightCallback?: (range: Range) => void;
	public onHighlightCommentClickCallback?: (commentId: string, anchorRect: AnchorRect) => void;
	public onMediaZoomOpenedCallback?: () => void;
	public onMediaZoomClosedCallback?: () => void;
	public onHoveredBlockChangeCallback?: (blockEl: HTMLElement | null) => void;
	public onReadingFocusChangeCallback?: (blockEl: HTMLElement | null) => void;
	private transitionDuration: number;
	private scrollDurationMs: number = 1000;
	private tocComp: TOCComponent | null = null;
	private subNoteBannerEl: HTMLElement | null = null;

	// Bottom-left hover action controls (no emojis, English labels, bold shortcuts)
	private diffToggleBtnEl: HTMLButtonElement;
	private commentTextBtnEl: HTMLButtonElement;
	private commentVoiceBtnEl: HTMLButtonElement;
	private highlightBtnEl: HTMLButtonElement;
	private queueBtnEl: HTMLButtonElement;
	private copyBtnEl: HTMLButtonElement;

	// Floating inline selection toolbar ("Comment C | Voice V" like Antigravity)
	private selectionToolbarEl: HTMLElement | null = null;
	private pendingSelectionRange: Range | null = null;
	private boundMouseUpHandler: () => void;
	private boundKeyUpSelectionHandler: (evt: KeyboardEvent) => void;

	// Hovered Markdown block tracking (targets C / V to hovered paragraph/callout/element when cursor is inside slide)
	private hoveredBlockEl: HTMLElement | null = null;
	private hoverClearTimerId: number | null = null;
	private activeCommentBlockEl: HTMLElement | null = null;
	private boundContentMouseMoveHandler: (evt: MouseEvent) => void;
	private boundContentMouseLeaveHandler: (evt: MouseEvent) => void;

	// Keyboard reading-focus frame (ArrowDown / ArrowUp steps across paragraphs, list items, images, callouts…)
	// and Tab / Shift+Tab link cycling within the currently focused block
	private readingFocusActive: boolean = false;
	private readingFocusIndex: number = -1;
	private readingFocusBlockEl: HTMLElement | null = null;
	private focusedLinkIndex: number = -1;
	private focusedLinkEl: HTMLElement | null = null;

	public currentScrollAnimId: number | null = null;
	public currentScrollResolve: (() => void) | null = null;
	public currentTargetTop: number = 0;
	private currentScrollStartTop: number = 0;
	private currentScrollDirection: "down" | "up" | null = null;

	private mediaElements: HTMLElement[] = [];
	private activeZoomIndex: number = -1;
	private isFullDocumentMode: boolean = false;
	private zoomOverlayEl: HTMLElement | null = null;
	private zoomContentEl: HTMLElement | null = null;
	private zoomSlideComponent: Component | null = null;
	private zoomedLiveSourceEl: HTMLElement | null = null;
	private zoomedLivePlaceholder: Comment | null = null;
	// Table Zoom row selector & keyboard row navigation (ArrowUp/ArrowDown, Tab/Enter, H/C/V)
	private zoomTableRowIndex: number = -1;
	private zoomTableRowEl: HTMLTableRowElement | null = null;
	private zoomTableScrollEl: HTMLElement | null = null;
	private zoomTableSelectEl: HTMLSelectElement | null = null;
	private zoomTableCounterEl: HTMLElement | null = null;
	private zoomTablePrevBtnEl: HTMLButtonElement | null = null;
	private zoomTableNextBtnEl: HTMLButtonElement | null = null;
	private zoomTableFocusedLinkIndex: number = -1;
	private zoomTableFocusedLinkEl: HTMLElement | null = null;
	private activePdfBlobUrl: string | null = null;
	private pdfMutationObserver: MutationObserver | null = null;
	private pdfKickTimers: number[] = [];
	private pdfReflowInProgress: boolean = false;
	private pdfReflowDone: boolean = false;
	private pdfWheelBodyEl: HTMLElement | null = null;
	private boundPdfWheelHandler: ((evt: WheelEvent) => void) | null = null;
	private currentSourcePath: string = "";
	private hasCompletedAllSteps: boolean = false;

	private zoomLevel: number = 1.0;
	private zoomToolbarEl: HTMLElement | null = null;
	private zoomOutBtnEl: HTMLButtonElement | null = null;
	private zoomInBtnEl: HTMLButtonElement | null = null;
	private zoomValueBtnEl: HTMLButtonElement | null = null;

	constructor(
		app: App,
		onClose?: () => void,
		transitionDuration: number = 0.65,
		scrollDurationMs: number = 1000,
		initialZoom: number = 1.0
	) {
		super();
		this.appRef = app;
		this.onCloseCallback = onClose;
		this.transitionDuration = transitionDuration;
		this.scrollDurationMs = scrollDurationMs;
		this.zoomLevel = Math.max(
			PresentationModal.MIN_ZOOM,
			Math.min(PresentationModal.MAX_ZOOM, Math.round(initialZoom * 100) / 100)
		);

		this.overlayEl = document.body.createDiv({ cls: "dynamic-slides-overlay" });

		// Bottom-left hover zone: Sub-note banner (when nested) + Action Dock + TOC toggle
		// Slides smoothly in from the left only on mouse hover.
		const bottomLeftZone = this.overlayEl.createDiv({ cls: "dynamic-slides-bottom-left-zone" });
		this.leftHoverStackEl = bottomLeftZone.createDiv({ cls: "slideflow-left-hover-stack" });

		this.actionDockEl = this.leftHoverStackEl.createDiv({ cls: "slideflow-action-dock" });
		const actionDockEl = this.actionDockEl;
		const leftStackEl = this.leftHoverStackEl;

		this.diffToggleBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-diff-btn",
			attr: { type: "button", title: "Toggle diff view (D · N next diff)" }
		});
		this.diffToggleBtnEl.innerHTML = `<span>Diff</span> <strong>D</strong>`;
		this.diffToggleBtnEl.style.display = "none";
		this.diffToggleBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onToggleDiffClickCallback?.();
		});

		this.commentTextBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-comment-btn",
			attr: { type: "button", title: "Comment on visible slide or selection (C)" }
		});
		this.commentTextBtnEl.innerHTML = `<span>Comment</span> <strong>C</strong>`;
		this.commentTextBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onCommentTextClickCallback?.();
		});

		this.commentVoiceBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-voice-btn",
			attr: { type: "button", title: "Voice comment with Faster-Whisper GPU (V)" }
		});
		this.commentVoiceBtnEl.innerHTML = `<span>Voice</span> <strong>V</strong>`;
		this.commentVoiceBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onCommentVoiceClickCallback?.();
		});

		this.highlightBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-highlight-btn",
			attr: { type: "button", title: "Toggle persistent ==highlight== in note (H)" }
		});
		this.highlightBtnEl.innerHTML = `<span>Highlight</span> <strong>H</strong>`;
		this.highlightBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onToggleHighlightClickCallback?.();
		});

		this.queueBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-queue-btn",
			attr: { type: "button", title: "Open review queue (R)" }
		});
		this.queueBtnEl.innerHTML = `<span>Queue</span> <strong>R</strong>`;
		this.queueBtnEl.style.display = "none";
		this.queueBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onOpenQueueClickCallback?.();
		});

		this.copyBtnEl = actionDockEl.createEl("button", {
			cls: "slideflow-dock-btn slideflow-copy-btn",
			attr: { type: "button", title: "Copy all review comments for /one-shot (Ctrl+Enter)" }
		});
		this.copyBtnEl.innerHTML = `<span>Copy</span> <strong>Ctrl+↵</strong>`;
		this.copyBtnEl.style.display = "none";
		this.copyBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onCopyOneShotClickCallback?.();
		});

		this.hoverToggleBtnEl = leftStackEl.createEl("button", {
			text: "Table of contents",
			cls: "dynamic-slides-toc-hover-toggle",
			attr: { type: "button", "aria-label": "Toggle TOC" }
		});
		this.hoverToggleBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.tocComp) {
				this.tocComp.toggleSidebar();
			}
		});

		// Bottom-right Zoom Zone & Toolbar (slides smoothly in from the right on hover)
		const bottomRightZone = this.overlayEl.createDiv({ cls: "dynamic-slides-bottom-right-zone" });
		this.zoomToolbarEl = bottomRightZone.createDiv({ cls: "dynamic-slides-zoom-toolbar" });

		this.zoomOutBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-btn zoom-out",
			text: "−",
			attr: { type: "button", "aria-label": "Zoom out (-10%)", title: "Zoom out (-10%) [-]" }
		});
		this.zoomOutBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.zoomOut();
		});

		this.zoomValueBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-value",
			text: `${Math.round(this.zoomLevel * 100)}%`,
			attr: { type: "button", "aria-label": "Reset zoom (100%)", title: "Reset zoom to 100% [0]" }
		});
		this.zoomValueBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.resetZoom();
		});

		this.zoomInBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-btn zoom-in",
			text: "+",
			attr: { type: "button", "aria-label": "Zoom in (+10%)", title: "Zoom in (+10%) [+]" }
		});
		this.zoomInBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.zoomIn();
		});

		this.applyZoom(false);

		this.mainAreaEl = this.overlayEl.createDiv({ cls: "dynamic-slides-main-area" });
		this.contentEl = this.mainAreaEl.createDiv({ cls: "dynamic-slides-content" });
		this.contentEl.style.transition = "opacity 0.15s ease";
		this.counterEl = this.mainAreaEl.createDiv({ cls: "dynamic-slides-footer-counter" });

		this.contentEl.addEventListener('click', (evt) => {
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
				// User just finished highlighting text — don't accidentally open media zoom or click links
				return;
			}

			const rawTarget = evt.target as Node | null;
			const target =
				rawTarget instanceof HTMLElement ? rawTarget : rawTarget?.parentElement ?? null;
			if (!target) return;

			const commentMarkEl = target.closest("mark.slideflow-comment-mark") as HTMLElement | null;
			if (commentMarkEl && this.shouldCommentMarkHandleClick(target, commentMarkEl, evt)) {
				const commentId = commentMarkEl.getAttribute("data-comment-id");
				if (commentId) {
					evt.preventDefault();
					evt.stopPropagation();
					const r = commentMarkEl.getBoundingClientRect();
					this.onHighlightCommentClickCallback?.(commentId, {
						left: r.left,
						top: r.top,
						right: r.right,
						bottom: r.bottom,
					});
					return;
				}
			}

			const directChildLinkEl = target.closest(
				".dynamic-slides-child-heading a.internal-link"
			) as HTMLElement | null;
			if (directChildLinkEl) {
				if (
					directChildLinkEl.classList.contains("slideflow-link-already-open") ||
					directChildLinkEl.getAttribute("aria-disabled") === "true"
				) {
					evt.preventDefault();
					evt.stopPropagation();
					return;
				}
				const href =
					directChildLinkEl.getAttribute("data-href") ||
					directChildLinkEl.getAttribute("href");
				if (href) {
					evt.preventDefault();
					evt.stopPropagation();
					this.onLinkClickCallback?.(href);
					return;
				}
			}

			const childHeadingEl = target.closest('.dynamic-slides-child-heading') as HTMLElement;
			if (childHeadingEl) {
				const nodeId = childHeadingEl.getAttribute('data-node-id');
				if (nodeId) {
					evt.preventDefault();
					evt.stopPropagation();
					if (this.onChildHeadingClickCallback) {
						this.onChildHeadingClickCallback(nodeId);
					} else if (this.onSectionClickCallback) {
						this.onSectionClickCallback(nodeId);
					}
					return;
				}
			}

			const linkEl = target.closest('.internal-link') as HTMLElement;
			if (linkEl) {
				if (
					linkEl.classList.contains("slideflow-link-already-open") ||
					linkEl.getAttribute("aria-disabled") === "true"
				) {
					evt.preventDefault();
					evt.stopPropagation();
					return;
				}
				const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
				if (href) {
					evt.preventDefault();
					evt.stopPropagation();
					if (this.onLinkClickCallback) {
						this.onLinkClickCallback(href);
					}
				}
				return;
			}

			const extLinkEl = target.closest('a[href]') as HTMLAnchorElement | null;
			if (extLinkEl) {
				const href = (extLinkEl.getAttribute('href') || '').trim();
				const cleanBeforeHash = href.split('#')[0].split('?')[0].toLowerCase();
				if (cleanBeforeHash.endsWith('.pdf')) {
					evt.preventDefault();
					evt.stopPropagation();
					if (/^file:\/\//i.test(href)) {
						this.onExternalPdfLinkClickCallback?.(href);
					} else {
						this.onLinkClickCallback?.(href);
					}
					return;
				}
				if (href && href !== '#' && !/^javascript:/i.test(href)) {
					// Let native browser/Obsidian link navigation proceed without triggering media/table zoom underneath
					return;
				}
			}

			if (target.closest('.callout-icon, .svg-icon, .dynamic-slides-child-heading, .internal-link, summary, .slideflow-details-copy-btn')) return;

			if (target.closest('details, .slideflow-details')) return;

			const zoomableEl = target.closest(MEDIA_SELECTOR) as HTMLElement;
			if (zoomableEl) {
				const zoomableList = this.detectMediaElements();
				const matchedEl = zoomableList.find(item => item === zoomableEl || item.contains(zoomableEl));
				if (matchedEl) {
					if (this.isLivePluginBlock(matchedEl)) {
						// Live interactive plugins visible directly on a slide (e.g. only-zoomable slides)
						// must receive native clicks/drags without SlideFlow hijacking the click into zoom.
						return;
					}
					const index = zoomableList.indexOf(matchedEl);
					if (index !== -1) {
						evt.preventDefault();
						evt.stopPropagation();
						this.openMediaZoom(index);
					}
				}
			}
		});

		this.boundMouseUpHandler = () => {
			window.setTimeout(() => this.handleSelectionChange(), 10);
		};
		this.boundKeyUpSelectionHandler = (evt: KeyboardEvent) => {
			if (evt.shiftKey || evt.key === "Shift") {
				window.setTimeout(() => this.handleSelectionChange(), 10);
			}
		};
		window.addEventListener("mouseup", this.boundMouseUpHandler);
		window.addEventListener("keyup", this.boundKeyUpSelectionHandler);
		this.contentEl.addEventListener("scroll", () => {
			this.hideSelectionToolbar();
			this.clearHoveredBlock();
		});

		this.boundContentMouseMoveHandler = (evt: MouseEvent) => {
			if (
				this.isMediaZoomActive() ||
				this.overlayEl.hasClass("is-comment-modal-open") ||
				this.overlayEl.hasClass("is-review-drawer-open")
			) {
				this.clearHoveredBlock();
				return;
			}
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
				this.clearHoveredBlock();
				return;
			}
			this.cancelHoverClear();
			const nextBlock = findHoverableMarkdownBlock(evt.target, this.contentEl);
			this.setHoveredBlock(nextBlock);
		};
		this.boundContentMouseLeaveHandler = (evt: MouseEvent) => {
			const rect = this.contentEl.getBoundingClientRect();
			const exitingTowardRightRail =
				evt.clientX >= rect.right - 2 &&
				evt.clientX <= rect.right + 64 &&
				evt.clientY >= rect.top - 12 &&
				evt.clientY <= rect.bottom + 12;
			if (exitingTowardRightRail) {
				this.scheduleHoverClear(170);
			} else {
				this.clearHoveredBlock();
			}
		};
		this.contentEl.addEventListener("mousemove", this.boundContentMouseMoveHandler);
		this.contentEl.addEventListener("mouseleave", this.boundContentMouseLeaveHandler);
	}

	private isClickInsideMarkTextContent(
		markEl: HTMLElement,
		clientX: number,
		clientY: number
	): boolean {
		const range = document.createRange();
		range.selectNodeContents(markEl);
		const rects = Array.from(range.getClientRects());
		if (rects.length === 0) {
			return true;
		}
		return rects.some(
			(r) =>
				r.width > 0 &&
				r.height > 0 &&
				clientX >= r.left &&
				clientX <= r.right &&
				clientY >= r.top &&
				clientY <= r.bottom
		);
	}

	/**
	 * Decides whether a click on `<mark class="slideflow-comment-mark">` should open the comment
	 * editor or let an associated link handle navigation:
	 * - Normal non-link highlight -> always opens the comment.
	 * - Full-link highlight (`<mark class="is-link-highlight"><a>text</a></mark>`):
	 *   clicking the link text (`<a>` or descendant) opens the link; clicking the outer yellow
	 *   contour (`<mark>` padding/border outside `<a>`) opens the comment.
	 * - Partial-link highlight (`<a>...<mark class="is-partial-in-link">text</mark>...</a>`):
	 *   clicking the text glyphs opens the link; clicking the yellow contour opens the comment.
	 */
	private shouldCommentMarkHandleClick(
		target: HTMLElement,
		commentMarkEl: HTMLElement,
		evt: MouseEvent
	): boolean {
		const linkEl = target.closest(
			"a[href], a.internal-link, .internal-link, .slideflow-child-heading-linked-title"
		) as HTMLElement | null;
		if (!linkEl) {
			return true;
		}
		if (commentMarkEl.contains(linkEl)) {
			return false;
		}
		if (linkEl.contains(commentMarkEl)) {
			return !this.isClickInsideMarkTextContent(commentMarkEl, evt.clientX, evt.clientY);
		}
		return false;
	}

	private setHoveredBlock(nextBlock: HTMLElement | null): void {
		if (nextBlock === this.hoveredBlockEl) return;
		if (this.hoveredBlockEl) {
			this.hoveredBlockEl.removeClass("slideflow-hover-target-block");
		}
		this.hoveredBlockEl = nextBlock;
		if (this.hoveredBlockEl) {
			this.hoveredBlockEl.addClass("slideflow-hover-target-block");
		}
		this.onHoveredBlockChangeCallback?.(this.hoveredBlockEl);
	}

	public getHoveredBlockElement(): HTMLElement | null {
		if (this.hoveredBlockEl && this.hoveredBlockEl.isConnected && this.contentEl.contains(this.hoveredBlockEl)) {
			return this.hoveredBlockEl;
		}
		return null;
	}

	public cancelHoverClear(): void {
		if (this.hoverClearTimerId !== null) {
			window.clearTimeout(this.hoverClearTimerId);
			this.hoverClearTimerId = null;
		}
	}

	public scheduleHoverClear(delayMs: number = 170): void {
		this.cancelHoverClear();
		this.hoverClearTimerId = window.setTimeout(() => {
			this.hoverClearTimerId = null;
			this.setHoveredBlock(null);
		}, delayMs);
	}

	public clearHoveredBlock(): void {
		this.cancelHoverClear();
		this.setHoveredBlock(null);
	}

	public setActiveCommentBlock(blockEl: HTMLElement | null): void {
		if (this.activeCommentBlockEl) {
			this.activeCommentBlockEl.removeClass("slideflow-active-comment-block");
		}
		this.activeCommentBlockEl = blockEl && blockEl.isConnected ? blockEl : null;
		if (this.activeCommentBlockEl) {
			this.activeCommentBlockEl.addClass("slideflow-active-comment-block");
		}
	}

	public isReadingFocusActive(): boolean {
		return this.readingFocusActive;
	}

	public getReadingFocusIndex(): number {
		return this.readingFocusIndex;
	}

	public getReadingFocusBlockElement(): HTMLElement | null {
		if (!this.readingFocusActive) return null;
		if (
			this.readingFocusBlockEl &&
			this.readingFocusBlockEl.isConnected &&
			this.contentEl.contains(this.readingFocusBlockEl)
		) {
			return this.readingFocusBlockEl;
		}
		return null;
	}

	public hasFocusedLink(): boolean {
		return Boolean(
			this.readingFocusActive &&
				this.focusedLinkEl &&
				this.focusedLinkEl.isConnected &&
				this.contentEl.contains(this.focusedLinkEl)
		);
	}

	public getFocusedLinkIndex(): number {
		return this.hasFocusedLink() ? this.focusedLinkIndex : -1;
	}

	public clearFocusedLink(): void {
		if (this.focusedLinkEl) {
			this.focusedLinkEl.removeClass("slideflow-focused-link");
			this.focusedLinkEl = null;
		}
		this.focusedLinkIndex = -1;
	}

	private setFocusedLinkElement(linkEl: HTMLElement | null, idx: number): void {
		if (this.focusedLinkEl && this.focusedLinkEl !== linkEl) {
			this.focusedLinkEl.removeClass("slideflow-focused-link");
		}
		this.focusedLinkEl = linkEl && linkEl.isConnected ? linkEl : null;
		this.focusedLinkIndex = this.focusedLinkEl ? idx : -1;
		if (this.focusedLinkEl) {
			this.focusedLinkEl.addClass("slideflow-focused-link");
			try {
				this.focusedLinkEl.scrollIntoView({
					block: "nearest",
					inline: "nearest",
					behavior: "smooth",
				});
			} catch {
				// ignore if not supported
			}
		}
	}

	public stepFocusedLink(direction: "next" | "prev"): boolean {
		if (this.isMediaZoomActive() || !this.readingFocusActive) return false;
		const blockEl = this.getReadingFocusBlockElement();
		if (!blockEl) return false;

		const links = collectActionableLinksInBlock(blockEl, this.contentEl);
		if (links.length === 0) {
			this.clearFocusedLink();
			return false;
		}

		// Blur any previously clicked SlideFlow UI button so Enter never triggers an unrelated control
		if (
			document.activeElement instanceof HTMLButtonElement &&
			this.overlayEl.contains(document.activeElement) &&
			!document.activeElement.closest(
				".slideflow-live-plugin-host, .slideflow-live-plugin-el, [class*='block-language-']"
			)
		) {
			document.activeElement.blur();
		}

		const liveIdx = this.focusedLinkEl ? links.indexOf(this.focusedLinkEl) : -1;
		let nextIdx: number;
		if (liveIdx === -1) {
			nextIdx = direction === "next" ? 0 : links.length - 1;
		} else {
			nextIdx =
				direction === "next"
					? (liveIdx + 1) % links.length
					: (liveIdx - 1 + links.length) % links.length;
		}

		this.setFocusedLinkElement(links[nextIdx], nextIdx);
		return true;
	}

	private setReadingFocusBlock(blockEl: HTMLElement | null, scrollIntoView: boolean): void {
		if (this.readingFocusBlockEl !== blockEl) {
			this.clearFocusedLink();
		}
		if (this.readingFocusBlockEl && this.readingFocusBlockEl !== blockEl) {
			this.readingFocusBlockEl.removeClass("slideflow-reading-focus-block");
		}
		this.readingFocusBlockEl = blockEl && blockEl.isConnected ? blockEl : null;
		if (this.readingFocusBlockEl) {
			this.readingFocusBlockEl.addClass("slideflow-reading-focus-block");
			if (scrollIntoView) {
				this.scrollReadingBlockIntoView(this.readingFocusBlockEl);
			}
		}
		this.onReadingFocusChangeCallback?.(this.readingFocusBlockEl);
	}

	private scrollReadingBlockIntoView(blockEl: HTMLElement): void {
		if (!this.contentEl || !blockEl.isConnected) return;
		const containerRect = this.contentEl.getBoundingClientRect();
		const blockRect = blockEl.getBoundingClientRect();
		const padTop = 56;
		const padBottom = 64;

		const isAbove = blockRect.top < containerRect.top + padTop;
		const isBelow = blockRect.bottom > containerRect.bottom - padBottom;
		if (!isAbove && !isBelow) return;

		const relTop = blockRect.top - containerRect.top + this.contentEl.scrollTop;
		let targetTop: number;
		if (blockRect.height >= containerRect.height - padTop - padBottom) {
			// Tall block (e.g. long code block / table): align its top comfortably near top of viewport
			targetTop = Math.max(0, relTop - 28);
		} else if (isBelow) {
			// Place focused block cleanly in the middle/lower-middle of viewport
			targetTop = relTop - Math.round((containerRect.height - blockRect.height) * 0.42);
		} else {
			// Scrolling upwards: bring focused block comfortably into upper-middle of viewport
			targetTop = relTop - Math.round((containerRect.height - blockRect.height) * 0.35);
		}
		void this.animateScrollTo(targetTop, Math.min(320, Math.round(this.scrollDurationMs * 0.4)));
	}

	public stepReadingFocus(direction: "down" | "up"): void {
		if (!this.contentEl) return;
		const blocks = collectReadableBlocks(this.contentEl);
		if (blocks.length === 0) return;

		this.clearHoveredBlock();

		// Blur any previously clicked SlideFlow UI button so Enter on a focused block without links
		// never accidentally triggers an unrelated dock/TOC button.
		if (
			document.activeElement instanceof HTMLButtonElement &&
			this.overlayEl.contains(document.activeElement) &&
			!document.activeElement.closest(
				".slideflow-live-plugin-host, .slideflow-live-plugin-el, [class*='block-language-']"
			)
		) {
			document.activeElement.blur();
		}

		let targetIdx: number;
		if (!this.readingFocusActive) {
			this.readingFocusActive = true;
			if (this.contentEl.scrollTop <= 12) {
				targetIdx = 0;
			} else {
				const containerTop = this.contentEl.getBoundingClientRect().top;
				const firstVisible = blocks.findIndex(
					(b) => b.getBoundingClientRect().bottom > containerTop + 16
				);
				targetIdx = firstVisible >= 0 ? firstVisible : 0;
			}
		} else {
			const liveIdx = this.readingFocusBlockEl ? blocks.indexOf(this.readingFocusBlockEl) : -1;
			const baseIdx = liveIdx >= 0 ? liveIdx : Math.max(0, Math.min(this.readingFocusIndex, blocks.length - 1));
			targetIdx =
				direction === "down"
					? Math.min(blocks.length - 1, baseIdx + 1)
					: Math.max(0, baseIdx - 1);
		}

		this.readingFocusIndex = targetIdx;
		this.setReadingFocusBlock(blocks[targetIdx], true);
	}

	private restoreReadingFocusAfterRender(
		preferredIndex: number,
		scrollIntoView: boolean = false,
		preferredLinkIndex?: number
	): void {
		if (!this.readingFocusActive || !this.contentEl) return;
		const applyNow = () => {
			if (!this.readingFocusActive || !this.contentEl) return;
			const blocks = collectReadableBlocks(this.contentEl);
			if (blocks.length === 0) {
				this.readingFocusIndex = -1;
				this.setReadingFocusBlock(null, false);
				return;
			}
			const clamped = Math.max(0, Math.min(preferredIndex, blocks.length - 1));
			this.readingFocusIndex = clamped;
			const targetBlock = blocks[clamped];
			this.setReadingFocusBlock(targetBlock, scrollIntoView && clamped > 0);
			if (typeof preferredLinkIndex === "number" && preferredLinkIndex >= 0) {
				const links = collectActionableLinksInBlock(targetBlock, this.contentEl);
				if (links.length > 0) {
					const linkIdx = Math.min(preferredLinkIndex, links.length - 1);
					this.setFocusedLinkElement(links[linkIdx], linkIdx);
				}
			}
		};
		applyNow();
		requestAnimationFrame(() => {
			if (this.readingFocusActive && (!this.readingFocusBlockEl || !this.readingFocusBlockEl.isConnected)) {
				applyNow();
			} else if (this.readingFocusActive && this.readingFocusBlockEl) {
				this.onReadingFocusChangeCallback?.(this.readingFocusBlockEl);
			}
		});
	}

	public clearReadingFocus(): void {
		this.clearFocusedLink();
		this.readingFocusActive = false;
		this.readingFocusIndex = -1;
		this.setReadingFocusBlock(null, false);
	}

	private activateLinkElement(linkEl: HTMLElement): boolean {
		if (
			linkEl.classList.contains("slideflow-link-already-open") ||
			linkEl.getAttribute("aria-disabled") === "true"
		) {
			return false;
		}
		if (linkEl.classList.contains("internal-link")) {
			const href = (linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "").trim();
			if (!href) return false;
			this.onLinkClickCallback?.(href);
			return true;
		}

		if (linkEl.classList.contains("slideflow-child-heading-linked-title")) {
			const href = (linkEl.getAttribute("data-link-href") || "").trim();
			if (!href) return false;
			this.onLinkClickCallback?.(href);
			return true;
		}

		const href = (linkEl.getAttribute("href") || "").trim();
		if (!href || href === "#" || /^javascript:/i.test(href)) {
			return false;
		}

		const cleanBeforeHash = href.split("#")[0].split("?")[0].toLowerCase();
		if (cleanBeforeHash.endsWith(".pdf")) {
			if (/^file:\/\//i.test(href)) {
				this.onExternalPdfLinkClickCallback?.(href);
			} else {
				this.onLinkClickCallback?.(href);
			}
			return true;
		}

		// External / URI link: dispatch via an anchor mounted outside contentEl so Obsidian/Electron
		// opens it natively without contentEl's click handler (comment marks / media zoom / selection) intercepting it.
		const tempAnchor = document.createElement("a");
		tempAnchor.href = href;
		tempAnchor.className = linkEl.className || "external-link";
		const targetAttr = linkEl.getAttribute("target");
		if (targetAttr) {
			tempAnchor.target = targetAttr;
		} else if (/^https?:\/\//i.test(href)) {
			tempAnchor.target = "_blank";
		}
		tempAnchor.rel = linkEl.getAttribute("rel") || "noopener noreferrer";
		tempAnchor.style.position = "fixed";
		tempAnchor.style.left = "-9999px";
		tempAnchor.style.top = "-9999px";
		document.body.appendChild(tempAnchor);
		try {
			tempAnchor.click();
		} finally {
			tempAnchor.remove();
		}
		return true;
	}

	/**
	 * Triggered by plain `Enter` when reading-focus mode is active:
	 * opens the explicitly Tab-selected link if one is highlighted, otherwise opens the first link
	 * with an active green unread-diff dot inside the focused block, else the first link inside
	 * the focused block (or navigates a focused child heading).
	 */
	public activateReadingFocusLink(): boolean {
		if (this.isMediaZoomActive()) return false;
		const blockEl = this.getReadingFocusBlockElement();
		if (!blockEl) return false;

		if (
			this.focusedLinkEl &&
			this.focusedLinkEl.isConnected &&
			blockEl.contains(this.focusedLinkEl)
		) {
			return this.activateLinkElement(this.focusedLinkEl);
		}

		const targetLink = findPreferredLinkInBlock(blockEl, this.contentEl);
		if (targetLink) {
			return this.activateLinkElement(targetLink);
		}

		if (blockEl.tagName.toLowerCase() === "details") {
			const detailsEl = blockEl as HTMLDetailsElement;
			detailsEl.open = !detailsEl.open;
			return true;
		}

		if (
			blockEl.classList.contains("dynamic-slides-child-heading") &&
			!blockEl.classList.contains("is-empty-heading-leaf")
		) {
			const nodeId = blockEl.getAttribute("data-node-id");
			if (nodeId) {
				if (this.onChildHeadingClickCallback) {
					this.onChildHeadingClickCallback(nodeId);
					return true;
				}
				if (this.onSectionClickCallback) {
					this.onSectionClickCallback(nodeId);
					return true;
				}
			}
		}

		return false;
	}

	public getContentElement(): HTMLElement {
		return this.contentEl;
	}

	public getZoomContentElement(): HTMLElement | null {
		return this.zoomContentEl;
	}

	public getActiveZoomIndex(): number {
		return this.activeZoomIndex;
	}

	public getActiveSelectionRange(): Range | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
		const txt = sel.toString().trim();
		if (!txt) return null;
		const range = sel.getRangeAt(0);
		const common = range.commonAncestorContainer;
		const inSlide = this.contentEl.contains(common);
		const inZoom = Boolean(this.zoomContentEl && this.zoomContentEl.contains(common));
		if (!inSlide && !inZoom) return null;
		return range.cloneRange();
	}

	private handleSelectionChange(): void {
		const range = this.getActiveSelectionRange();
		if (!range) {
			this.hideSelectionToolbar();
			return;
		}
		this.pendingSelectionRange = range;
		this.showSelectionToolbar(range);
	}

	private showSelectionToolbar(range: Range): void {
		this.hideSelectionToolbar(false);
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return;

		const bar = this.overlayEl.createDiv({ cls: "slideflow-selection-toolbar" });
		bar.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		bar.addEventListener("click", (evt) => evt.stopPropagation());

		const commentBtn = bar.createEl("button", {
			cls: "slideflow-sel-btn",
			attr: { type: "button" },
		});
		commentBtn.innerHTML = `<span>Comment</span> <strong>C</strong>`;
		commentBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const captured = this.pendingSelectionRange?.cloneRange() || range.cloneRange();
			this.hideSelectionToolbar(true);
			window.getSelection()?.removeAllRanges();
			this.onSelectionCommentCallback?.(captured, false);
		});

		const voiceBtn = bar.createEl("button", {
			cls: "slideflow-sel-btn",
			attr: { type: "button" },
		});
		voiceBtn.innerHTML = `<span>Voice</span> <strong>V</strong>`;
		voiceBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const captured = this.pendingSelectionRange?.cloneRange() || range.cloneRange();
			this.hideSelectionToolbar(true);
			window.getSelection()?.removeAllRanges();
			this.onSelectionCommentCallback?.(captured, true);
		});

		const highlightBtn = bar.createEl("button", {
			cls: "slideflow-sel-btn slideflow-sel-highlight-btn",
			attr: { type: "button", title: "Save ==highlight== in note (H)" },
		});
		highlightBtn.innerHTML = `<span>Highlight</span> <strong>H</strong>`;
		highlightBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const captured = this.pendingSelectionRange?.cloneRange() || range.cloneRange();
			this.hideSelectionToolbar(true);
			window.getSelection()?.removeAllRanges();
			this.onSelectionHighlightCallback?.(captured);
		});

		const estW = 285;
		const left = Math.max(12, Math.min(window.innerWidth - estW - 12, rect.right - estW));
		const top = rect.bottom + 8 + 40 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - 44);
		bar.style.left = `${Math.round(left)}px`;
		bar.style.top = `${Math.round(top)}px`;

		this.selectionToolbarEl = bar;
	}

	public hideSelectionToolbar(clearPending: boolean = true): void {
		if (this.selectionToolbarEl) {
			this.selectionToolbarEl.remove();
			this.selectionToolbarEl = null;
		}
		if (clearPending) {
			this.pendingSelectionRange = null;
		}
	}

	public updateCockpitBar(state: CockpitBarState): void {
		if (state.hasNoteDiff) {
			this.diffToggleBtnEl.style.display = "inline-flex";
			this.diffToggleBtnEl.innerHTML = state.diffEnabled
				? `<span>Diff on</span> <strong>D</strong>`
				: `<span>Diff off</span> <strong>D</strong>`;
			this.diffToggleBtnEl.toggleClass("is-active", state.diffEnabled);
		} else {
			this.diffToggleBtnEl.style.display = "none";
		}

		if (state.currentSlideCommentsCount > 0) {
			this.commentTextBtnEl.innerHTML = `<span>Comment (${state.currentSlideCommentsCount})</span> <strong>C</strong>`;
			this.commentTextBtnEl.addClass("has-comments");
		} else {
			this.commentTextBtnEl.innerHTML = `<span>Comment</span> <strong>C</strong>`;
			this.commentTextBtnEl.removeClass("has-comments");
		}

		if (state.totalPendingCommentsCount > 0) {
			this.queueBtnEl.style.display = "inline-flex";
			this.queueBtnEl.innerHTML = `<span>Queue (${state.totalPendingCommentsCount})</span> <strong>R</strong>`;
		} else {
			this.queueBtnEl.style.display = "none";
		}

		if (state.directCliEnabled) {
			if (state.currentSlideHasDiff) {
				this.copyBtnEl.style.display = "inline-flex";
				this.copyBtnEl.innerHTML = `<span>Validate diff</span> <strong>Ctrl+↵</strong>`;
				this.copyBtnEl.setAttribute("title", "Validate slide diff (Ctrl+Enter)");
			} else {
				this.copyBtnEl.style.display = "none";
			}
		} else {
			if (state.currentSlideHasDiff && state.totalPendingCommentsCount > 0) {
				this.copyBtnEl.style.display = "inline-flex";
				this.copyBtnEl.innerHTML = `<span>Validate & Copy</span> <strong>Ctrl+↵</strong>`;
				this.copyBtnEl.setAttribute("title", "Validate slide diff & copy all XML comments (Ctrl+Enter)");
			} else if (state.currentSlideHasDiff) {
				this.copyBtnEl.style.display = "inline-flex";
				this.copyBtnEl.innerHTML = `<span>Validate diff</span> <strong>Ctrl+↵</strong>`;
				this.copyBtnEl.setAttribute("title", "Validate slide diff (Ctrl+Enter)");
			} else if (state.totalPendingCommentsCount > 0) {
				this.copyBtnEl.style.display = "inline-flex";
				this.copyBtnEl.innerHTML = `<span>Copy</span> <strong>Ctrl+↵</strong>`;
				this.copyBtnEl.setAttribute("title", "Copy all XML comments for /one-shot (Ctrl+Enter)");
			} else {
				this.copyBtnEl.style.display = "none";
			}
		}
	}

	public setZoom(zoom: number, triggerCallback: boolean = true): void {
		const clamped = Math.max(
			PresentationModal.MIN_ZOOM,
			Math.min(PresentationModal.MAX_ZOOM, Math.round(zoom * 100) / 100)
		);
		if (Math.abs(this.zoomLevel - clamped) > 0.001) {
			this.zoomLevel = clamped;
			this.applyZoom(triggerCallback);
		}
	}

	public zoomIn(): void {
		this.setZoom(this.zoomLevel + PresentationModal.ZOOM_STEP);
	}

	public zoomOut(): void {
		this.setZoom(this.zoomLevel - PresentationModal.ZOOM_STEP);
	}

	public resetZoom(): void {
		this.setZoom(1.0);
	}

	public getZoom(): number {
		return this.zoomLevel;
	}

	private applyZoom(triggerCallback: boolean = true): void {
		this.overlayEl.style.setProperty('--dynamic-slides-zoom', `${this.zoomLevel}`);
		if (this.zoomValueBtnEl) {
			this.zoomValueBtnEl.setText(`${Math.round(this.zoomLevel * 100)}%`);
		}
		if (this.zoomOutBtnEl) {
			this.zoomOutBtnEl.disabled = this.zoomLevel <= PresentationModal.MIN_ZOOM;
		}
		if (this.zoomInBtnEl) {
			this.zoomInBtnEl.disabled = this.zoomLevel >= PresentationModal.MAX_ZOOM;
		}
		if (triggerCallback && this.onZoomChangeCallback) {
			this.onZoomChangeCallback(this.zoomLevel);
		}
	}

	public setTOC(toc: TOCComponent) {
		this.tocComp = toc;
		this.tocComp.setToggleBtn(this.hoverToggleBtnEl);
	}

	public setCounter(current: number, total: number) {
		this.counterEl.setText(`Slide ${current} / ${total}`);
	}

	public getOverlayElement(): HTMLElement {
		return this.overlayEl;
	}

	public showSubNoteBanner(noteTitle: string, onReturn: () => void) {
		this.hideSubNoteBanner();
		this.overlayEl.addClass("is-subnote");

		const bannerEl = document.createElement("div");
		bannerEl.className = "dynamic-slides-subnote-banner";
		this.leftHoverStackEl.insertBefore(bannerEl, this.actionDockEl);
		this.subNoteBannerEl = bannerEl;

		bannerEl.createDiv({ cls: "dynamic-slides-subnote-tag", text: "Sub-note" });
		bannerEl.createDiv({ cls: "dynamic-slides-subnote-title", text: noteTitle });
		const returnBtn = bannerEl.createEl("button", {
			cls: "dynamic-slides-subnote-return-btn",
			attr: { type: "button", title: "Return to parent note (Esc)" }
		});
		returnBtn.innerHTML = `<span>Return</span> <strong>Esc</strong>`;

		returnBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onReturn();
		});
	}

	public hideSubNoteBanner() {
		this.overlayEl.removeClass("is-subnote");
		if (this.subNoteBannerEl) {
			this.subNoteBannerEl.remove();
			this.subNoteBannerEl = null;
		}
	}

	public canScrollDown(): boolean {
		if (!this.contentEl) return false;
		return this.contentEl.scrollTop + this.contentEl.clientHeight < this.contentEl.scrollHeight - 10;
	}

	public canScrollUp(): boolean {
		if (!this.contentEl) return false;
		return this.contentEl.scrollTop > 10;
	}

	public setScrollDuration(durationMs: number) {
		this.scrollDurationMs = durationMs;
	}

	public cancelScrollAnimation(snapToTarget: boolean = true) {
		if (this.currentScrollAnimId !== null) {
			cancelAnimationFrame(this.currentScrollAnimId);
			this.currentScrollAnimId = null;
		}
		this.currentScrollDirection = null;
		if (snapToTarget && this.contentEl) {
			this.contentEl.scrollTop = this.currentTargetTop;
		}
		if (this.currentScrollResolve) {
			const resolve = this.currentScrollResolve;
			this.currentScrollResolve = null;
			resolve();
		}
	}

	public animateScrollTo(targetTop: number, durationMs: number = this.scrollDurationMs): Promise<void> {
		this.cancelScrollAnimation(false);

		return new Promise((resolve) => {
			if (!this.contentEl) {
				resolve();
				return;
			}
			const maxScrollTop = Math.max(0, this.contentEl.scrollHeight - this.contentEl.clientHeight);
			const clampedTarget = Math.max(0, Math.min(targetTop, maxScrollTop));

			const startTop = this.contentEl.scrollTop;
			const distance = clampedTarget - startTop;

			this.currentStartTopOrSet(startTop, clampedTarget, distance);
			this.currentScrollResolve = resolve;

			if (Math.abs(distance) < 1) {
				this.contentEl.scrollTop = clampedTarget;
				this.currentScrollDirection = null;
				this.currentScrollResolve = null;
				resolve();
				return;
			}

			const effectiveDuration = Math.max(120, durationMs);
			const startTime = performance.now();
			const easeInOutSine = (t: number): number => 0.5 * (1 - Math.cos(Math.PI * t));

			const step = (currentTime: number) => {
				const elapsed = currentTime - startTime;
				const progress = Math.min(1, Math.max(0, elapsed / effectiveDuration));
				const easedProgress = easeInOutSine(progress);

				this.contentEl.scrollTop = startTop + distance * easedProgress;

				if (progress < 1) {
					this.currentScrollAnimId = requestAnimationFrame(step);
				} else {
					this.contentEl.scrollTop = clampedTarget;
					this.currentScrollAnimId = null;
					this.currentScrollDirection = null;
					if (this.currentScrollResolve) {
						const res = this.currentScrollResolve;
						this.currentScrollResolve = null;
						res();
					}
				}
			};

			this.currentScrollAnimId = requestAnimationFrame(step);
		});
	}

	private currentStartTopOrSet(startTop: number, targetTop: number, distance: number): void {
		this.currentScrollStartTop = startTop;
		this.currentTargetTop = targetTop;
		this.currentScrollDirection = distance > 0 ? "down" : distance < 0 ? "up" : null;
	}

	public scrollDown(): void {
		if (!this.contentEl) return;
		const targetTop = this.contentEl.scrollTop + this.contentEl.clientHeight * 0.5;
		this.animateScrollTo(targetTop, this.scrollDurationMs);
	}

	public scrollUp(): void {
		if (!this.contentEl) return;
		const targetTop = this.contentEl.scrollTop - this.contentEl.clientHeight * 0.5;
		this.animateScrollTo(targetTop, this.scrollDurationMs);
	}

	private isMermaidElement(el: HTMLElement): boolean {
		return (
			el.matches(
				".mermaid, svg.mermaid, .block-language-mermaid, [class*='block-language-mermaid'], [class*='language-mermaid']"
			) ||
			el.querySelector(
				".mermaid, svg.mermaid, .block-language-mermaid, [class*='block-language-mermaid']"
			) !== null
		);
	}

	private isLivePluginBlock(el: HTMLElement): boolean {
		if (el.matches(".callout")) return false;
		if (this.isMermaidElement(el)) return false;
		// Any Obsidian registerMarkdownCodeBlockProcessor() plugin renders inside `.block-language-<lang>`
		if (el.matches("[class*='block-language-']")) {
			return true;
		}
		// Also preserve live DOM for post-processor widgets containing interactive controls
		const tag = el.tagName.toLowerCase();
		if (
			tag !== "pre" &&
			tag !== "img" &&
			tag !== "iframe" &&
			el.querySelector(
				"button:not(.copy-code-button), input, select, textarea, canvas, [draggable='true']"
			) !== null
		) {
			return true;
		}
		return false;
	}

	private extractPluginBlockLanguage(el: HTMLElement): string {
		const cls = Array.from(el.classList).find((c) => c.startsWith("block-language-"));
		return cls ? cls.replace(/^block-language-/, "") : "";
	}

	private restoreZoomedLiveElement(leaveClosingGhost: boolean = false): void {
		const liveEl = this.zoomedLiveSourceEl;
		const placeholder = this.zoomedLivePlaceholder;
		this.zoomedLiveSourceEl = null;
		this.zoomedLivePlaceholder = null;

		if (liveEl) {
			const activeEl = document.activeElement;
			if (activeEl instanceof HTMLElement && liveEl.contains(activeEl)) {
				try {
					activeEl.blur();
				} catch {
					// ignore
				}
			}
			if (leaveClosingGhost && liveEl.parentElement) {
				const ghost = liveEl.cloneNode(true) as HTMLElement;
				ghost.style.pointerEvents = "none";
				liveEl.parentElement.replaceChild(ghost, liveEl);
			}
			liveEl.removeClass("slideflow-live-plugin-el");
			if (placeholder && placeholder.parentNode) {
				placeholder.parentNode.insertBefore(liveEl, placeholder);
				placeholder.parentNode.removeChild(placeholder);
			} else if (liveEl.parentNode) {
				liveEl.parentNode.removeChild(liveEl);
			}
		} else if (placeholder && placeholder.parentNode) {
			placeholder.parentNode.removeChild(placeholder);
		}
	}

	public detectMediaElements(): HTMLElement[] {
		if (!this.contentEl) return [];
		const raw = Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(MEDIA_SELECTOR)
		);
		const filtered = raw.filter(el => {
			if (
				el.closest(".callout-icon") ||
				el.closest(".dynamic-slides-toc-fold-icon") ||
				el.closest("details, .slideflow-details") ||
				el.classList.contains("callout-icon") ||
				el.classList.contains("svg-icon") ||
				el.classList.contains("emoji")
			) {
				return false;
			}
			return !raw.some(other => other !== el && other.contains(el));
		});

		// Preserve exact document-order media index while a live plugin element is temporarily reparented into zoom
		if (
			this.zoomedLiveSourceEl &&
			this.zoomedLivePlaceholder &&
			this.contentEl.contains(this.zoomedLivePlaceholder) &&
			!filtered.includes(this.zoomedLiveSourceEl)
		) {
			const placeholderInsideMatched = filtered.some((item) =>
				item.contains(this.zoomedLivePlaceholder!)
			);
			if (!placeholderInsideMatched) {
				const insertIdx = filtered.findIndex((item) =>
					Boolean(
						this.zoomedLivePlaceholder!.compareDocumentPosition(item) &
							Node.DOCUMENT_POSITION_FOLLOWING
					)
				);
				if (insertIdx === -1) {
					filtered.push(this.zoomedLiveSourceEl);
				} else {
					filtered.splice(insertIdx, 0, this.zoomedLiveSourceEl);
				}
			}
		}

		this.mediaElements = filtered;
		return filtered;
	}

	public checkOnlyZoomableContent(): boolean {
		if (!this.contentEl) return false;
		const clone = this.contentEl.cloneNode(true) as HTMLElement;
		clone.querySelectorAll("h1, h2, h3, h4, h5, h6, .dynamic-slides-child-heading").forEach(el => el.remove());
		clone.querySelectorAll(MEDIA_SELECTOR).forEach(el => el.remove());
		const text = clone.textContent?.trim() || "";
		return text.length === 0;
	}

	public isMediaZoomActive(): boolean {
		return this.zoomOverlayEl !== null;
	}

	public isPdfZoomActive(): boolean {
		return Boolean(this.zoomContentEl?.querySelector(".dynamic-slides-zoom-pdf"));
	}

	public isTableZoomActive(): boolean {
		return Boolean(this.zoomContentEl?.querySelector(".dynamic-slides-zoom-table table"));
	}

	public getZoomTableElement(): HTMLTableElement | null {
		return this.zoomContentEl?.querySelector<HTMLTableElement>(".dynamic-slides-zoom-table table") ?? null;
	}

	public getZoomTableRows(): HTMLTableRowElement[] {
		const tableEl = this.getZoomTableElement();
		if (!tableEl) return [];
		const tbodyRows = Array.from(tableEl.querySelectorAll<HTMLTableRowElement>("tbody tr"));
		if (tbodyRows.length > 0) return tbodyRows;
		return Array.from(tableEl.querySelectorAll<HTMLTableRowElement>("tr")).filter((tr) =>
			Boolean(tr.querySelector("td"))
		);
	}

	public getZoomTableRowIndex(): number {
		return this.getZoomTableRowElement() ? this.zoomTableRowIndex : -1;
	}

	public getZoomTableRowElement(): HTMLTableRowElement | null {
		if (
			this.zoomTableRowEl &&
			this.zoomTableRowEl.isConnected &&
			this.zoomContentEl?.contains(this.zoomTableRowEl)
		) {
			return this.zoomTableRowEl;
		}
		return null;
	}

	public hasZoomTableRowSelection(): boolean {
		return this.getZoomTableRowElement() !== null;
	}

	public hasZoomTableFocusedLink(): boolean {
		return Boolean(
			this.zoomTableFocusedLinkEl &&
				this.zoomTableFocusedLinkEl.isConnected &&
				this.zoomContentEl?.contains(this.zoomTableFocusedLinkEl)
		);
	}

	public clearZoomTableFocusedLink(): void {
		if (this.zoomTableFocusedLinkEl) {
			this.zoomTableFocusedLinkEl.removeClass("slideflow-focused-link");
			this.zoomTableFocusedLinkEl = null;
		}
		this.zoomTableFocusedLinkIndex = -1;
	}

	public stepZoomTableFocusedLink(direction: "next" | "prev"): boolean {
		if (!this.isTableZoomActive()) return false;
		const rowEl = this.getZoomTableRowElement();
		if (!rowEl || !this.zoomContentEl) return false;
		const links = collectActionableLinksInBlock(rowEl, this.zoomContentEl);
		if (links.length === 0) {
			this.clearZoomTableFocusedLink();
			return false;
		}
		const liveIdx = this.zoomTableFocusedLinkEl ? links.indexOf(this.zoomTableFocusedLinkEl) : -1;
		const nextIdx =
			liveIdx === -1
				? direction === "next"
					? 0
					: links.length - 1
				: direction === "next"
					? (liveIdx + 1) % links.length
					: (liveIdx - 1 + links.length) % links.length;

		if (this.zoomTableFocusedLinkEl && this.zoomTableFocusedLinkEl !== links[nextIdx]) {
			this.zoomTableFocusedLinkEl.removeClass("slideflow-focused-link");
		}
		this.zoomTableFocusedLinkEl = links[nextIdx];
		this.zoomTableFocusedLinkIndex = nextIdx;
		this.zoomTableFocusedLinkEl.addClass("slideflow-focused-link");
		try {
			this.zoomTableFocusedLinkEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
		} catch {
			// ignore
		}
		return true;
	}

	public activateZoomTableRowLink(): boolean {
		if (!this.isTableZoomActive() || !this.zoomContentEl) return false;
		const rowEl = this.getZoomTableRowElement();
		if (!rowEl) return false;
		if (
			this.zoomTableFocusedLinkEl &&
			this.zoomTableFocusedLinkEl.isConnected &&
			rowEl.contains(this.zoomTableFocusedLinkEl)
		) {
			return this.activateLinkElement(this.zoomTableFocusedLinkEl);
		}
		const preferred = findPreferredLinkInBlock(rowEl, this.zoomContentEl);
		if (preferred) {
			return this.activateLinkElement(preferred);
		}
		return false;
	}

	public getActiveTableIndexInSlide(): number {
		if (!this.contentEl) return 0;
		const allTables = Array.from(this.contentEl.querySelectorAll<HTMLTableElement>("table"));
		if (allTables.length <= 1) return 0;
		const media = this.detectMediaElements();
		const srcMedia = this.activeZoomIndex >= 0 ? media[this.activeZoomIndex] : null;
		if (!srcMedia) return 0;
		const srcTable =
			srcMedia.tagName.toLowerCase() === "table"
				? (srcMedia as HTMLTableElement)
				: srcMedia.querySelector<HTMLTableElement>("table");
		const idx = srcTable ? allTables.indexOf(srcTable) : -1;
		return idx >= 0 ? idx : 0;
	}

	private resetTableZoomState(): void {
		this.clearZoomTableFocusedLink();
		if (this.zoomTableRowEl) {
			this.zoomTableRowEl.removeClass("slideflow-table-row-selected");
			this.zoomTableRowEl = null;
		}
		this.zoomTableRowIndex = -1;
		this.zoomTableScrollEl = null;
		this.zoomTableSelectEl = null;
		this.zoomTableCounterEl = null;
		this.zoomTablePrevBtnEl = null;
		this.zoomTableNextBtnEl = null;
	}

	private syncTableZoomSelectorUI(): void {
		const rows = this.getZoomTableRows();
		const total = rows.length;
		const idx = this.zoomTableRowEl && this.zoomTableRowEl.isConnected ? this.zoomTableRowIndex : -1;

		if (this.zoomTableSelectEl) {
			this.zoomTableSelectEl.value = String(idx);
		}
		if (this.zoomTableCounterEl) {
			this.zoomTableCounterEl.setText(idx >= 0 ? `Row ${idx + 1} / ${total}` : `${total} rows`);
		}
		if (this.zoomTablePrevBtnEl) {
			this.zoomTablePrevBtnEl.disabled = total === 0 || idx === 0;
		}
		if (this.zoomTableNextBtnEl) {
			this.zoomTableNextBtnEl.disabled = total === 0 || (idx >= 0 && idx >= total - 1);
		}
	}

	private scrollTableZoomRowIntoView(rowEl: HTMLTableRowElement): void {
		const scroller = this.zoomTableScrollEl;
		if (!scroller || !rowEl.isConnected) return;
		const thead = this.getZoomTableElement()?.querySelector("thead");
		const stickyHeaderH = thead ? thead.getBoundingClientRect().height : 0;
		const scrollerRect = scroller.getBoundingClientRect();
		const rowRect = rowEl.getBoundingClientRect();

		const visibleTop = scrollerRect.top + stickyHeaderH + 10;
		const visibleBottom = scrollerRect.bottom - 16;

		if (rowRect.top < visibleTop) {
			const delta = rowRect.top - visibleTop;
			scroller.scrollTo({
				top: Math.max(0, scroller.scrollTop + delta - 12),
				behavior: "smooth",
			});
		} else if (rowRect.bottom > visibleBottom) {
			const delta = rowRect.bottom - visibleBottom;
			scroller.scrollTo({
				top: scroller.scrollTop + delta + 12,
				behavior: "smooth",
			});
		}
	}

	public selectTableZoomRow(index: number, scrollIntoView: boolean = true): boolean {
		const rows = this.getZoomTableRows();
		if (rows.length === 0) return false;
		if (index < 0) {
			this.clearTableZoomRowSelection();
			return true;
		}
		const clamped = Math.max(0, Math.min(index, rows.length - 1));
		const nextRow = rows[clamped];

		if (this.zoomTableRowEl !== nextRow) {
			this.clearZoomTableFocusedLink();
		}
		if (this.zoomTableRowEl && this.zoomTableRowEl !== nextRow) {
			this.zoomTableRowEl.removeClass("slideflow-table-row-selected");
		}
		this.zoomTableRowEl = nextRow;
		this.zoomTableRowIndex = clamped;
		this.zoomTableRowEl.addClass("slideflow-table-row-selected");

		if (scrollIntoView) {
			this.scrollTableZoomRowIntoView(nextRow);
		}
		this.syncTableZoomSelectorUI();
		return true;
	}

	public stepTableZoomRow(direction: "down" | "up"): boolean {
		const rows = this.getZoomTableRows();
		if (rows.length === 0) return false;

		if (
			document.activeElement instanceof HTMLElement &&
			this.zoomOverlayEl?.contains(document.activeElement)
		) {
			try {
				document.activeElement.blur();
			} catch {
				// ignore
			}
		}

		let targetIdx: number;
		const liveIdx = this.zoomTableRowEl ? rows.indexOf(this.zoomTableRowEl) : -1;
		if (liveIdx === -1) {
			const scroller = this.zoomTableScrollEl;
			if (scroller && scroller.scrollTop > 12) {
				const thead = this.getZoomTableElement()?.querySelector("thead");
				const stickyH = thead ? thead.getBoundingClientRect().height : 0;
				const topBound = scroller.getBoundingClientRect().top + stickyH + 4;
				const firstVisible = rows.findIndex((r) => r.getBoundingClientRect().bottom > topBound);
				targetIdx = firstVisible >= 0 ? firstVisible : 0;
			} else {
				targetIdx = direction === "down" ? 0 : rows.length - 1;
			}
		} else {
			targetIdx =
				direction === "down"
					? Math.min(rows.length - 1, liveIdx + 1)
					: Math.max(0, liveIdx - 1);
		}

		return this.selectTableZoomRow(targetIdx, true);
	}

	public clearTableZoomRowSelection(): void {
		this.clearZoomTableFocusedLink();
		if (this.zoomTableRowEl) {
			this.zoomTableRowEl.removeClass("slideflow-table-row-selected");
			this.zoomTableRowEl = null;
		}
		this.zoomTableRowIndex = -1;
		this.syncTableZoomSelectorUI();
	}

	private buildTableRowOptionLabel(rowEl: HTMLTableRowElement, index: number): string {
		const cells = Array.from(rowEl.children).filter(
			(c) => c.tagName.toLowerCase() === "td" || c.tagName.toLowerCase() === "th"
		) as HTMLElement[];
		const cleanCell = (el: HTMLElement | undefined): string =>
			(el?.textContent || "").replace(/\s+/g, " ").trim();

		const first = cleanCell(cells[0]);
		const second = cleanCell(cells[1]);
		let summary = first || second || `Row ${index + 1}`;
		if (first && second && first.length < 24) {
			summary = `${first} · ${second}`;
		}
		if (summary.length > 58) {
			summary = `${summary.slice(0, 57)}…`;
		}
		return `${index + 1}. ${summary}`;
	}

	private mountTableZoomSelectorBar(wrapper: HTMLElement, tableEl: HTMLTableElement): void {
		const rows = this.getZoomTableRows();
		const bar = document.createElement("div");
		bar.className = "slideflow-table-selector-bar";
		bar.addEventListener("click", (evt) => evt.stopPropagation());
		bar.addEventListener("mousedown", (evt) => evt.stopPropagation());

		const leftGroup = bar.createDiv({ cls: "slideflow-table-selector-controls" });

		const prevBtn = leftGroup.createEl("button", {
			cls: "slideflow-table-step-btn",
			text: "↑",
			attr: { type: "button", title: "Previous row (ArrowUp)", "aria-label": "Previous row" },
		});
		prevBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.stepTableZoomRow("up");
		});

		const nextBtn = leftGroup.createEl("button", {
			cls: "slideflow-table-step-btn",
			text: "↓",
			attr: { type: "button", title: "Next row (ArrowDown)", "aria-label": "Next row" },
		});
		nextBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.stepTableZoomRow("down");
		});

		const selectEl = leftGroup.createEl("select", {
			cls: "slideflow-table-row-select",
			attr: { "aria-label": "Select table row", title: "Jump to a table row" },
		});
		const defaultOpt = document.createElement("option");
		defaultOpt.value = "-1";
		defaultOpt.textContent = rows.length > 0 ? `Row selector (${rows.length} rows)` : "Empty table";
		selectEl.appendChild(defaultOpt);

		rows.forEach((tr, idx) => {
			const opt = document.createElement("option");
			opt.value = String(idx);
			opt.textContent = this.buildTableRowOptionLabel(tr, idx);
			selectEl.appendChild(opt);
		});

		selectEl.addEventListener("change", () => {
			const parsed = parseInt(selectEl.value, 10);
			if (Number.isNaN(parsed) || parsed < 0) {
				this.clearTableZoomRowSelection();
			} else {
				this.selectTableZoomRow(parsed, true);
			}
			selectEl.blur();
		});

		const counterEl = leftGroup.createSpan({
			cls: "slideflow-table-row-count",
			text: `${rows.length} rows`,
		});

		const hintsEl = bar.createDiv({ cls: "slideflow-table-hints" });
		hintsEl.innerHTML = `<span><strong>↑/↓</strong> Row</span><span><strong>↵</strong> Open</span><span><strong>H</strong> Highlight</span><span><strong>C</strong> Comment</span>`;

		wrapper.insertBefore(bar, wrapper.firstChild);

		this.zoomTableSelectEl = selectEl;
		this.zoomTableCounterEl = counterEl;
		this.zoomTablePrevBtnEl = prevBtn;
		this.zoomTableNextBtnEl = nextBtn;
		this.syncTableZoomSelectorUI();
	}

	private getPdfScrollContainer(): HTMLElement | null {
		if (!this.zoomContentEl) return null;
		return this.zoomContentEl.querySelector<HTMLElement>(
			".slideflow-pdf-frame-body .pdf-viewer-container"
		);
	}

	public scrollPdfZoom(direction: "down" | "up", stepFraction: number = 0.72): boolean {
		if (!this.zoomContentEl) return false;
		// External file:/// PDF rendered via iframe: keep PDF zoom open on Arrow keys (Escape closes it).
		if (this.zoomContentEl.querySelector("iframe.slideflow-pdf-iframe")) {
			return true;
		}
		const viewer = this.getPdfScrollContainer();
		const body = this.zoomContentEl.querySelector<HTMLElement>(".slideflow-pdf-frame-body");
		if (!viewer) {
			return true;
		}
		const maxScroll = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
		if (maxScroll <= 4) {
			// If PDF.js pages exist (or are still hydrating) but scrollHeight is not unlocked yet,
			// trigger an on-demand 280ms resize reflow instead of closing the PDF zoom!
			if (body) {
				this.triggerRealPdfResizeReflow(body, true);
			}
			return true;
		}

		const delta = Math.max(120, Math.round(viewer.clientHeight * stepFraction));
		const current = viewer.scrollTop;
		const target =
			direction === "down"
				? Math.min(maxScroll, current + delta)
				: Math.max(0, current - delta);
		if (Math.abs(target - current) >= 2) {
			viewer.scrollTo({ top: target, behavior: "smooth" });
		}
		return true;
	}

	private cleanupZoomResources(leaveClosingGhost: boolean = false): void {
		this.resetTableZoomState();
		this.restoreZoomedLiveElement(leaveClosingGhost);
		if (this.pdfWheelBodyEl && this.boundPdfWheelHandler) {
			this.pdfWheelBodyEl.removeEventListener("wheel", this.boundPdfWheelHandler);
			this.pdfWheelBodyEl = null;
			this.boundPdfWheelHandler = null;
		}
		if (this.pdfMutationObserver) {
			this.pdfMutationObserver.disconnect();
			this.pdfMutationObserver = null;
		}
		for (const id of this.pdfKickTimers) {
			window.clearTimeout(id);
		}
		this.pdfKickTimers = [];
		this.pdfReflowInProgress = false;
		this.pdfReflowDone = false;
		if (this.zoomSlideComponent) {
			unloadSlideContent(this.zoomSlideComponent, this);
			this.zoomSlideComponent = null;
		}
		if (this.activePdfBlobUrl) {
			try {
				URL.revokeObjectURL(this.activePdfBlobUrl);
			} catch {
				// ignore
			}
			this.activePdfBlobUrl = null;
		}
	}

	/**
	 * Performs a real 280ms container width change (> Obsidian's 200ms debounced ResizeObserver
	 * on `.pdf-container`) so Obsidian fires `onResize()` with a genuinely distinct width,
	 * bypassing PDF.js `_isSameScale()` early-return and forcing full page/scrollbar layout.
	 */
	private triggerRealPdfResizeReflow(body: HTMLElement, force: boolean = false): void {
		if (!body.isConnected) return;
		if (this.pdfReflowInProgress) return;
		if (this.pdfReflowDone && !force) return;

		const embedEl = body.querySelector<HTMLElement>(".pdf-embed, .internal-embed");
		if (embedEl && embedEl.style.height) {
			embedEl.style.removeProperty("height");
		}
		const viewerEl = body.querySelector<HTMLElement>(".pdf-viewer-container");
		if (!viewerEl) return;

		this.pdfReflowInProgress = true;
		viewerEl.style.overflowY = "auto";
		viewerEl.style.overflowX = "auto";
		if (!viewerEl.hasAttribute("tabindex")) {
			viewerEl.setAttribute("tabindex", "-1");
		}

		// Phase 1: shrink content width by 14px and HOLD for 280ms so Obsidian's 200ms debounced ResizeObserver fires!
		body.style.boxSizing = "border-box";
		body.style.paddingRight = "14px";
		void body.offsetWidth;
		try {
			viewerEl.dispatchEvent(new Event("transitionend"));
		} catch {
			// ignore
		}
		try {
			this.appRef.workspace.trigger("resize");
			window.dispatchEvent(new Event("resize"));
		} catch {
			// ignore
		}

		const restoreId = window.setTimeout(() => {
			if (!body.isConnected) {
				this.pdfReflowInProgress = false;
				return;
			}
			const curEmbed = body.querySelector<HTMLElement>(".pdf-embed, .internal-embed");
			if (curEmbed && curEmbed.style.height) {
				curEmbed.style.removeProperty("height");
			}
			// Phase 2: restore full width -> triggers a second ResizeObserver + PDF.js reflow at exact 100% width
			body.style.removeProperty("padding-right");
			void body.offsetWidth;
			const curViewer = body.querySelector<HTMLElement>(".pdf-viewer-container");
			if (curViewer) {
				curViewer.style.overflowY = "auto";
				curViewer.style.overflowX = "auto";
				try {
					curViewer.dispatchEvent(new Event("transitionend"));
				} catch {
					// ignore
				}
			}
			try {
				this.appRef.workspace.trigger("resize");
				window.dispatchEvent(new Event("resize"));
			} catch {
				// ignore
			}
			const finishId = window.setTimeout(() => {
				this.pdfReflowInProgress = false;
				const v = body.querySelector<HTMLElement>(".pdf-viewer-container");
				if (v && v.scrollHeight > v.clientHeight + 8) {
					this.pdfReflowDone = true;
				}
			}, 260);
			this.pdfKickTimers.push(finishId);
		}, 280);
		this.pdfKickTimers.push(restoreId);
	}

	/**
	 * Hydrates Obsidian's native PDF.js viewer once mounted inside the zoom overlay:
	 * Obsidian initializes `.pdf-embed` asynchronously (`initDelay: 300ms`, `height: "page"`)
	 * inside a 0x0 offscreen `loadingEl` and observes `.pdf-container` with a 200ms debounced
	 * ResizeObserver. We strip Obsidian's inline 1-page height override, run a real 280ms width
	 * reflow once pages mount (matching what opening a right-docked comment modal previously did),
	 * and install a wheel safeguard so mouse-wheel scrolling always moves `.pdf-viewer-container`.
	 */
	private schedulePdfViewerHydration(body: HTMLElement): void {
		const normalizeEmbedAndFocus = (focusViewer: boolean): boolean => {
			if (!body.isConnected) return false;
			const embedEl = body.querySelector<HTMLElement>(".pdf-embed, .internal-embed");
			if (embedEl && embedEl.style.height) {
				embedEl.style.removeProperty("height");
			}
			const viewerEl = body.querySelector<HTMLElement>(".pdf-viewer-container");
			if (!viewerEl) return false;

			if (!viewerEl.hasAttribute("tabindex")) {
				viewerEl.setAttribute("tabindex", "-1");
			}
			viewerEl.style.overflowY = "auto";
			viewerEl.style.overflowX = "auto";

			if (
				focusViewer &&
				!this.overlayEl.hasClass("is-comment-modal-open") &&
				!this.overlayEl.hasClass("is-review-drawer-open")
			) {
				try {
					viewerEl.focus({ preventScroll: true });
				} catch {
					// ignore
				}
			}
			const hasPages = Boolean(body.querySelector(".pdfViewer .page"));
			const isScrollable = viewerEl.scrollHeight > viewerEl.clientHeight + 8;
			return hasPages && isScrollable;
		};

		// Non-intrusive wheel safeguard: preserves native trackpad/wheel smooth scroll when Chromium
		// handles it, and transparently drives `.pdf-viewer-container` if the event lands outside
		// `.pdf-viewer-container` or if Electron's compositor drops wheel scrolling inside the fixed overlay.
		const wheelHandler = (evt: WheelEvent) => {
			if (evt.ctrlKey || evt.metaKey || Math.abs(evt.deltaY) < 0.5) return;
			const target = evt.target instanceof HTMLElement ? evt.target : null;
			if (target?.closest(".pdf-sidebar-container, .pdf-toolbar")) return;
			const viewerEl = body.querySelector<HTMLElement>(".pdf-viewer-container");
			if (!viewerEl) return;

			const maxScroll = Math.max(0, viewerEl.scrollHeight - viewerEl.clientHeight);
			if (maxScroll <= 4) {
				this.triggerRealPdfResizeReflow(body, true);
				return;
			}
			const dy =
				evt.deltaMode === 1
					? evt.deltaY * 32
					: evt.deltaMode === 2
						? evt.deltaY * viewerEl.clientHeight
						: evt.deltaY;

			if (!target || !viewerEl.contains(target)) {
				evt.preventDefault();
				viewerEl.scrollTop = Math.max(0, Math.min(maxScroll, viewerEl.scrollTop + dy));
				return;
			}

			const beforeTop = viewerEl.scrollTop;
			const canMove = (dy > 0 && beforeTop < maxScroll - 1) || (dy < 0 && beforeTop > 1);
			if (!canMove) return;

			let appliedFallback = false;
			const applyIfStuck = () => {
				if (appliedFallback || !viewerEl.isConnected) return;
				appliedFallback = true;
				if (Math.abs(viewerEl.scrollTop - beforeTop) < 0.5) {
					viewerEl.scrollTop = Math.max(0, Math.min(maxScroll, beforeTop + dy));
				}
			};
			requestAnimationFrame(applyIfStuck);
			window.setTimeout(applyIfStuck, 32);
		};
		this.pdfWheelBodyEl = body;
		this.boundPdfWheelHandler = wheelHandler;
		body.addEventListener("wheel", wheelHandler, { passive: false });

		let pagesDetected = false;
		this.pdfMutationObserver = new MutationObserver(() => {
			const embedEl = body.querySelector<HTMLElement>(".pdf-embed, .internal-embed");
			if (embedEl && embedEl.style.height) {
				embedEl.style.removeProperty("height");
			}
			const hasPages = Boolean(body.querySelector(".pdfViewer .page"));
			const ready = normalizeEmbedAndFocus(!pagesDetected);
			if (hasPages && !pagesDetected) {
				pagesDetected = true;
				const reflowTimer = window.setTimeout(() => {
					this.triggerRealPdfResizeReflow(body, true);
				}, 120);
				this.pdfKickTimers.push(reflowTimer);
			}
			if (ready && this.pdfReflowDone) {
				this.pdfMutationObserver?.disconnect();
				this.pdfMutationObserver = null;
			}
		});
		this.pdfMutationObserver.observe(body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["style"],
		});

		// Timed fallbacks covering Obsidian PDF embed initDelay (300ms) + large multi-page PDF loading
		for (const delay of [480, 1150, 2300, 4000]) {
			const id = window.setTimeout(() => {
				const ready = normalizeEmbedAndFocus(delay <= 1150);
				if (!ready || !this.pdfReflowDone) {
					this.triggerRealPdfResizeReflow(body, !ready);
				}
			}, delay);
			this.pdfKickTimers.push(id);
		}
		// Safety disconnect cap so MutationObserver never lingers
		const capId = window.setTimeout(() => {
			this.pdfMutationObserver?.disconnect();
			this.pdfMutationObserver = null;
		}, 6500);
		this.pdfKickTimers.push(capId);
	}

	private ensureZoomOverlay(animated: boolean): void {
		this.hideSelectionToolbar();
		this.clearHoveredBlock();
		this.overlayEl
			.querySelectorAll(".dynamic-slides-media-zoom-overlay.is-closing")
			.forEach((el) => el.remove());
		this.overlayEl.addClass("is-media-zoom-active");
		if (this.contentEl) {
			this.contentEl.style.opacity = "0";
		}
		if (!this.zoomOverlayEl) {
			this.zoomOverlayEl = this.overlayEl.createDiv({ cls: "dynamic-slides-media-zoom-overlay" });
			if (!animated) {
				this.zoomOverlayEl.style.animation = "none";
				this.zoomOverlayEl.addClass("is-settled");
			} else {
				const overlayRef = this.zoomOverlayEl;
				overlayRef.addEventListener(
					"animationend",
					(evt) => {
						if (evt.target === overlayRef) {
							overlayRef.addClass("is-settled");
						}
					},
					{ once: true }
				);
			}
			const closeBtn = this.zoomOverlayEl.createEl("button", {
				cls: "dynamic-slides-zoom-close-btn",
				text: "✕",
				attr: { type: "button", "aria-label": "Close zoom" }
			});
			closeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
			});

			this.zoomContentEl = this.zoomOverlayEl.createDiv({ cls: "dynamic-slides-media-zoom-content" });
			this.zoomOverlayEl.addEventListener("click", (evt) => {
				const sel = window.getSelection();
				if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
					return;
				}
				const rawTarget = evt.target as Node | null;
				const target =
					rawTarget instanceof HTMLElement ? rawTarget : rawTarget?.parentElement ?? null;
				if (!target) return;
				const commentMarkEl = target.closest("mark.slideflow-comment-mark") as HTMLElement | null;
				if (commentMarkEl && this.shouldCommentMarkHandleClick(target, commentMarkEl, evt)) {
					const commentId = commentMarkEl.getAttribute("data-comment-id");
					if (commentId) {
						evt.preventDefault();
						evt.stopPropagation();
						const r = commentMarkEl.getBoundingClientRect();
						this.onHighlightCommentClickCallback?.(commentId, {
							left: r.left,
							top: r.top,
							right: r.right,
							bottom: r.bottom,
						});
						return;
					}
				}
				if (target.closest(".slideflow-table-selector-bar")) {
					return;
				}
				const linkEl = target.closest(".internal-link") as HTMLElement | null;
				if (linkEl) {
					if (
						linkEl.classList.contains("slideflow-link-already-open") ||
						linkEl.getAttribute("aria-disabled") === "true"
					) {
						evt.preventDefault();
						evt.stopPropagation();
						return;
					}
					const href = linkEl.getAttribute("data-href") || linkEl.getAttribute("href");
					if (href) {
						evt.preventDefault();
						evt.stopPropagation();
						this.onLinkClickCallback?.(href);
						return;
					}
				}
				const extLinkEl = target.closest("a[href]") as HTMLAnchorElement | null;
				if (extLinkEl) {
					const href = extLinkEl.getAttribute("href") || "";
					const cleanBeforeHash = href.split("#")[0].split("?")[0].toLowerCase();
					if (cleanBeforeHash.endsWith(".pdf")) {
						evt.preventDefault();
						evt.stopPropagation();
						if (/^file:\/\//i.test(href)) {
							this.onExternalPdfLinkClickCallback?.(href);
						} else {
							this.onLinkClickCallback?.(href);
						}
						return;
					}
					if (href && href !== "#" && !/^javascript:/i.test(href)) {
						return;
					}
				}
				const clickedRow = target.closest(".dynamic-slides-zoom-table tbody tr") as HTMLTableRowElement | null;
				if (clickedRow) {
					const rows = this.getZoomTableRows();
					const rowIdx = rows.indexOf(clickedRow);
					if (rowIdx !== -1) {
						evt.stopPropagation();
						this.selectTableZoomRow(rowIdx, false);
						return;
					}
				}
				if (
					target === this.zoomOverlayEl ||
					target === this.zoomContentEl ||
					target.closest(".dynamic-slides-zoom-close-btn")
				) {
					evt.stopPropagation();
					this.closeMediaZoom(true);
					this.activeZoomIndex = -1;
				}
			});
		}
	}

	/**
	 * Opens a vault PDF inside the fullscreen zoom overlay using Obsidian's live native PDF.js viewer.
	 */
	public async openVaultPdfZoom(
		pdfVaultPath: string,
		subpath: string = "",
		displayTitle?: string,
		sourcePath?: string,
		animated: boolean = true,
		keepZoomIndex: boolean = false
	): Promise<void> {
		if (!keepZoomIndex) {
			this.activeZoomIndex = -1;
		}
		this.ensureZoomOverlay(false);
		this.zoomOverlayEl?.addClass("is-pdf-zoom-overlay");
		this.cleanupZoomResources();

		if (!this.zoomContentEl) return;
		this.zoomContentEl.empty();

		const cleanSubpath = subpath && !subpath.startsWith("#") ? `#${subpath}` : subpath;
		const fullRef = `${pdfVaultPath}${cleanSubpath}`;
		const title = displayTitle || pdfVaultPath.split("/").pop() || "PDF";

		const wrapper = this.zoomContentEl.createDiv({
			cls: "dynamic-slides-zoom-pdf",
			attr: { "data-pdf-source": `![[${fullRef}]]` },
		});
		const frame = wrapper.createDiv({ cls: "slideflow-pdf-frame" });
		const header = frame.createDiv({ cls: "slideflow-pdf-frame-header" });
		header.createSpan({ cls: "slideflow-pdf-frame-title", text: title });
		if (cleanSubpath) {
			header.createSpan({
				cls: "slideflow-pdf-frame-badge",
				text: cleanSubpath.replace(/^#/, ""),
			});
		}

		const body = frame.createDiv({ cls: "slideflow-pdf-frame-body" });
		const comp = new Component();
		this.addChild(comp);
		this.zoomSlideComponent = comp;

		await MarkdownRenderer.render(
			this.appRef,
			`![[${fullRef}]]`,
			body,
			sourcePath || this.currentSourcePath,
			comp
		);
		this.schedulePdfViewerHydration(body);
		this.onMediaZoomOpenedCallback?.();
	}

	/**
	 * Opens a local PDF file outside the vault inside the fullscreen zoom overlay via a Blob URL.
	 */
	public async openLocalFilePdfZoom(localFsPath: string, pageHash: string = ""): Promise<void> {
		if (!fs.existsSync(localFsPath)) {
			throw new Error(`Local PDF not found: ${localFsPath}`);
		}
		const bytes = await fs.promises.readFile(localFsPath);
		const blob = new Blob([bytes], { type: "application/pdf" });
		const blobUrl = URL.createObjectURL(blob);

		this.activeZoomIndex = -1;
		this.ensureZoomOverlay(false);
		this.zoomOverlayEl?.addClass("is-pdf-zoom-overlay");
		this.cleanupZoomResources();
		this.activePdfBlobUrl = blobUrl;

		if (!this.zoomContentEl) return;
		this.zoomContentEl.empty();

		const cleanHash = pageHash && !pageHash.startsWith("#") ? `#${pageHash}` : pageHash;
		const title = path.basename(localFsPath);

		const wrapper = this.zoomContentEl.createDiv({
			cls: "dynamic-slides-zoom-pdf",
			attr: { "data-pdf-source": `${localFsPath}${cleanHash}` },
		});
		const frame = wrapper.createDiv({ cls: "slideflow-pdf-frame" });
		const header = frame.createDiv({ cls: "slideflow-pdf-frame-header" });
		header.createSpan({ cls: "slideflow-pdf-frame-title", text: title });
		if (cleanHash) {
			header.createSpan({
				cls: "slideflow-pdf-frame-badge",
				text: cleanHash.replace(/^#/, ""),
			});
		}

		const body = frame.createDiv({ cls: "slideflow-pdf-frame-body is-external-pdf" });
		const iframe = body.createEl("iframe", {
			cls: "slideflow-pdf-iframe",
			attr: {
				src: `${blobUrl}${cleanHash}`,
				title,
			},
		});
		iframe.setAttribute("allowfullscreen", "true");
		this.onMediaZoomOpenedCallback?.();
	}

	public openMediaZoom(index: number, animated: boolean = true) {
		this.restoreZoomedLiveElement(false);
		const zoomableElements = this.detectMediaElements();
		if (index < 0 || index >= zoomableElements.length) {
			this.closeMediaZoom(false);
			return;
		}
		this.activeZoomIndex = index;
		const targetMedia = zoomableElements[index];

		// Embedded vault PDF (`![[xxx.pdf]]`): render live native Obsidian PDF.js viewer instead of cloning blank canvases!
		const pdfEmbedEl = (
			targetMedia.matches(".pdf-embed, .internal-embed[src$='.pdf' i], .internal-embed[src*='.pdf#' i]")
				? targetMedia
				: targetMedia.querySelector(".pdf-embed, .internal-embed[src$='.pdf' i], .internal-embed[src*='.pdf#' i]")
		) as HTMLElement | null;

		if (pdfEmbedEl) {
			const rawSrc = (pdfEmbedEl.getAttribute("src") || pdfEmbedEl.getAttribute("alt") || "").trim();
			if (rawSrc) {
				const hashIdx = rawSrc.indexOf("#");
				const filePart = hashIdx >= 0 ? rawSrc.slice(0, hashIdx) : rawSrc;
				const subpath = hashIdx >= 0 ? rawSrc.slice(hashIdx) : "";
				const title = filePart.split("/").pop() || filePart;
				void this.openVaultPdfZoom(filePart, subpath, title, this.currentSourcePath, animated, true);
				return;
			}
		}

		this.ensureZoomOverlay(animated);
		this.zoomOverlayEl?.removeClass("is-pdf-zoom-overlay");
		this.cleanupZoomResources(false);

		if (this.zoomContentEl) {
			this.zoomContentEl.empty();

			// Live interactive Obsidian plugins (chess-pgn, chess-study, dataview, leaflet, charts, etc.):
			// reparent the LIVE DOM node into the zoom overlay (leaving an invisible Comment placeholder)
			// instead of cloneNode(true), preserving 100% of JS listeners, drag-and-drop, and plugin state!
			if (this.isLivePluginBlock(targetMedia)) {
				const isDiffIns = Boolean(targetMedia.closest(".dv-block-ins"));
				const isDiffDel = !isDiffIns && Boolean(targetMedia.closest(".dv-block-del"));
				const pluginLang = this.extractPluginBlockLanguage(targetMedia);
				const parent = targetMedia.parentNode;
				const placeholder = document.createComment("slideflow-live-zoom-placeholder");
				if (parent) {
					parent.insertBefore(placeholder, targetMedia);
				}
				this.zoomedLiveSourceEl = targetMedia;
				this.zoomedLivePlaceholder = placeholder;

				const wrapper = this.zoomContentEl.createDiv({
					cls: "dynamic-slides-zoom-plugin",
					attr: pluginLang ? { "data-plugin-lang": pluginLang } : {},
				});
				const host = wrapper.createDiv({
					cls: `slideflow-live-plugin-host${isDiffIns ? " is-diff-ins" : ""}${isDiffDel ? " is-diff-del" : ""}`,
				});
				targetMedia.addClass("slideflow-live-plugin-el");
				host.appendChild(targetMedia);

				// Trigger a resize tick so layout/canvas/container-query plugins recompute once visible
				requestAnimationFrame(() => {
					if (targetMedia.isConnected) {
						try {
							window.dispatchEvent(new Event("resize"));
						} catch {
							// ignore
						}
					}
				});
				this.onMediaZoomOpenedCallback?.();
				return;
			}

			const isDiffIns =
				targetMedia.classList.contains("dv-pre-ins") ||
				Boolean(targetMedia.closest(".dv-block-ins"));
			const isDiffDel =
				!isDiffIns &&
				(targetMedia.classList.contains("dv-pre-del") ||
					Boolean(targetMedia.closest(".dv-block-del")));
			const clone = targetMedia.cloneNode(true) as HTMLElement;

			// Strip Obsidian's copy-code-button (which contains an <svg> icon!) BEFORE classifying media type
			clone.querySelectorAll(".copy-code-button").forEach((btn) => btn.remove());

			const isIframe =
				clone.tagName.toLowerCase() === "iframe" ||
				clone.querySelector("iframe") !== null;
			const isTable =
				!isIframe &&
				(clone.tagName.toLowerCase() === "table" ||
					clone.querySelector("table") !== null);
			const isMermaid =
				!isIframe &&
				!isTable &&
				(clone.matches(
					".mermaid, svg.mermaid, [class*='language-mermaid'], [class*='block-language-mermaid']"
				) ||
					clone.querySelector(
						".mermaid, svg.mermaid, [class*='language-mermaid'], [class*='block-language-mermaid']"
					) !== null);
			const isCode =
				!isIframe &&
				!isTable &&
				!isMermaid &&
				(clone.tagName.toLowerCase() === "pre" ||
					clone.matches("[class*='block-language-']") ||
					clone.querySelector("pre") !== null);
			const isSvg =
				!isIframe &&
				!isTable &&
				!isMermaid &&
				!isCode &&
				(clone.tagName.toLowerCase() === "svg" ||
					clone.querySelector("svg:not(.svg-icon):not(.emoji)") !== null);

			if (isIframe) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-iframe" });
				let iframeEl = clone;
				if (clone.tagName.toLowerCase() !== "iframe") {
					const nested = clone.querySelector("iframe");
					if (nested) {
						iframeEl = nested as HTMLElement;
					}
				}
				if (iframeEl instanceof HTMLIFrameElement || iframeEl.tagName.toLowerCase() === "iframe") {
					iframeEl.setAttribute("allowfullscreen", "true");
					iframeEl.setAttribute("allow", "fullscreen; autoplay; encrypted-media; picture-in-picture");
				}
				wrapper.appendChild(iframeEl);
			} else if (isTable) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-table" });
				const scrollBody = wrapper.createDiv({ cls: "slideflow-table-scroll-body" });
				scrollBody.appendChild(clone);
				this.zoomTableScrollEl = scrollBody;
				const tableEl =
					clone.tagName.toLowerCase() === "table"
						? (clone as HTMLTableElement)
						: clone.querySelector<HTMLTableElement>("table");
				if (tableEl) {
					this.mountTableZoomSelectorBar(wrapper, tableEl);
				}
			} else if (isMermaid || isSvg) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-mermaid" });
				wrapper.appendChild(clone);
				enhanceMermaidSvgElements(wrapper);
			} else if (isCode) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-code" });
				const frame = wrapper.createDiv({
					cls: `slideflow-code-frame${isDiffIns ? " is-diff-ins" : ""}${isDiffDel ? " is-diff-del" : ""}`,
				});
				const codeEl = clone.querySelector("code") || clone;
				const langCls =
					Array.from(codeEl.classList).find((c) => c.startsWith("language-")) ||
					Array.from(clone.classList).find((c) => c.startsWith("language-")) ||
					Array.from(clone.classList).find((c) => c.startsWith("block-language-"));
				const langLabel = langCls
					? langCls.replace(/^(?:block-)?language-/, "")
					: "code";

				const frameHeader = frame.createDiv({ cls: "slideflow-code-frame-header" });
				const dots = frameHeader.createDiv({ cls: "slideflow-code-frame-dots" });
				dots.createSpan({ cls: "slideflow-code-dot" });
				dots.createSpan({ cls: "slideflow-code-dot" });
				dots.createSpan({ cls: "slideflow-code-dot" });
				frameHeader.createSpan({ cls: "slideflow-code-frame-lang", text: langLabel });

				const frameBody = frame.createDiv({ cls: "slideflow-code-frame-body" });
				frameBody.appendChild(clone);
			} else {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-image" });
				wrapper.appendChild(clone);
				enhanceMermaidSvgElements(wrapper);
			}
			this.onMediaZoomOpenedCallback?.();
		}
	}

	public applyCommentHighlights(comments: ReviewComment[]): void {
		if (this.contentEl) {
			applyPersistentCommentHighlights(this.contentEl, comments);
		}
		if (this.zoomContentEl && this.isMediaZoomActive()) {
			applyPersistentCommentHighlights(this.zoomContentEl, comments);
		}
	}

	public decorateModifiedInternalLinks(
		getLinkState: (href: string) => InternalLinkVisualState | boolean
	): void {
		const containers: HTMLElement[] = [];
		if (this.contentEl) containers.push(this.contentEl);
		if (this.zoomContentEl && this.isMediaZoomActive()) {
			containers.push(this.zoomContentEl);
		}
		for (const root of containers) {
			root.querySelectorAll(".slideflow-link-dirty-badge").forEach((el) => el.remove());
			const links = Array.from(
				root.querySelectorAll<HTMLElement>(
					"a.internal-link, .slideflow-child-heading-linked-title[data-link-href]"
				)
			);
			for (const linkEl of links) {
				linkEl.removeClass("slideflow-link-has-diff");
				linkEl.removeClass("slideflow-link-already-open");
				linkEl.removeAttribute("aria-disabled");
				linkEl.removeAttribute("data-slideflow-already-open");

				const href =
					linkEl.getAttribute("data-href") ||
					linkEl.getAttribute("data-link-href") ||
					linkEl.getAttribute("href") ||
					"";
				if (!href) continue;

				const rawState = getLinkState(href);
				const state: InternalLinkVisualState =
					typeof rawState === "boolean" ? (rawState ? "dirty" : "normal") : rawState;

				if (state === "already-open") {
					linkEl.addClass("slideflow-link-already-open");
					linkEl.setAttribute("aria-disabled", "true");
					linkEl.setAttribute("data-slideflow-already-open", "true");
					linkEl.setAttribute(
						"title",
						"Déjà ouvert à un niveau supérieur dans SlideFlow (Échap pour revenir)"
					);
				} else if (state === "dirty") {
					linkEl.addClass("slideflow-link-has-diff");
					const dot = document.createElement("span");
					dot.className = "slideflow-link-dirty-badge";
					dot.setAttribute("title", "Modified since last review (unread diff)");
					dot.setAttribute("aria-label", "Modified since last review");
					linkEl.appendChild(dot);
				}
			}
		}
	}

	/**
	 * Mirrors the TOC unread-diff indicators (solid green/red dot for direct changes,
	 * hollow green/red ring for descendant changes) directly onto every section heading
	 * and clickable child-subsection title rendered inside the active slide.
	 */
	public decorateSlideHeadingDiffDots(currentNode: SectionNode | null, meta: TOCVisualMeta): void {
		if (!this.contentEl) return;
		this.contentEl.querySelectorAll(".slideflow-heading-diff-dot").forEach((el) => el.remove());
		this.contentEl
			.querySelectorAll(".slideflow-heading-has-diff")
			.forEach((el) => el.removeClass("slideflow-heading-has-diff"));

		const appendDot = (
			hostEl: HTMLElement,
			isDirty: boolean,
			hasDirtyDesc: boolean,
			isDeletionOnly: boolean,
			isDescDeletionOnly: boolean
		): void => {
			if (!isDirty && !hasDirtyDesc) return;

			const effectiveDeletionOnly = isDirty ? isDeletionOnly : isDescDeletionOnly;
			const existingLinkDot = hostEl.querySelector<HTMLElement>(".slideflow-link-dirty-badge");
			// Avoid stacking two identical solid green dots on an archived link heading whose target sub-note is also dirty
			if (existingLinkDot && isDirty && !effectiveDeletionOnly) {
				existingLinkDot.setAttribute(
					"title",
					"Unread diff in this section and linked note"
				);
				hostEl.addClass("slideflow-heading-has-diff");
				return;
			}

			const dot = document.createElement("span");
			const classes = ["slideflow-heading-diff-dot"];
			let titleText = "";
			if (isDirty) {
				if (isDeletionOnly) {
					classes.push("is-deletion-only");
					titleText = "Unread deletion in this section";
				} else {
					titleText = "Unread changes in this section";
				}
			} else {
				classes.push("is-descendant");
				if (isDescDeletionOnly) {
					classes.push("is-deletion-only");
					titleText = "Contains unread deletion in a subsection";
				} else {
					titleText = "Contains unread changes in a subsection";
				}
			}
			dot.className = classes.join(" ");
			dot.setAttribute("title", titleText);
			dot.setAttribute("aria-label", titleText);
			hostEl.addClass("slideflow-heading-has-diff");
			hostEl.appendChild(dot);
		};

		// 1. Decorate the active slide's own rendered title heading (`h1`..`h6`)
		if (currentNode && currentNode.level > 0 && !currentNode.isVirtualDeleted) {
			const headingCandidates = Array.from(
				this.contentEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
			).filter(
				(h) =>
					!h.closest(".callout") &&
					!h.closest(".dynamic-slides-child-heading") &&
					!h.closest("[class*='block-language-']")
			);
			const exactLevelHeading =
				headingCandidates.find(
					(h) => h.tagName.toLowerCase() === `h${currentNode.level}`
				) || headingCandidates[0];
			if (exactLevelHeading) {
				const isDirty = Boolean(meta.dirtyNodeIds?.has(currentNode.id));
				const hasDirtyDesc = Boolean(meta.descendantDirtyNodeIds?.has(currentNode.id));
				const isDeletionOnly = Boolean(meta.deletionOnlyNodeIds?.has(currentNode.id));
				const isDescDeletionOnly = Boolean(
					meta.descendantDeletionOnlyNodeIds?.has(currentNode.id)
				);
				appendDot(
					exactLevelHeading,
					isDirty,
					hasDirtyDesc,
					isDeletionOnly,
					isDescDeletionOnly
				);
			}
		}

		// 2. Decorate all child section / subsection titles rendered on this slide
		const childHeadings = Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				".dynamic-slides-child-heading[data-node-id]:not(.is-deleted-child-heading)"
			)
		);
		for (const childEl of childHeadings) {
			const nodeId = childEl.getAttribute("data-node-id");
			if (!nodeId) continue;
			const isDirty = Boolean(meta.dirtyNodeIds?.has(nodeId));
			const hasDirtyDesc = Boolean(meta.descendantDirtyNodeIds?.has(nodeId));
			const isDeletionOnly = Boolean(meta.deletionOnlyNodeIds?.has(nodeId));
			const isDescDeletionOnly = Boolean(meta.descendantDeletionOnlyNodeIds?.has(nodeId));
			appendDot(childEl, isDirty, hasDirtyDesc, isDeletionOnly, isDescDeletionOnly);
		}
	}

	public closeMediaZoom(animated: boolean = true) {
		const wasZoomActive = this.zoomOverlayEl !== null || this.overlayEl.hasClass("is-media-zoom-active");
		this.hideSelectionToolbar();
		this.overlayEl.removeClass("is-media-zoom-active");
		if (
			this.zoomOverlayEl &&
			document.activeElement instanceof HTMLElement &&
			this.zoomOverlayEl.contains(document.activeElement)
		) {
			try {
				document.activeElement.blur();
			} catch {
				// ignore
			}
		}
		this.cleanupZoomResources(animated);
		if (this.zoomOverlayEl) {
			const elToClose = this.zoomOverlayEl;
			this.zoomOverlayEl = null;
			this.zoomContentEl = null;

			if (animated) {
				elToClose.addClass("is-closing");
				setTimeout(() => {
					elToClose.remove();
				}, 200);
			} else {
				elToClose.remove();
			}
		}
		this.activeZoomIndex = -1;
		try {
			window.focus();
		} catch {
			// ignore
		}
		if (this.contentEl) {
			this.contentEl.style.opacity = '1';
		}
		if (wasZoomActive) {
			this.onMediaZoomClosedCallback?.();
		}
	}

	public handleNext(): boolean {
		if (this.hasCompletedAllSteps) {
			return false;
		}

		// While a scroll animation is running, NEVER skip scrolling or jump straight to the next slide:
		// - Pressing → while scrolling UP smoothly cancels/reverses back downward.
		// - Pressing → while scrolling DOWN chains another half-slide scroll smoothly (or finishes
		//   settling cleanly at the bottom boundary so only a subsequent keypress advances slides).
		if (this.currentScrollAnimId !== null && this.contentEl) {
			const maxScrollTop = Math.max(0, this.contentEl.scrollHeight - this.contentEl.clientHeight);
			if (this.currentScrollDirection === "up") {
				const currentPos = this.contentEl.scrollTop;
				const prevTarget = this.currentTargetTop;
				const reverseTarget =
					Math.abs(currentPos - this.currentScrollStartTop) >= 24
						? this.currentScrollStartTop
						: Math.min(maxScrollTop, currentPos + this.contentEl.clientHeight * 0.5);
				const fullDist = Math.max(1, Math.abs(prevTarget - reverseTarget));
				const ratio = Math.min(1, Math.max(0.2, Math.abs(currentPos - reverseTarget) / fullDist));
				this.cancelScrollAnimation(false);
				void this.animateScrollTo(reverseTarget, Math.round(this.scrollDurationMs * ratio));
				return true;
			}
			if (this.currentScrollDirection === "down") {
				if (this.currentTargetTop < maxScrollTop - 10) {
					const chainedTarget = Math.min(
						maxScrollTop,
						this.currentTargetTop + this.contentEl.clientHeight * 0.5
					);
					void this.animateScrollTo(chainedTarget, this.scrollDurationMs);
					return true;
				}
				this.cancelScrollAnimation(true);
				return true;
			}
			this.cancelScrollAnimation(true);
		}

		if (this.isPdfZoomActive()) {
			if (this.scrollPdfZoom("down", 0.72)) {
				return true;
			}
		}

		if (this.isMediaZoomActive() && this.activeZoomIndex === -1) {
			// Link-opened zoom (e.g. clicked local PDF link): close cleanly and stay on slide
			this.closeMediaZoom(true);
			return true;
		}

		if (this.isFullDocumentMode) {
			if (this.isMediaZoomActive()) {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				return true;
			}
			if (this.canScrollDown()) {
				this.scrollDown();
				return true;
			}
			this.hasCompletedAllSteps = true;
			return false;
		}

		const mediaElements = this.detectMediaElements();
		const isOnlyZoomable = this.checkOnlyZoomableContent() && mediaElements.length > 0;

		if (isOnlyZoomable) {
			if (this.activeZoomIndex === -1) {
				this.activeZoomIndex = 0;
				this.openMediaZoom(0);
				return true;
			}
			if (this.activeZoomIndex < mediaElements.length - 1) {
				this.activeZoomIndex++;
				this.openMediaZoom(this.activeZoomIndex);
				return true;
			}
			if (this.isMediaZoomActive() || this.activeZoomIndex === mediaElements.length - 1) {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				this.hasCompletedAllSteps = true;
				return false;
			}
			this.hasCompletedAllSteps = true;
			return false;
		}

		if (this.isMediaZoomActive() || this.activeZoomIndex >= 0) {
			if (this.activeZoomIndex < mediaElements.length - 1) {
				this.activeZoomIndex++;
				this.openMediaZoom(this.activeZoomIndex);
				return true;
			} else {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				this.hasCompletedAllSteps = true;
				return false;
			}
		}

		if (this.canScrollDown()) {
			this.scrollDown();
			return true;
		}

		if (mediaElements.length > 0) {
			this.activeZoomIndex = 0;
			this.openMediaZoom(0);
			return true;
		}

		this.hasCompletedAllSteps = true;
		return false;
	}

	public handlePrev(): boolean {
		this.hasCompletedAllSteps = false;

		// While a scroll animation is running, NEVER skip scrolling or jump straight to the previous slide:
		// - Pressing ← while scrolling DOWN smoothly cancels/reverses back upward.
		// - Pressing ← while scrolling UP chains another half-slide scroll smoothly (or finishes
		//   settling cleanly at the top boundary so only a subsequent keypress moves to the previous slide).
		if (this.currentScrollAnimId !== null && this.contentEl) {
			if (this.currentScrollDirection === "down") {
				const currentPos = this.contentEl.scrollTop;
				const prevTarget = this.currentTargetTop;
				const reverseTarget =
					Math.abs(currentPos - this.currentScrollStartTop) >= 24
						? this.currentScrollStartTop
						: Math.max(0, currentPos - this.contentEl.clientHeight * 0.5);
				const fullDist = Math.max(1, Math.abs(prevTarget - reverseTarget));
				const ratio = Math.min(1, Math.max(0.2, Math.abs(currentPos - reverseTarget) / fullDist));
				this.cancelScrollAnimation(false);
				void this.animateScrollTo(reverseTarget, Math.round(this.scrollDurationMs * ratio));
				return true;
			}
			if (this.currentScrollDirection === "up") {
				if (this.currentTargetTop > 10) {
					const chainedTarget = Math.max(
						0,
						this.currentTargetTop - this.contentEl.clientHeight * 0.5
					);
					void this.animateScrollTo(chainedTarget, this.scrollDurationMs);
					return true;
				}
				this.cancelScrollAnimation(true);
				return true;
			}
			this.cancelScrollAnimation(true);
		}

		if (this.isPdfZoomActive()) {
			if (this.scrollPdfZoom("up", 0.72)) {
				return true;
			}
		}

		if (this.isMediaZoomActive() && this.activeZoomIndex === -1) {
			// Link-opened zoom (e.g. clicked local PDF link): close cleanly and stay on slide
			this.closeMediaZoom(true);
			return true;
		}

		if (this.isFullDocumentMode) {
			if (this.isMediaZoomActive()) {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				return true;
			}
			if (this.canScrollUp()) {
				this.scrollUp();
				return true;
			}
			return false;
		}

		const mediaElements = this.detectMediaElements();
		const isOnlyZoomable = this.checkOnlyZoomableContent() && mediaElements.length > 0;

		if (isOnlyZoomable) {
			if (this.activeZoomIndex > 0 && this.activeZoomIndex < mediaElements.length) {
				this.activeZoomIndex--;
				this.openMediaZoom(this.activeZoomIndex);
				return true;
			}
			if (this.activeZoomIndex === 0) {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				return true;
			}
			return false;
		}

		if (this.isMediaZoomActive() || this.activeZoomIndex >= 0) {
			if (this.activeZoomIndex > 0) {
				this.activeZoomIndex--;
				this.openMediaZoom(this.activeZoomIndex);
				return true;
			} else {
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
				if (this.contentEl) {
					this.contentEl.scrollTop = this.contentEl.scrollHeight;
				}
				return true;
			}
		}

		if (this.canScrollUp()) {
			this.scrollUp();
			return true;
		}

		return false;
	}

	public async open(
		initialNode: SectionNode,
		sourcePath: string,
		decoration?: SlideRenderDecoration
	) {
		document.body.addClass("is-dynamic-slides-active");
		this.overlayEl.style.setProperty('--dynamic-slides-duration', `${this.transitionDuration}s`);
		this.overlayEl.style.setProperty('--dynamic-slides-zoom', `${this.zoomLevel}`);
		this.applyZoom(false);
		this.load();

		try {
			if (this.overlayEl.requestFullscreen) {
				await this.overlayEl.requestFullscreen();
			}
		} catch (e) {
			console.warn("[SlideFlow] Fullscreen request failed or denied:", e);
		}

		await this.updateSlide(initialNode, sourcePath, 'jump', 'start', decoration);
	}

	public async updateSlide(
		node: SectionNode,
		sourcePath: string,
		direction: 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump' = 'jump',
		enterFrom: 'start' | 'end' = 'start',
		decoration?: SlideRenderDecoration,
		restoreReadingFocus?: {
			active: boolean;
			index: number;
			scrollIntoView?: boolean;
			focusedLinkIndex?: number;
		},
		restoreZoom?: {
			zoomIndex: number;
			tableRowIndex?: number;
		}
	) {
		this.currentSourcePath = sourcePath;
		this.hideSelectionToolbar();
		this.clearHoveredBlock();
		this.clearFocusedLink();
		this.setActiveCommentBlock(null);
		if (this.readingFocusBlockEl) {
			this.readingFocusBlockEl.removeClass("slideflow-reading-focus-block");
			this.readingFocusBlockEl = null;
		}
		this.cancelScrollAnimation(false);
		this.hasCompletedAllSteps = false;

		if (this.contentEl) {
			this.contentEl.style.opacity = '0';
		}

		this.closeMediaZoom(false);
		this.activeZoomIndex = -1;
		if (this.contentEl) {
			this.contentEl.scrollTop = 0;
			this.contentEl.removeClass("is-only-zoomable-slide");
			this.contentEl.removeClass("is-full-document-slide");
			this.contentEl.style.removeProperty("opacity");
		}

		if (this.currentSlideComponent) {
			unloadSlideContent(this.currentSlideComponent, this);
			this.currentSlideComponent = null;
		}

		this.contentEl.removeClass(
			"slide-anim-next",
			"slide-anim-prev",
			"slide-anim-zoom-in",
			"slide-anim-zoom-out",
			"slide-anim-jump"
		);
		void this.contentEl.offsetWidth;
		this.contentEl.addClass(`slide-anim-${direction}`);

		const markdownToRender = decoration?.overrideMarkdown ?? node.contentMarkdown;
		this.currentSlideComponent = await renderSlideContent(
			this.appRef,
			markdownToRender,
			this.contentEl,
			sourcePath,
			this
		);

		const isFullDocument = node.level === 0;
		this.isFullDocumentMode = isFullDocument;
		this.contentEl.toggleClass("is-full-document-slide", isFullDocument);

		const mediaElements = this.detectMediaElements();
		const isOnlyZoomable = !isFullDocument && this.checkOnlyZoomableContent() && mediaElements.length > 0;
		if (isOnlyZoomable) {
			this.contentEl.addClass("is-only-zoomable-slide");
		} else {
			this.contentEl.removeClass("is-only-zoomable-slide");
		}

		if (enterFrom === 'end') {
			if (!isFullDocument && mediaElements.length > 0) {
				this.activeZoomIndex = mediaElements.length - 1;
				this.openMediaZoom(this.activeZoomIndex, false);
			} else if (this.canScrollDown() || this.contentEl.scrollHeight > this.contentEl.clientHeight) {
				this.contentEl.scrollTop = this.contentEl.scrollHeight;
				this.activeZoomIndex = SCROLL_PHASE;
			} else {
				this.activeZoomIndex = -1;
			}
		} else {
			this.activeZoomIndex = -1;
		}

		if (restoreZoom && restoreZoom.zoomIndex >= 0 && restoreZoom.zoomIndex < mediaElements.length) {
			this.openMediaZoom(restoreZoom.zoomIndex, false);
			if (
				this.isTableZoomActive() &&
				typeof restoreZoom.tableRowIndex === "number" &&
				restoreZoom.tableRowIndex >= 0
			) {
				this.selectTableZoomRow(restoreZoom.tableRowIndex, true);
			}
		}

		if (restoreReadingFocus !== undefined) {
			this.readingFocusActive = restoreReadingFocus.active;
			if (this.readingFocusActive && !this.isMediaZoomActive()) {
				this.restoreReadingFocusAfterRender(
					Math.max(0, restoreReadingFocus.index),
					Boolean(restoreReadingFocus.scrollIntoView),
					restoreReadingFocus.focusedLinkIndex
				);
			} else if (!this.readingFocusActive) {
				this.clearReadingFocus();
			}
		} else {
			// Navigating to another slide cancels reading-focus block/link selection and returns to general slide view.
			this.clearReadingFocus();
		}
	}

	/**
	 * Re-renders the current slide immediately without transition animation, preserving
	 * scroll position (and active media zoom if open). Used when Ctrl+Enter validates a diff.
	 */
	public async refreshSlideInPlace(
		node: SectionNode,
		sourcePath: string,
		decoration?: SlideRenderDecoration
	): Promise<void> {
		this.hideSelectionToolbar();
		const prevScrollTop = this.contentEl ? this.contentEl.scrollTop : 0;
		const wasZoomOpen = this.isMediaZoomActive();
		const prevZoomIndex = this.activeZoomIndex;
		const prevZoomTableRowIndex = this.getZoomTableRowIndex();
		const prevZoomTableScrollTop = this.zoomTableScrollEl ? this.zoomTableScrollEl.scrollTop : 0;
		const prevFocusedLinkIdx = this.getFocusedLinkIndex();

		this.restoreZoomedLiveElement(false);

		if (this.currentSlideComponent) {
			unloadSlideContent(this.currentSlideComponent, this);
			this.currentSlideComponent = null;
		}

		const markdownToRender = decoration?.overrideMarkdown ?? node.contentMarkdown;
		this.currentSlideComponent = await renderSlideContent(
			this.appRef,
			markdownToRender,
			this.contentEl,
			sourcePath,
			this
		);

		const isFullDocument = node.level === 0;
		this.isFullDocumentMode = isFullDocument;
		this.contentEl.toggleClass("is-full-document-slide", isFullDocument);

		const mediaElements = this.detectMediaElements();
		const isOnlyZoomable = !isFullDocument && this.checkOnlyZoomableContent() && mediaElements.length > 0;
		this.contentEl.toggleClass("is-only-zoomable-slide", isOnlyZoomable);

		if (this.contentEl) {
			this.contentEl.scrollTop = Math.min(
				prevScrollTop,
				Math.max(0, this.contentEl.scrollHeight - this.contentEl.clientHeight)
			);
		}

		if (wasZoomOpen && prevZoomIndex >= 0 && prevZoomIndex < mediaElements.length) {
			this.openMediaZoom(prevZoomIndex, false);
			if (this.isTableZoomActive()) {
				if (this.zoomTableScrollEl && prevZoomTableScrollTop > 0) {
					this.zoomTableScrollEl.scrollTop = prevZoomTableScrollTop;
				}
				if (prevZoomTableRowIndex >= 0) {
					this.selectTableZoomRow(prevZoomTableRowIndex, false);
				}
			}
		} else if (wasZoomOpen) {
			this.closeMediaZoom(false);
		}

		if (this.readingFocusActive && !this.isMediaZoomActive()) {
			this.restoreReadingFocusAfterRender(
				Math.max(0, this.readingFocusIndex),
				false,
				prevFocusedLinkIdx >= 0 ? prevFocusedLinkIdx : undefined
			);
		}
	}

	public close() {
		this.hideSelectionToolbar();
		this.clearHoveredBlock();
		this.clearReadingFocus();
		this.setActiveCommentBlock(null);
		this.contentEl.removeEventListener("mousemove", this.boundContentMouseMoveHandler);
		this.contentEl.removeEventListener("mouseleave", this.boundContentMouseLeaveHandler);
		window.removeEventListener("mouseup", this.boundMouseUpHandler);
		window.removeEventListener("keyup", this.boundKeyUpSelectionHandler);
		this.cancelScrollAnimation(false);
		this.closeMediaZoom(false);
		this.hideSubNoteBanner();

		if (document.fullscreenElement === this.overlayEl) {
			try {
				void document.exitFullscreen();
			} catch {
				// ignore
			}
		}

		if (this.currentSlideComponent) {
			unloadSlideContent(this.currentSlideComponent, this);
			this.currentSlideComponent = null;
		}

		document.body.removeClass("is-dynamic-slides-active");
		this.overlayEl.remove();
		this.unload();

		if (this.onCloseCallback) {
			this.onCloseCallback();
		}
	}
}
