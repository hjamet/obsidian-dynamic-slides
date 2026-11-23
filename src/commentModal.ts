/**
 * CommentOverlayModal — Modale flottante discrète (sans voile sombre) dans SlideFlow.
 *
 * - Sans sélection : ancrée sous la slide si la hauteur le permet, sinon à droite.
 * - Avec sélection de texte : ancrée juste sous le passage surligné en vert (façon Antigravity).
 * - Raccourcis : `C` texte, `V` dictée immédiate (`V` ou `Ctrl+M` pour arrêter la capture, zone texte
 *   verrouillée pendant l'enregistrement, `Entrée` arrête la capture et enregistre uniquement si
 *   la transcription réussit), `Ctrl+V` coller une image, `Shift+Entrée` saut de ligne, `Échap` fermer.
 */

import { Notice } from "obsidian";
import { AnchorRect, setGreenSelectionHighlight } from "./contextExtractor";
import { ReviewComment } from "./reviewStore";
import { VoiceDictationService, VoiceProgressUpdate } from "./voiceDictation";
import {
	CommentImageAttachment,
	deleteTempImageSafe,
	readImageAsDataUrl,
	saveImageBufferToTemp,
} from "./commentImages";

export interface CommentModalContext {
	noteTitle: string;
	notePath: string;
	sectionHeading: string;
	scopeLabel: string;
	hadDiff: boolean;
	existingComments: ReviewComment[];
	startWithVoice: boolean;
	anchorRect?: AnchorRect | null;
	highlightRange?: Range | null;
	editingComment?: ReviewComment | null;
	slideContentEl?: HTMLElement | null;
	isMediaZoomActive?: boolean;
}

export interface CommentModalCallbacks {
	onSubmit: (
		commentText: string,
		editingId?: string,
		images?: CommentImageAttachment[]
	) => Promise<void>;
	onDeleteExisting: (commentId: string) => Promise<void>;
	onClose: () => void;
}

interface StopVoiceResult {
	ok: boolean;
	text: string;
	hadError: boolean;
}

const IMAGE_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
const MIC_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;

export class CommentOverlayModal {
	private parentEl: HTMLElement;
	private voiceService: VoiceDictationService;
	private callbacks: CommentModalCallbacks;

	private cardEl: HTMLElement | null = null;
	private textareaEl: HTMLTextAreaElement | null = null;
	private imagesStripEl: HTMLElement | null = null;
	private fileInputEl: HTMLInputElement | null = null;
	private micBtnEl: HTMLButtonElement | null = null;
	private submitBtnEl: HTMLButtonElement | null = null;
	private voiceFeedbackEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private progressPctEl: HTMLElement | null = null;
	private meterTrackEl: HTMLElement | null = null;
	private levelFillEl: HTMLElement | null = null;
	private existingListEl: HTMLElement | null = null;

	private isOpenFlag: boolean = false;
	private isStartingVoice: boolean = false;
	private voiceStartPromise: Promise<boolean> | null = null;
	private isBusyTranscribing: boolean = false;
	private openedAt: number = 0;
	private editingId: string | null = null;
	private attachedImages: CommentImageAttachment[] = [];
	private newlyCreatedTempPaths: Set<string> = new Set();
	private submittedSuccessfully: boolean = false;
	private recStartTime: number = 0;
	private recTimerId: number | null = null;
	private boundKeyHandler: (evt: KeyboardEvent) => void;
	private boundOutsideClickHandler: (evt: MouseEvent) => void;
	private boundPasteHandler: (evt: ClipboardEvent) => void;

	constructor(
		parentEl: HTMLElement,
		voiceService: VoiceDictationService,
		callbacks: CommentModalCallbacks
	) {
		this.parentEl = parentEl;
		this.voiceService = voiceService;
		this.callbacks = callbacks;
		this.boundKeyHandler = this.handleKeyDown.bind(this);
		this.boundOutsideClickHandler = this.handleOutsideMouseDown.bind(this);
		this.boundPasteHandler = this.handlePaste.bind(this);
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	private isVoiceCaptureActive(): boolean {
		return this.isStartingVoice || this.voiceService.isRecording();
	}

	private setTextareaVoiceLocked(locked: boolean): void {
		if (this.textareaEl) {
			this.textareaEl.readOnly = locked;
			this.textareaEl.toggleClass("is-voice-locked", locked);
			if (locked && document.activeElement === this.textareaEl) {
				this.textareaEl.blur();
			}
		}
		if (this.cardEl) {
			this.cardEl.toggleClass("is-voice-capturing", locked);
		}
	}

	public open(ctx: CommentModalContext): void {
		this.close(false);
		this.isOpenFlag = true;
		this.openedAt = Date.now();
		this.submittedSuccessfully = false;
		this.parentEl.addClass("is-comment-modal-open");
		this.isStartingVoice = false;
		this.voiceStartPromise = null;
		this.isBusyTranscribing = false;
		this.editingId = ctx.editingComment ? ctx.editingComment.id : null;
		this.attachedImages = ctx.editingComment?.images ? [...ctx.editingComment.images] : [];
		this.newlyCreatedTempPaths = new Set();

		if (ctx.highlightRange) {
			setGreenSelectionHighlight(ctx.highlightRange);
		}

		const hasAnchor = Boolean(ctx.anchorRect);
		const anchorFitsVertically = ctx.anchorRect
			? ctx.anchorRect.bottom + 185 < window.innerHeight || ctx.anchorRect.top - 185 > 16
			: false;
		const isSelectionAnchored = hasAnchor && anchorFitsVertically;
		let placementClass: "is-selection-anchored" | "is-below-slide" | "is-right-docked" = "is-right-docked";
		let belowSlideGeom: { left: number; top: number; width: number } | null = null;

		if (isSelectionAnchored) {
			placementClass = "is-selection-anchored";
		} else if (!hasAnchor && !ctx.isMediaZoomActive && ctx.slideContentEl) {
			const slideRect = ctx.slideContentEl.getBoundingClientRect();
			const footerReserve = 76;
			const neededHeight = ctx.existingComments.length > 0 ? 225 : 168;
			const spaceBelow = window.innerHeight - slideRect.bottom - footerReserve;
			if (slideRect.height > 0 && spaceBelow >= neededHeight) {
				placementClass = "is-below-slide";
				const cardWidth = Math.min(560, Math.max(360, Math.round(slideRect.width)));
				const centerX = slideRect.left + slideRect.width / 2;
				const left = Math.max(16, Math.min(window.innerWidth - cardWidth - 16, centerX - cardWidth / 2));
				belowSlideGeom = {
					left: Math.round(left),
					top: Math.round(slideRect.bottom + 14),
					width: cardWidth,
				};
			}
		}

		if (placementClass === "is-right-docked") {
			this.parentEl.addClass("is-comment-docked-right");
		} else {
			this.parentEl.removeClass("is-comment-docked-right");
		}

		this.cardEl = this.parentEl.createDiv({
			cls: `slideflow-comment-card ${placementClass}`,
		});
		if (belowSlideGeom) {
			this.cardEl.style.left = `${belowSlideGeom.left}px`;
			this.cardEl.style.top = `${belowSlideGeom.top}px`;
			this.cardEl.style.width = `${belowSlideGeom.width}px`;
		}
		this.cardEl.addEventListener("click", (evt) => evt.stopPropagation());
		this.cardEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

		// Drag & drop image files directly onto the comment card
		this.cardEl.addEventListener("dragover", (evt) => {
			if (evt.dataTransfer && Array.from(evt.dataTransfer.types).includes("Files")) {
				evt.preventDefault();
				evt.stopPropagation();
				this.cardEl?.addClass("is-drag-over");
			}
		});
		this.cardEl.addEventListener("dragleave", () => {
			this.cardEl?.removeClass("is-drag-over");
		});
		this.cardEl.addEventListener("drop", (evt) => {
			this.cardEl?.removeClass("is-drag-over");
			const files = Array.from(evt.dataTransfer?.files || []).filter((f) =>
				f.type.startsWith("image/")
			);
			if (files.length > 0) {
				evt.preventDefault();
				evt.stopPropagation();
				void this.attachImageFiles(files);
			}
		});

		// Subtle 1-line scope header
		const headerEl = this.cardEl.createDiv({ cls: "slideflow-comment-header" });
		const metaText = headerEl.createSpan({ cls: "slideflow-comment-meta" });
		metaText.setText(ctx.scopeLabel);
		if (ctx.hadDiff) {
			headerEl.createSpan({
				cls: "slideflow-comment-diff-tag",
				text: "diff included",
				attr: { title: "Previous and current text will both be sent" },
			});
		}

		// Textarea (clean minimal rounded box like Antigravity)
		this.textareaEl = this.cardEl.createEl("textarea", {
			cls: "slideflow-comment-textarea",
			attr: {
				rows: "2",
				placeholder: ctx.startWithVoice
					? "Voice capture active… Press V to stop or Enter to stop & save"
					: "Leave a comment (Ctrl+V to paste image)",
			},
		});
		if (ctx.editingComment) {
			this.textareaEl.value = ctx.editingComment.commentText;
		}
		this.textareaEl.addEventListener("input", () => this.autoResizeTextarea());
		this.textareaEl.addEventListener("focus", () => {
			if (this.isVoiceCaptureActive() || this.isBusyTranscribing) {
				this.textareaEl?.blur();
			}
		});

		// Thumbnail strip for pasted/attached temporary images
		this.imagesStripEl = this.cardEl.createDiv({ cls: "slideflow-comment-images-strip" });
		this.imagesStripEl.style.display = "none";
		this.renderAttachedImages();

		// Hidden file picker for optional click-to-attach image
		this.fileInputEl = this.cardEl.createEl("input", {
			cls: "slideflow-comment-file-input",
			attr: {
				type: "file",
				accept: "image/*",
				multiple: "multiple",
			},
		});
		this.fileInputEl.style.display = "none";
		this.fileInputEl.addEventListener("change", () => {
			const files = Array.from(this.fileInputEl?.files || []).filter((f) =>
				f.type.startsWith("image/")
			);
			if (files.length > 0) {
				void this.attachImageFiles(files);
			}
			if (this.fileInputEl) this.fileInputEl.value = "";
		});

		// Live voice feedback & progress bar (hidden unless recording, downloading/loading/transcribing, or error)
		this.voiceFeedbackEl = this.cardEl.createDiv({ cls: "slideflow-comment-voice-feedback" });
		this.voiceFeedbackEl.style.display = "none";
		const statusRow = this.voiceFeedbackEl.createDiv({ cls: "slideflow-comment-status-row" });
		this.statusEl = statusRow.createDiv({ cls: "slideflow-comment-status" });
		this.progressPctEl = statusRow.createDiv({ cls: "slideflow-comment-progress-pct" });
		this.meterTrackEl = this.voiceFeedbackEl.createDiv({ cls: "slideflow-voice-meter-track" });
		this.levelFillEl = this.meterTrackEl.createDiv({ cls: "slideflow-voice-meter-fill" });

		// Minimal footer: Cancel | Attach image | Mic icon | Add Comment pill
		const footerEl = this.cardEl.createDiv({ cls: "slideflow-comment-footer" });

		const cancelBtn = footerEl.createEl("button", {
			cls: "slideflow-comment-cancel-btn",
			text: "Cancel",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.close(true);
		});

		const rightActions = footerEl.createDiv({ cls: "slideflow-comment-right-actions" });

		const imgBtn = rightActions.createEl("button", {
			cls: "slideflow-comment-img-btn",
			attr: {
				type: "button",
				title: "Attach image (or paste with Ctrl+V)",
				"aria-label": "Attach image",
			},
		});
		imgBtn.innerHTML = IMAGE_ICON_SVG;
		imgBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.fileInputEl?.click();
		});

		this.micBtnEl = rightActions.createEl("button", {
			cls: "slideflow-comment-mic-btn",
			attr: {
				type: "button",
				title: "Voice dictation (V while recording / Ctrl+M)",
				"aria-label": "Toggle voice dictation (Ctrl+M)",
			},
		});
		this.micBtnEl.innerHTML = MIC_ICON_SVG;
		this.micBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.toggleVoiceDictation();
		});

		this.submitBtnEl = rightActions.createEl("button", {
			cls: "slideflow-comment-submit-btn",
			text: this.editingId ? "Update" : "Add Comment",
			attr: { type: "button" },
		});
		this.submitBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.handleSubmit();
		});

		// Existing comments on this slide (tucked discreetly at the bottom if any)
		this.existingListEl = this.cardEl.createDiv({ cls: "slideflow-comment-existing-list" });
		this.renderExistingComments(ctx.existingComments);

		// Position selection-anchored card cleanly without overflowing viewport
		if (isSelectionAnchored && ctx.anchorRect) {
			this.positionNearAnchor(ctx.anchorRect);
		}

		// Lock textarea synchronously before first frame when launched via `V` so zero stray keystrokes leak in
		if (ctx.startWithVoice) {
			this.setTextareaVoiceLocked(true);
		}

		window.addEventListener("keydown", this.boundKeyHandler, true);
		window.addEventListener("paste", this.boundPasteHandler, true);
		window.setTimeout(() => {
			window.addEventListener("mousedown", this.boundOutsideClickHandler, true);
		}, 0);

		requestAnimationFrame(() => {
			this.autoResizeTextarea();
			if (ctx.startWithVoice) {
				void this.startVoiceDictation();
			} else {
				this.textareaEl?.focus();
				if (this.textareaEl && this.editingId) {
					const len = this.textareaEl.value.length;
					this.textareaEl.setSelectionRange(len, len);
				}
			}
		});
	}

	private handlePaste(evt: ClipboardEvent): void {
		if (!this.isOpenFlag) return;
		const dt = evt.clipboardData;
		const imageFiles: File[] = [];

		if (dt?.items) {
			for (let i = 0; i < dt.items.length; i++) {
				const item = dt.items[i];
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const f = item.getAsFile();
					if (f) imageFiles.push(f);
				}
			}
		}

		if (imageFiles.length === 0 && dt?.files && dt.files.length > 0) {
			for (let i = 0; i < dt.files.length; i++) {
				const f = dt.files[i];
				if (f.type.startsWith("image/")) {
					imageFiles.push(f);
				}
			}
		}

		if (imageFiles.length > 0) {
			evt.preventDefault();
			evt.stopPropagation();
			void this.attachImageFiles(imageFiles);
			return;
		}

		// Block plain-text paste into textarea while voice capture is active
		if (this.isVoiceCaptureActive() || this.isBusyTranscribing) {
			evt.preventDefault();
			evt.stopPropagation();
			return;
		}

		// Electron native clipboard fallback (Windows Snipping Tool / raw DIB bitmaps)
		const hasPlainText = Boolean(dt?.getData("text/plain"));
		if (!hasPlainText) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const electronMod = (window as any).require?.("electron");
				const nativeImg = electronMod?.clipboard?.readImage?.();
				if (nativeImg && !nativeImg.isEmpty()) {
					const pngBuf: Buffer = nativeImg.toPNG();
					if (pngBuf && pngBuf.length > 0) {
						evt.preventDefault();
						evt.stopPropagation();
						void this.attachImageBuffer(pngBuf, "image/png");
					}
				}
			} catch {
				// non-Electron or clipboard unavailable — let default paste proceed
			}
		}
	}

	private async attachImageFiles(files: File[]): Promise<void> {
		for (const file of files) {
			try {
				const arrBuf = await file.arrayBuffer();
				const buf = Buffer.from(arrBuf);
				await this.attachImageBuffer(buf, file.type || "image/png");
			} catch (err: any) {
				const msg = err?.message || String(err);
				this.setStatus(`Image error: ${msg}`, "error");
				new Notice(`SlideFlow image attach failed: ${msg}`);
			}
		}
	}

	private async attachImageBuffer(buffer: Buffer, mimeType: string): Promise<void> {
		const attachment = await saveImageBufferToTemp(buffer, mimeType);
		this.attachedImages.push(attachment);
		this.newlyCreatedTempPaths.add(attachment.path);
		this.renderAttachedImages();
		if (!this.isVoiceCaptureActive() && !this.isBusyTranscribing) {
			this.setStatus("", "hidden");
			this.textareaEl?.focus();
		}
	}

	private renderAttachedImages(): void {
		if (!this.imagesStripEl) return;
		this.imagesStripEl.empty();

		if (this.attachedImages.length === 0) {
			this.imagesStripEl.style.display = "none";
			return;
		}

		this.imagesStripEl.style.display = "flex";
		for (const img of this.attachedImages) {
			const chip = this.imagesStripEl.createDiv({
				cls: "slideflow-comment-image-thumb-wrap",
				attr: { title: `${img.fileName} (${Math.max(1, Math.round(img.sizeBytes / 1024))} KB)\n${img.path}` },
			});

			const imgEl = chip.createEl("img", {
				cls: "slideflow-comment-image-thumb",
				attr: { alt: img.fileName },
			});
			void readImageAsDataUrl(img.path, img.mimeType).then((dataUrl) => {
				if (dataUrl && imgEl.isConnected) {
					imgEl.src = dataUrl;
				}
			});

			const removeBtn = chip.createEl("button", {
				cls: "slideflow-comment-image-remove-btn",
				text: "×",
				attr: { type: "button", title: "Remove image", "aria-label": "Remove image" },
			});
			removeBtn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.attachedImages = this.attachedImages.filter((a) => a.id !== img.id);
				if (this.newlyCreatedTempPaths.has(img.path)) {
					deleteTempImageSafe(img.path);
					this.newlyCreatedTempPaths.delete(img.path);
				}
				this.renderAttachedImages();
			});
		}
	}

	private positionNearAnchor(rect: AnchorRect): void {
		if (!this.cardEl) return;
		const cardWidth = 370;
		const estimatedHeight = 175;
		const margin = 16;

		let left = rect.left;
		if (left + cardWidth > window.innerWidth - margin) {
			left = Math.max(margin, window.innerWidth - cardWidth - margin);
		}
		if (left < margin) left = margin;

		let top = rect.bottom + 10;
		if (top + estimatedHeight > window.innerHeight - margin) {
			top = Math.max(margin, rect.top - estimatedHeight - 10);
		}

		this.cardEl.style.left = `${Math.round(left)}px`;
		this.cardEl.style.top = `${Math.round(top)}px`;
	}

	private autoResizeTextarea(): void {
		if (!this.textareaEl) return;
		this.textareaEl.style.height = "auto";
		const maxH = 200;
		this.textareaEl.style.height = `${Math.min(maxH, Math.max(54, this.textareaEl.scrollHeight))}px`;
	}

	private handleOutsideMouseDown(evt: MouseEvent): void {
		if (!this.isOpenFlag || !this.cardEl) return;
		const target = evt.target as Node | null;
		if (target && this.cardEl.contains(target)) return;
		const hasDraft =
			Boolean(this.textareaEl?.value.trim()) ||
			this.attachedImages.length > 0 ||
			this.isVoiceCaptureActive() ||
			this.isBusyTranscribing;
		if (!hasDraft) {
			this.close(true);
		}
	}

	private renderExistingComments(comments: ReviewComment[]): void {
		if (!this.existingListEl) return;
		this.existingListEl.empty();
		if (comments.length === 0) {
			this.existingListEl.style.display = "none";
			return;
		}
		this.existingListEl.style.display = "flex";
		for (const c of comments) {
			const row = this.existingListEl.createDiv({ cls: "slideflow-existing-comment-row" });
			const imgTag = c.images && c.images.length > 0 ? ` [${c.images.length} img]` : "";
			row.createSpan({
				cls: "slideflow-existing-comment-text",
				text: `${c.commentText || "(Image attached)"}${imgTag}`,
			});

			const btns = row.createDiv({ cls: "slideflow-existing-comment-btns" });
			const editBtn = btns.createEl("button", {
				cls: "slideflow-mini-text-btn",
				text: "Edit",
				attr: { type: "button" },
			});
			editBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.editingId = c.id;
				this.attachedImages = c.images ? [...c.images] : [];
				this.renderAttachedImages();
				if (this.textareaEl) {
					this.textareaEl.value = c.commentText;
					this.autoResizeTextarea();
					if (!this.isVoiceCaptureActive() && !this.isBusyTranscribing) {
						this.textareaEl.focus();
					}
				}
				if (this.submitBtnEl) {
					this.submitBtnEl.setText("Update");
				}
			});

			const delBtn = btns.createEl("button", {
				cls: "slideflow-mini-text-btn danger",
				text: "Delete",
				attr: { type: "button" },
			});
			delBtn.addEventListener("click", async (evt) => {
				evt.stopPropagation();
				await this.callbacks.onDeleteExisting(c.id);
				row.remove();
				if (this.existingListEl && this.existingListEl.childElementCount === 0) {
					this.existingListEl.style.display = "none";
				}
			});
		}
	}

	private handleKeyDown(evt: KeyboardEvent): void {
		if (!this.isOpenFlag) return;

		if (evt.key === "Escape" || evt.code === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close(true);
			return;
		}

		// While transcribing / downloading model, block all input except Escape
		if (this.isBusyTranscribing) {
			evt.preventDefault();
			evt.stopPropagation();
			return;
		}

		if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "m") {
			evt.preventDefault();
			evt.stopPropagation();
			if (!evt.repeat) {
				void this.toggleVoiceDictation();
			}
			return;
		}

		// During active voice capture: textarea is strictly locked (no typing allowed!).
		// `V` stops capture & transcribes for review; `Enter` stops capture, transcribes, and saves if successful.
		if (this.isVoiceCaptureActive()) {
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				evt.stopPropagation();
				if (!evt.repeat) {
					void this.handleSubmit();
				}
				return;
			}

			if (!evt.ctrlKey && !evt.metaKey && !evt.altKey && evt.key.toLowerCase() === "v") {
				evt.preventDefault();
				evt.stopPropagation();
				// Ignore key repeat or the very same press that opened voice mode (<250ms)
				if (!evt.repeat && Date.now() - this.openedAt >= 250) {
					void this.stopVoiceOnly();
				}
				return;
			}

			// Allow Ctrl+V image paste while recording, block every other key from typing into the textarea
			if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "v") {
				evt.stopPropagation();
				return;
			}

			evt.preventDefault();
			evt.stopPropagation();
			return;
		}

		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			evt.stopPropagation();
			if (!evt.repeat) {
				void this.handleSubmit();
			}
			return;
		}

		evt.stopPropagation();
	}

	private setStatus(
		msg: string,
		mode: "hidden" | "idle" | "recording" | "busy" | "error" = "idle",
		progressPercent: number | null = null
	): void {
		if (!this.voiceFeedbackEl || !this.statusEl) return;
		if (mode === "hidden" || !msg) {
			this.voiceFeedbackEl.style.display = "none";
			this.meterTrackEl?.removeClass("is-progress", "is-indeterminate");
			if (this.progressPctEl) this.progressPctEl.setText("");
			return;
		}
		this.voiceFeedbackEl.style.display = "flex";
		this.statusEl.setText(msg);
		this.statusEl.removeClass("is-recording", "is-busy", "is-error");
		if (mode === "recording") this.statusEl.addClass("is-recording");
		if (mode === "busy") this.statusEl.addClass("is-busy");
		if (mode === "error") this.statusEl.addClass("is-error");

		if (this.meterTrackEl && this.levelFillEl) {
			if (mode === "busy") {
				this.meterTrackEl.style.display = "block";
				this.meterTrackEl.addClass("is-progress");
				if (progressPercent !== null && Number.isFinite(progressPercent)) {
					const clamped = Math.max(0, Math.min(100, Math.round(progressPercent)));
					this.meterTrackEl.removeClass("is-indeterminate");
					this.levelFillEl.style.width = `${clamped}%`;
					if (this.progressPctEl) this.progressPctEl.setText(`${clamped}%`);
				} else {
					this.meterTrackEl.addClass("is-indeterminate");
					this.levelFillEl.style.width = "";
					if (this.progressPctEl) this.progressPctEl.setText("");
				}
			} else if (mode === "recording") {
				this.meterTrackEl.style.display = "block";
				this.meterTrackEl.removeClass("is-progress", "is-indeterminate");
				if (this.progressPctEl) this.progressPctEl.setText("");
			} else {
				this.meterTrackEl.style.display = "none";
				this.meterTrackEl.removeClass("is-progress", "is-indeterminate");
				this.levelFillEl.style.width = "0%";
				if (this.progressPctEl) this.progressPctEl.setText("");
			}
		}
	}

	private stopRecTimer(): void {
		if (this.recTimerId !== null) {
			window.clearInterval(this.recTimerId);
			this.recTimerId = null;
		}
		if (this.levelFillEl) {
			this.levelFillEl.style.width = "0%";
		}
	}

	private async toggleVoiceDictation(): Promise<void> {
		if (this.isBusyTranscribing) return;
		if (this.isVoiceCaptureActive()) {
			await this.stopVoiceOnly();
		} else {
			await this.startVoiceDictation();
		}
	}

	private async stopVoiceOnly(): Promise<void> {
		if (this.voiceStartPromise) {
			const started = await this.voiceStartPromise;
			if (!started || !this.isOpenFlag) return;
		}
		if (this.voiceService.isRecording()) {
			await this.stopVoiceAndAppend();
		}
	}

	private startVoiceDictation(): Promise<boolean> {
		if (this.isBusyTranscribing || this.voiceService.isRecording()) {
			return Promise.resolve(this.voiceService.isRecording());
		}
		if (this.voiceStartPromise) {
			return this.voiceStartPromise;
		}

		this.isStartingVoice = true;
		this.setTextareaVoiceLocked(true);
		this.setStatus("Starting microphone…", "busy", null);

		const runStart = async (): Promise<boolean> => {
			try {
				await this.voiceService.startRecording((level) => {
					if (this.levelFillEl && this.voiceService.isRecording()) {
						this.levelFillEl.style.width = `${Math.round(level * 100)}%`;
					}
				});
				if (!this.isOpenFlag) {
					this.voiceService.cancelRecording();
					return false;
				}
				this.recStartTime = Date.now();
				this.micBtnEl?.addClass("is-recording");
				const updateElapsed = () => {
					const secs = Math.floor((Date.now() - this.recStartTime) / 1000);
					const mm = Math.floor(secs / 60);
					const ss = String(secs % 60).padStart(2, "0");
					const bgProgress = this.voiceService.isEngineBootstrapping()
						? this.voiceService.getCurrentProgress()
						: null;
					const bgHint =
						bgProgress && bgProgress.stage !== "ready"
							? bgProgress.percent !== null
								? ` · Engine ${bgProgress.percent}%`
								: " · Engine preparing…"
							: "";
					this.setStatus(
						`Listening ${mm}:${ss}${bgHint} · V stop · Enter save`,
						"recording"
					);
				};
				updateElapsed();
				this.recTimerId = window.setInterval(updateElapsed, 250);
				return true;
			} catch (err: any) {
				const msg = err?.message || String(err);
				this.setTextareaVoiceLocked(false);
				this.setStatus(`Mic error: ${msg}`, "error");
				new Notice(`SlideFlow mic: ${msg}`);
				return false;
			} finally {
				this.isStartingVoice = false;
				this.voiceStartPromise = null;
			}
		};

		this.voiceStartPromise = runStart();
		return this.voiceStartPromise;
	}

	private async stopVoiceAndAppend(): Promise<StopVoiceResult> {
		this.stopRecTimer();
		this.micBtnEl?.removeClass("is-recording");
		this.isBusyTranscribing = true;
		this.setTextareaVoiceLocked(true);
		if (this.submitBtnEl) this.submitBtnEl.disabled = true;

		try {
			const res = await this.voiceService.stopAndTranscribe((update: VoiceProgressUpdate) => {
				if (!this.isOpenFlag) return;
				this.setStatus(update.message, "busy", update.percent);
			});

			if (!this.isOpenFlag) {
				return { ok: false, text: "", hadError: false };
			}

			const text = (res.text || "").trim();
			if (text && this.textareaEl) {
				const existing = this.textareaEl.value;
				const sep =
					existing.trim().length > 0 && !existing.endsWith(" ") && !existing.endsWith("\n")
						? " "
						: "";
				this.textareaEl.value = `${existing}${sep}${text}`;
				this.autoResizeTextarea();
				this.setStatus("", "hidden");
				return { ok: true, text, hadError: false };
			}
			this.setStatus("No speech detected. Press Ctrl+M to retry.", "idle");
			return { ok: false, text: "", hadError: false };
		} catch (err: any) {
			const msg = err?.message || String(err);
			if (this.isOpenFlag) {
				this.setStatus(`Whisper error: ${msg}`, "error");
				new Notice(`SlideFlow Whisper: ${msg}`);
			}
			return { ok: false, text: "", hadError: true };
		} finally {
			this.isBusyTranscribing = false;
			if (this.submitBtnEl) this.submitBtnEl.disabled = false;
			if (this.isOpenFlag) {
				this.setTextareaVoiceLocked(false);
				if (this.textareaEl) {
					this.textareaEl.focus();
					const len = this.textareaEl.value.length;
					this.textareaEl.setSelectionRange(len, len);
				}
			}
		}
	}

	private async handleSubmit(): Promise<void> {
		if (this.isBusyTranscribing) return;

		if (this.voiceStartPromise) {
			const started = await this.voiceStartPromise;
			if (!started || !this.isOpenFlag) return;
		}

		if (this.voiceService.isRecording()) {
			const voiceRes = await this.stopVoiceAndAppend();
			// Enter during voice capture only auto-saves when transcription succeeded with real text!
			if (!this.isOpenFlag || !voiceRes.ok || !voiceRes.text) {
				return;
			}
		}

		const text = (this.textareaEl?.value || "").trim();
		const imagesSnapshot = [...this.attachedImages];
		if (!text && imagesSnapshot.length === 0) {
			this.setStatus("Comment is empty.", "error");
			this.textareaEl?.focus();
			return;
		}

		const editId = this.editingId || undefined;
		this.submittedSuccessfully = true;
		this.close(false);
		await this.callbacks.onSubmit(text, editId, imagesSnapshot);
	}

	public close(invokeOnCloseCallback: boolean = true): void {
		this.parentEl.removeClass("is-comment-docked-right");
		this.parentEl.removeClass("is-comment-modal-open");
		if (!this.isOpenFlag && !this.cardEl) return;
		this.isOpenFlag = false;
		this.isStartingVoice = false;
		this.voiceStartPromise = null;
		this.isBusyTranscribing = false;
		this.stopRecTimer();
		setGreenSelectionHighlight(null);
		if (this.voiceService.isRecording()) {
			this.voiceService.cancelRecording();
		}
		// Clean up newly pasted images that were cancelled without submitting
		if (!this.submittedSuccessfully && this.newlyCreatedTempPaths.size > 0) {
			for (const p of this.newlyCreatedTempPaths) {
				deleteTempImageSafe(p);
			}
		}
		this.newlyCreatedTempPaths.clear();
		this.attachedImages = [];
		this.submittedSuccessfully = false;

		window.removeEventListener("keydown", this.boundKeyHandler, true);
		window.removeEventListener("paste", this.boundPasteHandler, true);
		window.removeEventListener("mousedown", this.boundOutsideClickHandler, true);
		if (this.cardEl) {
			this.cardEl.remove();
			this.cardEl = null;
		}
		this.textareaEl = null;
		this.imagesStripEl = null;
		this.fileInputEl = null;
		this.micBtnEl = null;
		this.submitBtnEl = null;
		this.voiceFeedbackEl = null;
		this.statusEl = null;
		this.progressPctEl = null;
		this.meterTrackEl = null;
		this.levelFillEl = null;
		this.existingListEl = null;
		this.editingId = null;

		if (invokeOnCloseCallback) {
			this.callbacks.onClose();
		}
	}
}
