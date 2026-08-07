import { App, Component } from "obsidian";
import { SectionNode } from "./parser";
import { renderSlideContent, unloadSlideContent } from "./renderer";
import { TOCComponent } from "./toc";

export class PresentationModal extends Component {
	private appRef: App;
	private overlayEl: HTMLElement;
	private mainAreaEl: HTMLElement;
	private hoverToggleBtnEl: HTMLButtonElement;
	private contentEl: HTMLElement;
	private counterEl: HTMLElement;
	private currentSlideComponent: Component | null = null;
	private onCloseCallback?: () => void;
	public onLinkClickCallback?: (href: string) => void;
	private transitionDuration: number;
	private tocComp: TOCComponent | null = null;

	constructor(app: App, onClose?: () => void, transitionDuration: number = 0.65) {
		super();
		this.appRef = app;
		this.onCloseCallback = onClose;
		this.transitionDuration = transitionDuration;

		this.overlayEl = document.body.createDiv({ cls: "dynamic-slides-overlay" });

		const bottomLeftZone = this.overlayEl.createDiv({ cls: "dynamic-slides-bottom-left-zone" });
		this.hoverToggleBtnEl = bottomLeftZone.createEl("button", {
			text: "☰ Table des matières",
			cls: "dynamic-slides-toc-hover-toggle"
		});
		this.hoverToggleBtnEl.setAttribute("aria-label", "Toggle TOC");
		this.hoverToggleBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.tocComp) {
				this.tocComp.toggleSidebar();
			}
		});

		this.mainAreaEl = this.overlayEl.createDiv({ cls: "dynamic-slides-main-area" });
		this.contentEl = this.mainAreaEl.createDiv({ cls: "dynamic-slides-content" });
		this.counterEl = this.mainAreaEl.createDiv({ cls: "dynamic-slides-footer-counter" });

		this.contentEl.addEventListener('click', (evt) => {
			const linkEl = (evt.target as HTMLElement).closest('.internal-link') as HTMLElement;
			if (linkEl) {
				const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
				if (href) {
					evt.preventDefault();
					evt.stopPropagation();
					if (this.onLinkClickCallback) {
						this.onLinkClickCallback(href);
					}
				}
			}
		});
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
		// Breadcrumb removed from minimal UI
	}

	public async open(initialNode: SectionNode, sourcePath: string) {
		document.body.addClass("is-dynamic-slides-active");
		this.overlayEl.style.setProperty('--dynamic-slides-duration', `${this.transitionDuration}s`);
		this.load();

		try {
			if (this.overlayEl.requestFullscreen) {
				await this.overlayEl.requestFullscreen();
			}
		} catch (e) {
			console.warn("[DynamicSlides] Fullscreen request failed or denied:", e);
		}

		await this.updateSlide(initialNode, sourcePath);
	}

	public async updateSlide(
		node: SectionNode,
		sourcePath: string,
		direction: 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump' = 'jump'
	) {
		if (this.currentSlideComponent) {
			unloadSlideContent(this.currentSlideComponent, this);
			this.currentSlideComponent = null;
		}

		// Re-trigger slide transition animation
		this.contentEl.removeClass(
			"slide-anim-next",
			"slide-anim-prev",
			"slide-anim-zoom-in",
			"slide-anim-zoom-out",
			"slide-anim-jump"
		);
		void this.contentEl.offsetWidth;
		this.contentEl.addClass(`slide-anim-${direction}`);

		this.currentSlideComponent = await renderSlideContent(
			this.appRef,
			node.contentMarkdown,
			this.contentEl,
			sourcePath,
			this
		);
	}

	public close() {
		if (document.fullscreenElement === this.overlayEl) {
			try {
				document.exitFullscreen();
			} catch (e) {
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


