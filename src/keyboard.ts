export interface KeyboardNavigatorCallbacks {
	onNext: () => void;
	onPrev: () => void;
	onFastNext: () => void;
	onFastPrev: () => void;
	onEscape: () => void;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onResetZoom?: () => void;
	onZoomReset?: () => void;
	onOpenCommentText?: () => void;
	onOpenCommentVoice?: () => void;
	onToggleDiff?: () => void;
	onNextDiffSlide?: () => void;
	onToggleReviewDrawer?: () => void;
	onOpenGeneralComment?: () => void;
	onCopyOneShot?: () => void;
	isInputBlocked?: () => boolean;
}

export class KeyboardNavigator {
	private callbacks: KeyboardNavigatorCallbacks;
	private boundHandler: (evt: KeyboardEvent) => void;
	private isAttached: boolean = false;

	constructor(callbacks: KeyboardNavigatorCallbacks) {
		this.callbacks = callbacks;
		this.boundHandler = this.handleKeyDown.bind(this);
	}

	public attach() {
		if (!this.isAttached) {
			window.addEventListener("keydown", this.boundHandler, true);
			this.isAttached = true;
		}
	}

	public detach() {
		if (this.isAttached) {
			window.removeEventListener("keydown", this.boundHandler, true);
			this.isAttached = false;
		}
	}

	private isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName.toLowerCase();
		return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
	}

	private handleKeyDown(evt: KeyboardEvent) {
		if (this.callbacks.isInputBlocked?.() || this.isTypingTarget(evt.target)) {
			return;
		}

		// Ctrl+Enter / Cmd+Enter -> Export /one-shot comments to clipboard
		if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && (evt.key === "Enter" || evt.code === "Enter")) {
			if (this.callbacks.onCopyOneShot) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onCopyOneShot();
				return;
			}
		}

		// Ctrl+I / Cmd+I -> Open Review Queue & focus general comment input
		if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey && evt.key.toLowerCase() === "i") {
			if (this.callbacks.onOpenGeneralComment) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onOpenGeneralComment();
				return;
			}
		}

		// Single-key SlideFlow cockpit shortcuts (ONLY when no Ctrl/Meta/Alt modifier is pressed,
		// so Ctrl+C / Ctrl+V / Ctrl+D keep their native OS/clipboard meaning!)
		if (!evt.ctrlKey && !evt.metaKey && !evt.altKey) {
			const lowerKey = evt.key.toLowerCase();

			if (lowerKey === "c" && this.callbacks.onOpenCommentText) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onOpenCommentText();
				return;
			}

			if (lowerKey === "v" && this.callbacks.onOpenCommentVoice) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onOpenCommentVoice();
				return;
			}

			if (lowerKey === "d" && this.callbacks.onToggleDiff) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onToggleDiff();
				return;
			}

			if (lowerKey === "n" && this.callbacks.onNextDiffSlide) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onNextDiffSlide();
				return;
			}

			if (lowerKey === "r" && this.callbacks.onToggleReviewDrawer) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onToggleReviewDrawer();
				return;
			}
		}

		// Zoom shortcuts (+, -, 0 / Ctrl+=, Ctrl+-, Ctrl+0)
		if (
			evt.code === "Equal" || evt.key === "+" || evt.key === "=" || evt.code === "NumpadAdd"
		) {
			if (this.callbacks.onZoomIn) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onZoomIn();
				return;
			}
		}

		if (
			evt.code === "Minus" || evt.key === "-" || evt.key === "_" || evt.code === "NumpadSubtract"
		) {
			if (this.callbacks.onZoomOut) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onZoomOut();
				return;
			}
		}

		if (
			evt.code === "Digit0" || evt.key === "0" || evt.code === "Numpad0"
		) {
			const resetFn = this.callbacks.onZoomReset || this.callbacks.onResetZoom;
			if (resetFn) {
				evt.preventDefault();
				evt.stopPropagation();
				resetFn();
				return;
			}
		}

		const handledKeys = [
			"ArrowRight",
			"ArrowLeft",
			"ArrowUp",
			"ArrowDown",
			"Space",
			"PageDown",
			"PageUp",
			"Escape"
		];

		if (handledKeys.includes(evt.code) || handledKeys.includes(evt.key)) {
			evt.preventDefault();
			evt.stopPropagation();
		} else {
			return;
		}

		if (evt.code === "Escape" || evt.key === "Escape") {
			this.callbacks.onEscape();
			return;
		}

		if (evt.code === "ArrowRight" || evt.key === "ArrowRight" || evt.code === "PageDown" || (evt.code === "Space" && !evt.shiftKey)) {
			this.callbacks.onNext();
			return;
		}

		if (evt.code === "ArrowLeft" || evt.key === "ArrowLeft" || evt.code === "PageUp" || (evt.code === "Space" && evt.shiftKey)) {
			this.callbacks.onPrev();
			return;
		}

		if (evt.code === "ArrowUp" || evt.key === "ArrowUp") {
			this.callbacks.onFastPrev();
			return;
		}

		if (evt.code === "ArrowDown" || evt.key === "ArrowDown") {
			this.callbacks.onFastNext();
			return;
		}
	}
}
