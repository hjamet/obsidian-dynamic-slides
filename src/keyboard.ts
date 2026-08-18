export interface KeyboardNavigatorCallbacks {
	onNext: () => void;
	onPrev: () => void;
	onFastNext: () => void;
	onFastPrev: () => void;
	onClose: () => void;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onZoomReset?: () => void;
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
		// Check for Zoom shortcuts first (+, -, 0 / Ctrl+=, Ctrl+-, Ctrl+0)
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
			if (this.callbacks.onZoomReset) {
				evt.preventDefault();
				evt.stopPropagation();
				this.callbacks.onZoomReset();
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
