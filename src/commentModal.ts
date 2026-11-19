/**
 * CommentOverlayModal — Modale flottante clavier/vocal intégrée dans l'overlay plein écran SlideFlow.
 *
 * Raccourcis exigés par Henri :
 * - `C` ouvre en mode saisie texte (textarea focalisé)
 * - `V` ouvre directement avec le mode dictée vocale activé
 * - `Ctrl+M` (ou clic 🎤) bascule la dictée vocale ON/OFF dans la modale
 * - `Entrée` enregistre le commentaire (si dictée en cours : arrête, transcrit et enregistre)
 * - `Shift+Entrée` insère un saut de ligne
 * - `Échap` annule la dictée en cours et ferme la modale
 */

import { Notice } from "obsidian";
import { ReviewComment } from "./reviewStore";
import { VoiceDictationService } from "./voiceDictation";

export interface CommentModalContext {
	noteTitle: string;
	notePath: string;
	sectionHeading: string;
	hadDiff: boolean;
	existingComments: ReviewComment[];
	startWithVoice: boolean;
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

	private backdropEl: HTMLElement | null = null;
	private textareaEl: HTMLTextAreaElement | null = null;
	private micBtnEl: HTMLButtonElement | null = null;
	private submitBtnEl: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private levelFillEl: HTMLElement | null = null;
	private existingListEl: HTMLElement | null = null;

	private isOpenFlag: boolean = false;
	private isBusyTranscribing: boolean = false;
	private editingId: string | null = null;
	private recStartTime: number = 0;
	private recTimerId: number | null = null;
	private boundKeyHandler: (evt: KeyboardEvent) => void;

	constructor(
		parentEl: HTMLElement,
		voiceService: VoiceDictationService,
		callbacks: CommentModalCallbacks
	) {
		this.parentEl = parentEl;
		this.voiceService = voiceService;
		this.callbacks = callbacks;
		this.boundKeyHandler = this.handleKeyDown.bind(this);
	}

	public isOpen(): boolean {
		return this.isOpenFlag;
	}

	public open(ctx: CommentModalContext): void {
		this.close(false);
		this.isOpenFlag = true;
		this.isBusyTranscribing = false;
		this.editingId = ctx.editingComment ? ctx.editingComment.id : null;

		this.backdropEl = this.parentEl.createDiv({ cls: "slideflow-comment-backdrop" });
		this.backdropEl.addEventListener("click", (evt) => {
			if (evt.target === this.backdropEl) {
				evt.stopPropagation();
				this.close(true);
			}
		});

		const cardEl = this.backdropEl.createDiv({ cls: "slideflow-comment-card" });
		cardEl.addEventListener("click", (evt) => evt.stopPropagation());

		// Header context bar
		const headerEl = cardEl.createDiv({ cls: "slideflow-comment-header" });
		const titleSpan = headerEl.createDiv({ cls: "slideflow-comment-context" });
		titleSpan.setText(`📄 ${ctx.noteTitle} · ${ctx.sectionHeading}`);

		if (ctx.hadDiff) {
			const diffBadge = headerEl.createSpan({
				cls: "slideflow-comment-diff-pill",
				text: "🟢 Diff actif (ancien + nouveau texte joints)",
			});
			diffBadge.setAttribute(
				"title",
				"L'ancien texte avant diff et le nouveau texte actuel seront tous les deux envoyés à Antigravity."
			);
		}

		// Existing comments on this slide (if any)
		this.existingListEl = cardEl.createDiv({ cls: "slideflow-comment-existing-list" });
		this.renderExistingComments(ctx.existingComments);

		// Main textarea
		this.textareaEl = cardEl.createEl("textarea", {
			cls: "slideflow-comment-textarea",
			attr: {
				rows: "4",
				placeholder: "Écrivez votre commentaire… (Ctrl+M pour dicter au micro, Entrée pour enregistrer)",
			},
		});
		if (ctx.editingComment) {
			this.textareaEl.value = ctx.editingComment.commentText;
		}

		// Live voice status + RMS level bar
		const voiceBarEl = cardEl.createDiv({ cls: "slideflow-comment-voice-bar" });
		this.statusEl = voiceBarEl.createDiv({
			cls: "slideflow-comment-status",
			text: "Ctrl+M : micro · Entrée : enregistrer · Shift+Entrée : saut de ligne · Échap : fermer",
		});
		const meterTrack = voiceBarEl.createDiv({ cls: "slideflow-voice-meter-track" });
		this.levelFillEl = meterTrack.createDiv({ cls: "slideflow-voice-meter-fill" });

		// Footer actions (modeled directly on Antigravity's clean comment card)
		const footerEl = cardEl.createDiv({ cls: "slideflow-comment-footer" });

		const cancelBtn = footerEl.createEl("button", {
			cls: "slideflow-comment-cancel-btn",
			text: "Cancel",
		});
		cancelBtn.type = "button";
		cancelBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.close(true);
		});

		const rightActions = footerEl.createDiv({ cls: "slideflow-comment-right-actions" });

		this.micBtnEl = rightActions.createEl("button", {
			cls: "slideflow-comment-mic-btn",
			attr: {
				type: "button",
				title: "Dictée vocale Faster-Whisper GPU (Ctrl+M)",
				"aria-label": "Basculer la dictée vocale (Ctrl+M)",
			},
		});
		this.micBtnEl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
		this.micBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.toggleVoiceDictation();
		});

		this.submitBtnEl = rightActions.createEl("button", {
			cls: "slideflow-comment-submit-btn",
			text: this.editingId ? "Update Comment" : "Add Comment",
			attr: { type: "button" },
		});
		this.submitBtnEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.handleSubmit();
		});

		window.addEventListener("keydown", this.boundKeyHandler, true);

		requestAnimationFrame(() => {
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
			row.createSpan({ cls: "slideflow-existing-comment-text", text: `💬 ${c.commentText}` });

			const btns = row.createDiv({ cls: "slideflow-existing-comment-btns" });
			const editBtn = btns.createEl("button", {
				cls: "slideflow-mini-icon-btn",
				text: "✏️",
				attr: { type: "button", title: "Modifier ce commentaire" },
			});
			editBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.editingId = c.id;
				if (this.textareaEl) {
					this.textareaEl.value = c.commentText;
					this.textareaEl.focus();
				}
				if (this.submitBtnEl) {
					this.submitBtnEl.setText("Update Comment");
				}
			});

			const delBtn = btns.createEl("button", {
				cls: "slideflow-mini-icon-btn danger",
				text: "🗑️",
				attr: { type: "button", title: "Supprimer ce commentaire" },
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

		// Ctrl+M (or Cmd+M): toggle voice dictation
		if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "m") {
			evt.preventDefault();
			evt.stopPropagation();
			void this.toggleVoiceDictation();
			return;
		}

		// Escape: cancel recording & close modal
		if (evt.key === "Escape" || evt.code === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close(true);
			return;
		}

		// Enter (without Shift): submit comment (stopping & transcribing first if recording!)
		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			evt.stopPropagation();
			void this.handleSubmit();
			return;
		}

		// Block propagation to Obsidian/SlideFlow global shortcuts while typing in modal
		evt.stopPropagation();
	}

	private setStatus(msg: string, mode: "idle" | "recording" | "busy" | "error" = "idle"): void {
		if (!this.statusEl) return;
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
				this.setStatus(
					`🔴 Dictée en cours (${mm}:${ss}) — Ctrl+M pour arrêter & éditer · Entrée pour transcrire & valider`,
					"recording"
				);
			};
			updateElapsed();
			this.recTimerId = window.setInterval(updateElapsed, 250);
		} catch (err: any) {
			const msg = err?.message || String(err);
			this.setStatus(`❌ Erreur micro : ${msg}`, "error");
			new Notice(`SlideFlow micro : ${msg}`);
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
				this.textareaEl.focus();
				const len = this.textareaEl.value.length;
				this.textareaEl.setSelectionRange(len, len);
				this.setStatus(
					`✅ Transcrit (${res.duration_s}s → ${res.inference_s}s GPU) · Entrée pour enregistrer ou Ctrl+M pour continuer`,
					"idle"
				);
			} else {
				this.setStatus("⚠️ Aucune parole détectée — réessayez avec Ctrl+M ou saisissez au clavier.", "idle");
			}
			return text;
		} catch (err: any) {
			const msg = err?.message || String(err);
			this.setStatus(`❌ Erreur Whisper : ${msg}`, "error");
			new Notice(`SlideFlow Whisper : ${msg}`);
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
			this.setStatus("⚠️ Commentaire vide — écrivez ou dictez avant de valider.", "error");
			this.textareaEl?.focus();
			return;
		}

		const editId = this.editingId || undefined;
		this.close(false);
		await this.callbacks.onSubmit(text, editId);
	}

	public close(invokeOnCloseCallback: boolean = true): void {
		if (!this.isOpenFlag && !this.backdropEl) return;
		this.isOpenFlag = false;
		this.stopRecTimer();
		if (this.voiceService.isRecording()) {
			this.voiceService.cancelRecording();
		}
		window.removeEventListener("keydown", this.boundKeyHandler, true);
		if (this.backdropEl) {
			this.backdropEl.remove();
			this.backdropEl = null;
		}
		this.textareaEl = null;
		this.micBtnEl = null;
		this.submitBtnEl = null;
		this.statusEl = null;
		this.levelFillEl = null;
		this.existingListEl = null;
		this.editingId = null;

		if (invokeOnCloseCallback) {
			this.callbacks.onClose();
		}
	}
}
