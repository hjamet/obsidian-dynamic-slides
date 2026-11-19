/**
 * CommentOverlayModal — Modale flottante discrète (sans voile sombre) dans SlideFlow.
 *
 * - Sans sélection : ancrée proprement à gauche pour laisser la slide 100 % lisible à côté.
 * - Avec sélection de texte : ancrée juste sous le passage surligné en vert (façon Antigravity).
 * - Raccourcis : `C` texte, `V` dictée immédiate, `Ctrl+M` bascule micro, `Entrée` valider,
 *   `Shift+Entrée` saut de ligne, `Échap` fermer.
 */

import { Notice } from "obsidian";
import { AnchorRect, setGreenSelectionHighlight } from "./contextExtractor";
import { ReviewComment } from "./reviewStore";
import { VoiceDictationService } from "./voiceDictation";

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
}

export interface CommentModalCallbacks {
	onSubmit: (commentText: string, editingId?: string) => Promise<void>;
	onDeleteExisting: (commentId: string) => Promise<void>;
	onClose: () => void;
}

export class CommentOverlayModal {
	private parentEl: HTMLElement;
	private voiceService: VoiceDictationService;
	private callbacks: CommentModalCallbacks;

	private cardEl: HTMLElement | null = null;
	private textareaEl: HTMLTextAreaElement | null = null;
	private micBtnEl: HTMLButtonElement | null = null;
	private submitBtnEl: HTMLButtonElement | null = null;
	private voiceFeedbackEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private levelFillEl: HTMLElement | null = null;
	private existingListEl: HTMLElement | null = null;

	private isOpenFlag: boolean = false;
	private isBusyTranscribing: boolean = false;
	private editingId: string | null = null;
	private recStartTime: number = 0;
	private recTimerId: number | null = null;
	private boundKeyHandler: (evt: KeyboardEvent) => void;
	private boundOutsideClickHandler: (evt: MouseEvent) => void;

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
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	public open(ctx: CommentModalContext): void {
		this.close(false);
		this.isOpenFlag = true;
		this.isBusyTranscribing = false;
		this.editingId = ctx.editingComment ? ctx.editingComment.id : null;

		if (ctx.highlightRange) {
			setGreenSelectionHighlight(ctx.highlightRange);
		}

		const isSelectionAnchored = Boolean(ctx.anchorRect);
		this.cardEl = this.parentEl.createDiv({
			cls: `slideflow-comment-card ${isSelectionAnchored ? "is-selection-anchored" : "is-left-docked"}`,
		});
		this.cardEl.addEventListener("click", (evt) => evt.stopPropagation());
		this.cardEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

		// Subtle 1-line scope header (no emojis, ultra clean)
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
				placeholder: "Leave a comment",
			},
		});
		if (ctx.editingComment) {
			this.textareaEl.value = ctx.editingComment.commentText;
		}
		this.textareaEl.addEventListener("input", () => this.autoResizeTextarea());

		// Live voice feedback bar (hidden unless recording, transcribing, or error)
		this.voiceFeedbackEl = this.cardEl.createDiv({ cls: "slideflow-comment-voice-feedback" });
		this.voiceFeedbackEl.style.display = "none";
		this.statusEl = this.voiceFeedbackEl.createDiv({ cls: "slideflow-comment-status" });
		const meterTrack = this.voiceFeedbackEl.createDiv({ cls: "slideflow-voice-meter-track" });
		this.levelFillEl = meterTrack.createDiv({ cls: "slideflow-voice-meter-fill" });

		// Minimal footer: Cancel | Mic icon | Add Comment pill
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

		this.micBtnEl = rightActions.createEl("button", {
			cls: "slideflow-comment-mic-btn",
			attr: {
				type: "button",
				title: "Voice dictation (Ctrl+M)",
				"aria-label": "Toggle voice dictation (Ctrl+M)",
			},
		});
		this.micBtnEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
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
		if (ctx.anchorRect) {
			this.positionNearAnchor(ctx.anchorRect);
		}

		window.addEventListener("keydown", this.boundKeyHandler, true);
		window.setTimeout(() => {
			window.addEventListener("mousedown", this.boundOutsideClickHandler, true);
		}, 0);

		requestAnimationFrame(() => {
			this.autoResizeTextarea();
			this.textareaEl?.focus();
			if (this.textareaEl && this.editingId) {
				const len = this.textareaEl.value.length;
				this.textareaEl.setSelectionRange(len, len);
			}
			if (ctx.startWithVoice) {
				void this.startVoiceDictation();
			}
		});
	}

	private positionNearAnchor(rect: AnchorRect): void {
		if (!this.cardEl) return;
		const cardWidth = 370;
		const estimatedHeight = 160;
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
		// Allow scrolling or reading without accidentally losing typed text if non-empty
		const hasDraft = Boolean(this.textareaEl?.value.trim()) || this.voiceService.isRecording();
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
			row.createSpan({ cls: "slideflow-existing-comment-text", text: c.commentText });

			const btns = row.createDiv({ cls: "slideflow-existing-comment-btns" });
			const editBtn = btns.createEl("button", {
				cls: "slideflow-mini-text-btn",
				text: "Edit",
				attr: { type: "button" },
			});
			editBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.editingId = c.id;
				if (this.textareaEl) {
					this.textareaEl.value = c.commentText;
					this.autoResizeTextarea();
					this.textareaEl.focus();
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

		if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "m") {
			evt.preventDefault();
			evt.stopPropagation();
			void this.toggleVoiceDictation();
			return;
		}

		if (evt.key === "Escape" || evt.code === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close(true);
			return;
		}

		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			evt.stopPropagation();
			void this.handleSubmit();
			return;
		}

		evt.stopPropagation();
	}

	private setStatus(msg: string, mode: "hidden" | "idle" | "recording" | "busy" | "error" = "idle"): void {
		if (!this.voiceFeedbackEl || !this.statusEl) return;
		if (mode === "hidden" || !msg) {
			this.voiceFeedbackEl.style.display = "none";
			return;
		}
		this.voiceFeedbackEl.style.display = "flex";
		this.statusEl.setText(msg);
		this.statusEl.removeClass("is-recording", "is-busy", "is-error");
		if (mode === "recording") this.statusEl.addClass("is-recording");
		if (mode === "busy") this.statusEl.addClass("is-busy");
		if (mode === "error") this.statusEl.addClass("is-error");
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
		if (this.voiceService.isRecording()) {
			await this.stopVoiceAndAppend();
		} else {
			await this.startVoiceDictation();
		}
	}

	private async startVoiceDictation(): Promise<void> {
		if (this.isBusyTranscribing || this.voiceService.isRecording()) return;
		try {
			await this.voiceService.startRecording((level) => {
				if (this.levelFillEl) {
					this.levelFillEl.style.width = `${Math.round(level * 100)}%`;
				}
			});
			this.recStartTime = Date.now();
			this.micBtnEl?.addClass("is-recording");
			const updateElapsed = () => {
				const secs = Math.floor((Date.now() - this.recStartTime) / 1000);
				const mm = Math.floor(secs / 60);
				const ss = String(secs % 60).padStart(2, "0");
				this.setStatus(`Listening ${mm}:${ss} · Ctrl+M stop · Enter save`, "recording");
			};
			updateElapsed();
			this.recTimerId = window.setInterval(updateElapsed, 250);
		} catch (err: any) {
			const msg = err?.message || String(err);
			this.setStatus(`Mic error: ${msg}`, "error");
			new Notice(`SlideFlow mic: ${msg}`);
		}
	}

	private async stopVoiceAndAppend(): Promise<string> {
		this.stopRecTimer();
		this.micBtnEl?.removeClass("is-recording");
		this.isBusyTranscribing = true;
		if (this.submitBtnEl) this.submitBtnEl.disabled = true;

		try {
			const res = await this.voiceService.stopAndTranscribe((statusMsg) => {
				this.setStatus(statusMsg, "busy");
			});

			const text = (res.text || "").trim();
			if (text && this.textareaEl) {
				const existing = this.textareaEl.value;
				const sep = existing.trim().length > 0 && !existing.endsWith(" ") && !existing.endsWith("\n") ? " " : "";
				this.textareaEl.value = `${existing}${sep}${text}`;
				this.autoResizeTextarea();
				this.textareaEl.focus();
				const len = this.textareaEl.value.length;
				this.textareaEl.setSelectionRange(len, len);
				this.setStatus("", "hidden");
			} else {
				this.setStatus("No speech detected. Press Ctrl+M to retry.", "idle");
			}
			return text;
		} catch (err: any) {
			const msg = err?.message || String(err);
			this.setStatus(`Whisper error: ${msg}`, "error");
			new Notice(`SlideFlow Whisper: ${msg}`);
			return "";
		} finally {
			this.isBusyTranscribing = false;
			if (this.submitBtnEl) this.submitBtnEl.disabled = false;
		}
	}

	private async handleSubmit(): Promise<void> {
		if (this.isBusyTranscribing) return;

		if (this.voiceService.isRecording()) {
			await this.stopVoiceAndAppend();
		}

		const text = (this.textareaEl?.value || "").trim();
		if (!text) {
			this.setStatus("Comment is empty.", "error");
			this.textareaEl?.focus();
			return;
		}

		const editId = this.editingId || undefined;
		this.close(false);
		await this.callbacks.onSubmit(text, editId);
	}

	public close(invokeOnCloseCallback: boolean = true): void {
		if (!this.isOpenFlag && !this.cardEl) return;
		this.isOpenFlag = false;
		this.stopRecTimer();
		setGreenSelectionHighlight(null);
		if (this.voiceService.isRecording()) {
			this.voiceService.cancelRecording();
		}
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		window.removeEventListener("mousedown", this.boundOutsideClickHandler, true);
		if (this.cardEl) {
			this.cardEl.remove();
			this.cardEl = null;
		}
		this.textareaEl = null;
		this.micBtnEl = null;
		this.submitBtnEl = null;
		this.voiceFeedbackEl = null;
		this.statusEl = null;
		this.levelFillEl = null;
		this.existingListEl = null;
		this.editingId = null;

		if (invokeOnCloseCallback) {
			this.callbacks.onClose();
		}
	}
}
