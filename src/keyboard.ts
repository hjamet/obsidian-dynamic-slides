export interface KeyboardNavigatorCallbacks {
	onNext: () => void;
	onPrev: () => void;
	onFastNext: () => void;
	onFastPrev: () => void;
	onClose: () => void;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onResetZoom?: () => void;
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

	private handleKeyDown(evt: KeyboardEvent) {
		// Zoom shortcuts: Ctrl + + / Ctrl + - / Ctrl + 0 (or Cmd + ...)
		if (evt.ctrlKey || evt.metaKey) {
			if (evt.key === "+" || evt.key === "=" || evt.code === "Equal" || evt.code === "NumpadAdd") {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.callbacks.onZoomIn) {
					this.callbacks.onZoomIn();
				}
				return;
			}
			if (evt.key === "-" || evt.key === "_" || evt.code === "Minus" || evt.code === "NumpadSubtract") {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.callbacks.onZoomOut) {
					this.callbacks.onZoomOut();
				}
				return;
			}
			if (evt.key === "0" || evt.code === "Digit0" || evt.code === "Numpad0") {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.callbacks.onResetZoom) {
					this.callbacks.onResetZoom();
				}
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
			this.callbacks.onClose();
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
