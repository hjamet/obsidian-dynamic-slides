import { App, Component } from "obsidian";
import { SectionNode } from "./parser";
import { renderSlideContent, unloadSlideContent, enhanceMermaidSvgElements } from "./renderer";
import { TOCComponent } from "./toc";

export const SCROLL_PHASE = -1;

export interface CockpitBarState {
	hasNoteDiff: boolean;
	diffEnabled: boolean;
	dirtySlidesCount: number;
	currentSlideHasDiff: boolean;
	currentSlideCommentsCount: number;
	totalPendingCommentsCount: number;
}

export interface SlideRenderDecoration {
	overrideMarkdown?: string;
	dirtyNodeIds?: Set<string>;
	descendantDirtyNodeIds?: Set<string>;
	isLinkModified?: (href: string) => boolean;
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
	private returnBtnEl: HTMLElement;
	private currentSlideComponent: Component | null = null;
	private onCloseCallback?: () => void;
	public onLinkClickCallback?: (href: string) => void;
	public onSectionClickCallback?: (nodeId: string) => void;
	public onZoomChangeCallback?: (zoom: number) => void;
	public onReturnClickCallback?: () => void;
	public onChildHeadingClickCallback?: (nodeId: string) => void;
	public onToggleDiffClickCallback?: () => void;
	public onCommentTextClickCallback?: () => void;
	public onCommentVoiceClickCallback?: () => void;
	public onOpenQueueClickCallback?: () => void;
	public onCopyOneShotClickCallback?: () => void;
	private transitionDuration: number;
	private scrollDurationMs: number = 1000;
	private tocComp: TOCComponent | null = null;
	private subNoteBannerEl: HTMLElement | null = null;

	// SlideFlow Cockpit Top Bar
	private cockpitBarEl: HTMLElement;
	private diffToggleBtnEl: HTMLButtonElement;
	private commentTextBtnEl: HTMLButtonElement;
	private commentVoiceBtnEl: HTMLButtonElement;
	private queueBtnEl: HTMLButtonElement;

	public currentScrollAnimId: number | null = null;
	public currentScrollResolve: (() => void) | null = null;
	public currentTargetTop: number = 0;

	private mediaElements: HTMLElement[] = [];
	private activeZoomIndex: number = -1;
	private zoomOverlayEl: HTMLElement | null = null;
	private zoomContentEl: HTMLElement | null = null;
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

		// Top-center SlideFlow Cockpit Bar (Diff toggle, Comment C, Voice V, Pending Queue R / Ctrl+Enter)
		this.cockpitBarEl = this.overlayEl.createDiv({ cls: "slideflow-cockpit-bar" });

		this.diffToggleBtnEl = this.cockpitBarEl.createEl("button", {
			cls: "slideflow-pill-btn slideflow-diff-btn",
			text: "Diff (D)",
			attr: { type: "button", title: "Afficher/Masquer les diffs (Touche D · N = diff suivante)" }
		});
		this.diffToggleBtnEl.style.display = "none";
		this.diffToggleBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onToggleDiffClickCallback?.();
		});

		this.commentTextBtnEl = this.cockpitBarEl.createEl("button", {
			cls: "slideflow-pill-btn slideflow-comment-btn",
			text: "💬 Commenter (C)",
			attr: { type: "button", title: "Laisser un commentaire texte sur cette slide (Touche C)" }
		});
		this.commentTextBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onCommentTextClickCallback?.();
		});

		this.commentVoiceBtnEl = this.cockpitBarEl.createEl("button", {
			cls: "slideflow-pill-btn slideflow-voice-btn",
			text: "🎤 (V)",
			attr: { type: "button", title: "Commentaire vocal immédiat Faster-Whisper GPU (Touche V)" }
		});
		this.commentVoiceBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onCommentVoiceClickCallback?.();
		});

		this.queueBtnEl = this.cockpitBarEl.createEl("button", {
			cls: "slideflow-pill-btn slideflow-queue-btn",
			text: "📋 0 → /one-shot",
			attr: { type: "button", title: "Voir la file de commentaires (R) ou copier /one-shot (Ctrl+Entrée)" }
		});
		this.queueBtnEl.style.display = "none";
		this.queueBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onOpenQueueClickCallback?.();
		});

		this.returnBtnEl = this.overlayEl.createEl("button", {
			cls: "dynamic-slides-return-btn"
		});
		this.returnBtnEl.setAttribute("aria-label", "Back to original note");
		this.returnBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.onReturnClickCallback) {
				this.onReturnClickCallback();
			}
		});

		const bottomLeftZone = this.overlayEl.createDiv({ cls: "dynamic-slides-bottom-left-zone" });
		this.hoverToggleBtnEl = bottomLeftZone.createEl("button", {
			text: "☰ Table of contents",
			cls: "dynamic-slides-toc-hover-toggle"
		});
		this.hoverToggleBtnEl.setAttribute("aria-label", "Toggle TOC");
		this.hoverToggleBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.tocComp) {
				this.tocComp.toggleSidebar();
			}
		});

		// Bottom-right Zoom Toolbar
		const bottomRightZone = this.overlayEl.createDiv({ cls: "dynamic-slides-bottom-right-zone" });
		this.zoomToolbarEl = bottomRightZone.createDiv({ cls: "dynamic-slides-zoom-toolbar" });

		this.zoomOutBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-btn zoom-out",
			text: "−"
		});
		this.zoomOutBtnEl.setAttribute("aria-label", "Zoom out (-10%)");
		this.zoomOutBtnEl.setAttribute("title", "Zoom out (-10%) [Key -]");
		this.zoomOutBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.zoomOut();
		});

		this.zoomValueBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-value",
			text: `${Math.round(this.zoomLevel * 100)}%`
		});
		this.zoomValueBtnEl.setAttribute("aria-label", "Reset zoom (100%)");
		this.zoomValueBtnEl.setAttribute("title", "Reset zoom to 100% [Key 0]");
		this.zoomValueBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.resetZoom();
		});

		this.zoomInBtnEl = this.zoomToolbarEl.createEl("button", {
			cls: "dynamic-slides-zoom-btn zoom-in",
			text: "+"
		});
		this.zoomInBtnEl.setAttribute("aria-label", "Zoom in (+10%)");
		this.zoomInBtnEl.setAttribute("title", "Zoom in (+10%) [Key +]");
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
			const target = evt.target as HTMLElement;

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

			if (target.closest('.callout-icon, .svg-icon, .dynamic-slides-child-heading, .internal-link')) return;

			const selector = [
				"iframe",
				"img:not(.emoji):not(.svg-icon)",
				".mermaid",
				"svg.mermaid",
				".block-language-mermaid",
				"div[class*='block-language-mermaid']",
				"pre",
				"table",
				"[class*='block-language-']:not(.callout)"
			].join(", ");

			const zoomableEl = target.closest(selector) as HTMLElement;
			if (zoomableEl) {
				const zoomableList = this.detectMediaElements();
				const matchedEl = zoomableList.find(item => item === zoomableEl || item.contains(zoomableEl));
				if (matchedEl) {
					const index = zoomableList.indexOf(matchedEl);
					if (index !== -1) {
						evt.preventDefault();
						evt.stopPropagation();
						this.openMediaZoom(index);
					}
				}
			}
		});
	}

	public updateCockpitBar(state: CockpitBarState): void {
		if (state.hasNoteDiff) {
			this.diffToggleBtnEl.style.display = "inline-flex";
			const label = state.diffEnabled
				? `🟢 Diff ON (${state.dirtySlidesCount})`
				: `Diff OFF (${state.dirtySlidesCount})`;
			this.diffToggleBtnEl.setText(label);
			this.diffToggleBtnEl.toggleClass("is-active", state.diffEnabled);
			this.diffToggleBtnEl.toggleClass("is-slide-dirty", state.currentSlideHasDiff);
		} else {
			this.diffToggleBtnEl.style.display = "none";
		}

		if (state.currentSlideCommentsCount > 0) {
			this.commentTextBtnEl.setText(`💬 ${state.currentSlideCommentsCount} (C)`);
			this.commentTextBtnEl.addClass("has-comments");
		} else {
			this.commentTextBtnEl.setText("💬 (C)");
			this.commentTextBtnEl.removeClass("has-comments");
		}

		if (state.totalPendingCommentsCount > 0) {
			this.queueBtnEl.style.display = "inline-flex";
			this.queueBtnEl.setText(`📋 ${state.totalPendingCommentsCount} · /one-shot (Ctrl+↵)`);
		} else {
			this.queueBtnEl.style.display = "none";
		}
	}

	public refreshLinkModifiedBadges(isLinkModified: (href: string) => boolean): void {
		const applyToRoot = (root: HTMLElement | null) => {
			if (!root) return;
			root.querySelectorAll(".slideflow-modified-pill").forEach((el) => el.remove());
			const links = root.querySelectorAll<HTMLElement>("a.internal-link");
			links.forEach((linkEl) => {
				const href = linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "";
				if (href && isLinkModified(href)) {
					const pill = document.createElement("span");
					pill.className = "slideflow-modified-pill";
					pill.textContent = "🟢 Modifié";
					pill.setAttribute("title", "Modifications non lues dans cette note");
					linkEl.appendChild(pill);
				}
			});
		};
		applyToRoot(this.contentEl);
		applyToRoot(this.zoomContentEl);
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

	public setBreadcrumb(currentTitle: string, parentTitle?: string) {
		this.setReturnButton(parentTitle || null);
	}

	public setReturnButton(parentTitle: string | null) {
		if (parentTitle) {
			this.returnBtnEl.setText(`↩ ${parentTitle}`);
			this.returnBtnEl.addClass("is-visible");
		} else {
			this.returnBtnEl.removeClass("is-visible");
			this.returnBtnEl.setText("");
		}
	}

	public showSubNoteBanner(noteTitle: string, onReturn: () => void) {
		this.hideSubNoteBanner();

		this.subNoteBannerEl = this.overlayEl.createDiv({ cls: "dynamic-slides-subnote-banner" });

		this.subNoteBannerEl.createDiv({ cls: "dynamic-slides-subnote-tag", text: "Sub-note" });
		this.subNoteBannerEl.createDiv({ cls: "dynamic-slides-subnote-title", text: noteTitle });
		const returnBtn = this.subNoteBannerEl.createEl("button", {
			cls: "dynamic-slides-subnote-return-btn",
			text: "↩ Retour (Échap)"
		});

		returnBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onReturn();
		});
	}

	public hideSubNoteBanner() {
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

			this.currentTargetTop = clampedTarget;
			this.currentScrollResolve = resolve;

			const startTop = this.contentEl.scrollTop;
			const distance = clampedTarget - startTop;

			if (Math.abs(distance) < 1) {
				this.contentEl.scrollTop = clampedTarget;
				this.currentScrollResolve = null;
				resolve();
				return;
			}

			const startTime = performance.now();
			const easeInOutSine = (t: number): number => {
				return 0.5 * (1 - Math.cos(Math.PI * t));
			};

			const step = (currentTime: number) => {
				const elapsed = currentTime - startTime;
				const progress = Math.min(1, Math.max(0, elapsed / durationMs));
				const easedProgress = easeInOutSine(progress);

				this.contentEl.scrollTop = startTop + distance * easedProgress;

				if (progress < 1) {
					this.currentScrollAnimId = requestAnimationFrame(step);
				} else {
					this.contentEl.scrollTop = clampedTarget;
					this.currentScrollAnimId = null;
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

	public scrollDown(): void {
		if (!this.contentEl) return;
		const targetTop = this.contentEl.scrollTop + this.contentEl.clientHeight * 0.75;
		this.animateScrollTo(targetTop, this.scrollDurationMs);
	}

	public scrollUp(): void {
		if (!this.contentEl) return;
		const targetTop = this.contentEl.scrollTop - this.contentEl.clientHeight * 0.75;
		this.animateScrollTo(targetTop, this.scrollDurationMs);
	}

	public detectMediaElements(): HTMLElement[] {
		if (!this.contentEl) return [];
		const selector = [
			"iframe",
			"img:not(.emoji):not(.svg-icon)",
			".mermaid",
			"svg.mermaid",
			".block-language-mermaid",
			"div[class*='block-language-mermaid']",
			"pre",
			"table",
			"[class*='block-language-']:not(.callout)"
		].join(", ");
		const raw = Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(selector)
		);
		const filtered = raw.filter(el => {
			if (
				el.closest(".callout-icon") ||
				el.closest(".dynamic-slides-toc-fold-icon") ||
				el.classList.contains("callout-icon") ||
				el.classList.contains("svg-icon") ||
				el.classList.contains("emoji")
			) {
				return false;
			}
			return !raw.some(other => other !== el && other.contains(el));
		});
		this.mediaElements = filtered;
		return filtered;
	}

	public checkOnlyZoomableContent(): boolean {
		if (!this.contentEl) return false;
		const clone = this.contentEl.cloneNode(true) as HTMLElement;
		clone.querySelectorAll("h1, h2, h3, h4, h5, h6, .dynamic-slides-child-heading").forEach(el => el.remove());
		const selector = [
			"iframe",
			"img:not(.emoji):not(.svg-icon)",
			".mermaid",
			"svg.mermaid",
			".block-language-mermaid",
			"div[class*='block-language-mermaid']",
			"pre",
			"table",
			"[class*='block-language-']:not(.callout)"
		].join(", ");
		clone.querySelectorAll(selector).forEach(el => el.remove());
		const text = clone.textContent?.trim() || "";
		return text.length === 0;
	}

	public isMediaZoomActive(): boolean {
		return this.zoomOverlayEl !== null;
	}

	public openMediaZoom(index: number, animated: boolean = true) {
		if (this.contentEl) {
			this.contentEl.style.opacity = '0';
		}
		const zoomableElements = this.detectMediaElements();
		if (index < 0 || index >= zoomableElements.length) {
			this.closeMediaZoom(false);
			return;
		}
		this.activeZoomIndex = index;
		if (!this.zoomOverlayEl) {
			this.zoomOverlayEl = this.overlayEl.createDiv({ cls: "dynamic-slides-media-zoom-overlay" });
			if (!animated) {
				this.zoomOverlayEl.style.animation = "none";
			}
			const closeBtn = this.zoomOverlayEl.createEl("button", {
				cls: "dynamic-slides-zoom-close-btn",
				text: "✕"
			});
			closeBtn.setAttribute("aria-label", "Close zoom");
			closeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.closeMediaZoom(true);
				this.activeZoomIndex = -1;
			});

			this.zoomContentEl = this.zoomOverlayEl.createDiv({ cls: "dynamic-slides-media-zoom-content" });
			this.zoomOverlayEl.addEventListener("click", (evt) => {
				const target = evt.target as HTMLElement;
				// Allow clicking internal links directly inside zoomed tables (e.g., 🎯 Projets.md!)
				const linkEl = target.closest(".internal-link") as HTMLElement | null;
				if (linkEl) {
					const href = linkEl.getAttribute("data-href") || linkEl.getAttribute("href");
					if (href) {
						evt.preventDefault();
						evt.stopPropagation();
						this.closeMediaZoom(false);
						this.activeZoomIndex = -1;
						this.onLinkClickCallback?.(href);
						return;
					}
				}
				if (target === this.zoomOverlayEl || target === this.zoomContentEl || target.closest(".dynamic-slides-zoom-close-btn")) {
					evt.stopPropagation();
					this.closeMediaZoom(true);
					this.activeZoomIndex = -1;
				}
			});
		}

		if (this.zoomContentEl) {
			this.zoomContentEl.empty();
			const targetMedia = zoomableElements[index];
			const clone = targetMedia.cloneNode(true) as HTMLElement;

			const isIframe = targetMedia.tagName.toLowerCase() === "iframe" || targetMedia.querySelector("iframe") !== null;
			const isTable = !isIframe && (targetMedia.tagName.toLowerCase() === "table" || targetMedia.querySelector("table") !== null);
			const isSvgOrMermaid = !isIframe && !isTable && (
				targetMedia.tagName.toLowerCase() === "svg" ||
				targetMedia.querySelector("svg") !== null ||
				targetMedia.matches(".mermaid, [class*='mermaid'], [class*='language-mermaid'], [class*='block-language-mermaid']") ||
				targetMedia.querySelector(".mermaid, [class*='mermaid'], [class*='language-mermaid'], [class*='block-language-mermaid']") !== null
			);
			const isCode = !isIframe && !isTable && !isSvgOrMermaid && (targetMedia.tagName.toLowerCase() === "pre" || targetMedia.matches("[class*='block-language-']") || targetMedia.querySelector("pre") !== null);

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
				wrapper.appendChild(clone);
			} else if (isSvgOrMermaid) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-mermaid" });
				wrapper.appendChild(clone);
				enhanceMermaidSvgElements(wrapper);
			} else if (isCode) {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-code" });
				wrapper.appendChild(clone);
			} else {
				const wrapper = this.zoomContentEl.createDiv({ cls: "dynamic-slides-zoom-image" });
				wrapper.appendChild(clone);
				enhanceMermaidSvgElements(wrapper);
			}
		}
	}

	public closeMediaZoom(animated: boolean = true) {
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
	}

	public handleNext(): boolean {
		if (this.hasCompletedAllSteps) {
			return false;
		}

		const wasAnimating = this.currentScrollAnimId !== null;
		if (wasAnimating) {
			this.cancelScrollAnimation(true);
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

		if (!wasAnimating && this.canScrollDown()) {
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

		const wasAnimating = this.currentScrollAnimId !== null;
		if (wasAnimating) {
			this.cancelScrollAnimation(true);
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

		if (!wasAnimating && this.canScrollUp()) {
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
		decoration?: SlideRenderDecoration
	) {
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

		// Decorate child headings with unread diff dot
		if (decoration?.dirtyNodeIds || decoration?.descendantDirtyNodeIds) {
			this.contentEl.querySelectorAll<HTMLElement>(".dynamic-slides-child-heading").forEach((el) => {
				const cid = el.getAttribute("data-node-id") || "";
				if (decoration.dirtyNodeIds?.has(cid)) {
					el.createSpan({ cls: "slideflow-child-diff-badge", text: "🟢 Modifié" });
				} else if (decoration.descendantDirtyNodeIds?.has(cid)) {
					el.createSpan({ cls: "slideflow-child-diff-badge is-sub", text: "🟢" });
				}
			});
		}

		// Decorate internal links pointing to notes/sub-notes with unread diffs
		if (decoration?.isLinkModified) {
			this.refreshLinkModifiedBadges(decoration.isLinkModified);
		}

		const mediaElements = this.detectMediaElements();
		const isOnlyZoomable = this.checkOnlyZoomableContent() && mediaElements.length > 0;
		if (isOnlyZoomable) {
			this.contentEl.addClass("is-only-zoomable-slide");
		} else {
			this.contentEl.removeClass("is-only-zoomable-slide");
		}

		if (enterFrom === 'end') {
			if (mediaElements.length > 0) {
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
	}

	public close() {
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
