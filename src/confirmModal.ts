/**
 * ConfirmOverlayModal — Lightweight keyboard-first confirmation dialog mounted inside
 * SlideFlow's fullscreen `overlayEl`.
 *
 * Supports:
 * - Delete confirmation inside Review Queue (`Enter` confirms, `Escape` cancels)
 * - Presentation exit warning with unsent/uncopied comments
 *   (`Ctrl+Enter` copies/sends & exits, `Escape` returns to presentation,
 *    explicit button click discards all & exits)
 */

export interface ConfirmDialogOptions {
	title: string;
	message: string;
	quotePreview?: string;
	confirmLabelHtml: string;
	confirmVariant?: "primary" | "danger";
	confirmShortcut: "Enter" | "Ctrl+Enter";
	cancelLabelHtml?: string;
	discardLabel?: string;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
	onDiscard?: () => void | Promise<void>;
}

export class ConfirmOverlayModal {
	private parentEl: HTMLElement;
	private backdropEl: HTMLElement | null = null;
	private isOpenFlag: boolean = false;
	private currentOptions: ConfirmDialogOptions | null = null;
	private boundKeyHandler: (evt: KeyboardEvent) => void;

	constructor(parentEl: HTMLElement) {
		this.parentEl = parentEl;
		this.boundKeyHandler = this.handleKeyDown.bind(this);
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	public open(options: ConfirmDialogOptions): void {
		this.close();
		this.isOpenFlag = true;
		this.currentOptions = options;

		this.backdropEl = this.parentEl.createDiv({ cls: "slideflow-confirm-backdrop" });
		this.backdropEl.addEventListener("click", (evt) => {
			if (evt.target === this.backdropEl) {
				evt.stopPropagation();
				this.triggerCancel();
			}
		});

		const cardEl = this.backdropEl.createDiv({ cls: "slideflow-confirm-card" });
		cardEl.addEventListener("click", (evt) => evt.stopPropagation());
		cardEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

		cardEl.createEl("h3", {
			cls: "slideflow-confirm-title",
			text: options.title,
		});

		cardEl.createDiv({
			cls: "slideflow-confirm-message",
			text: options.message,
		});

		if (options.quotePreview) {
			cardEl.createDiv({
				cls: "slideflow-confirm-quote",
				text: options.quotePreview,
			});
		}

		const actionsEl = cardEl.createDiv({ cls: "slideflow-confirm-actions" });

		const leftGroup = actionsEl.createDiv({ cls: "slideflow-confirm-actions-left" });
		if (options.discardLabel && options.onDiscard) {
			const discardBtn = leftGroup.createEl("button", {
				cls: "slideflow-confirm-btn is-secondary",
				text: options.discardLabel,
				attr: { type: "button" },
			});
			discardBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.triggerDiscard();
			});
		}

		const rightGroup = actionsEl.createDiv({ cls: "slideflow-confirm-actions-right" });

		const cancelBtn = rightGroup.createEl("button", {
			cls: "slideflow-confirm-btn is-secondary",
			attr: { type: "button" },
		});
		cancelBtn.innerHTML = options.cancelLabelHtml || `Cancel <strong>Esc</strong>`;
		cancelBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.triggerCancel();
		});

		const confirmCls =
			options.confirmVariant === "danger"
				? "slideflow-confirm-btn is-danger"
				: "slideflow-confirm-btn is-primary";
		const confirmBtn = rightGroup.createEl("button", {
			cls: confirmCls,
			attr: { type: "button" },
		});
		confirmBtn.innerHTML = options.confirmLabelHtml;
		confirmBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.triggerConfirm();
		});

		window.addEventListener("keydown", this.boundKeyHandler, true);
	}

	private triggerConfirm(): void {
		const cb = this.currentOptions?.onConfirm;
		this.close();
		if (cb) {
			void cb();
		}
	}

	private triggerCancel(): void {
		const cb = this.currentOptions?.onCancel;
		this.close();
		if (cb) {
			cb();
		}
	}

	private triggerDiscard(): void {
		const cb = this.currentOptions?.onDiscard;
		this.close();
		if (cb) {
			void cb();
		}
	}

	private handleKeyDown(evt: KeyboardEvent): void {
		if (!this.isOpenFlag || !this.currentOptions) return;

		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();

		if (evt.key === "Escape" || evt.code === "Escape") {
			this.triggerCancel();
			return;
		}

		const isEnter = evt.key === "Enter" || evt.code === "Enter";
		if (this.currentOptions.confirmShortcut === "Enter") {
			if (isEnter && !evt.ctrlKey && !evt.metaKey && !evt.altKey && !evt.shiftKey) {
				this.triggerConfirm();
				return;
			}
		} else if (this.currentOptions.confirmShortcut === "Ctrl+Enter") {
			if (isEnter && (evt.ctrlKey || evt.metaKey) && !evt.altKey) {
				this.triggerConfirm();
				return;
			}
		}
	}

	public close(): void {
		if (!this.isOpenFlag && !this.backdropEl) return;
		this.isOpenFlag = false;
		this.currentOptions = null;
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		if (this.backdropEl) {
			this.backdropEl.remove();
			this.backdropEl = null;
		}
	}
}
