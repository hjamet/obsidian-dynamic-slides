import { Plugin, Notice, MarkdownView, PluginSettingTab, Setting, App, TFile } from "obsidian";
import { parseMarkdownSections, findCurrentSectionNode, SectionNode } from "./parser";
import { PresentationModal, SlideRenderDecoration } from "./modal";
import { KeyboardNavigator } from "./keyboard";
import { TOCComponent, TOCVisualMeta } from "./toc";
import {
	buildNoteDiffContext,
	DEFAULT_BLOCK_DIFF_THRESHOLD,
	NoteDiffContext,
	SlideDiffInfo,
} from "./diffEngine";
import { BaselinesStore, normalizeVaultPath } from "./baselinesStore";
import { ReviewComment, ReviewStore } from "./reviewStore";
import { VoiceDictationService } from "./voiceDictation";
import { CommentOverlayModal } from "./commentModal";
import { ReviewDrawer } from "./reviewDrawer";

export interface SlideFlowSettings {
	transitionDuration: number; // in seconds
	scrollDuration: number;
	zoomLevel: number; // 0.7 to 2.0 (1.0 = 100%)
	blockDiffThreshold: number; // 0.1 to 0.8 (default 0.25 = 25%)
	autoMarkReadDelayMs: number; // default 1000 ms (1 second)
	whisperServerUrl: string;
	autoStartWhisperServer: boolean;
	whisperPythonPath: string;
	whisperScriptPath: string;
	whisperModel: string;
	whisperDevice: string;
	whisperComputeType: string;
	whisperLanguage: string;
}

export interface DocumentStackFrame {
	filePath: string;
	fileTitle: string;
	currentNode: SectionNode;
	flatNodes: SectionNode[];
	rootNode: SectionNode;
	diffContext: NoteDiffContext | null;
	diffEnabled: boolean;
	seenInSession: Set<string>;
}

export const DEFAULT_SETTINGS: SlideFlowSettings = {
	transitionDuration: 0.65,
	scrollDuration: 1.0,
	zoomLevel: 1.0,
	blockDiffThreshold: DEFAULT_BLOCK_DIFF_THRESHOLD,
	autoMarkReadDelayMs: 1000,
	whisperServerUrl: "http://127.0.0.1:3056",
	autoStartWhisperServer: true,
	whisperPythonPath: "python",
	whisperScriptPath: "_agents/scripts-for-skills/whisper_dictation_server.py",
	whisperModel: "medium",
	whisperDevice: "cuda",
	whisperComputeType: "float16",
	whisperLanguage: "fr",
};

export function computeDirection(
	oldNode: SectionNode | null,
	newNode: SectionNode
): 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump' {
	if (!oldNode || oldNode.id === newNode.id) {
		return 'jump';
	}
	if (newNode.level > oldNode.level) {
		return 'zoom-in';
	}
	if (newNode.level < oldNode.level) {
		return 'zoom-out';
	}
	if ((newNode.flatIndex ?? 0) > (oldNode.flatIndex ?? 0)) {
		return 'next';
	}
	return 'prev';
}

export default class SlideFlowPlugin extends Plugin {
	settings: SlideFlowSettings = { ...DEFAULT_SETTINGS };
	private activeModal: PresentationModal | null = null;
	private keyboardNav: KeyboardNavigator | null = null;
	private tocComp: TOCComponent | null = null;
	private commentModal: CommentOverlayModal | null = null;
	private reviewDrawer: ReviewDrawer | null = null;

	private baselinesStore!: BaselinesStore;
	private reviewStore!: ReviewStore;
	private voiceService!: VoiceDictationService;

	private rootNode: SectionNode | null = null;
	private flatNodes: SectionNode[] = [];
	private currentNode: SectionNode | null = null;
	private activeSourcePath: string = "";
	private sessionRootProjectPath: string = "";
	private documentStack: DocumentStackFrame[] = [];

	private activeDiffContext: NoteDiffContext | null = null;
	private diffEnabled: boolean = false;
	private seenInSession: Set<string> = new Set();
	private slideReadTimerId: number | null = null;

	async onload() {
		console.log("Loading SlideFlow plugin");
		await this.loadSettings();

		this.baselinesStore = new BaselinesStore(this.app);
		this.reviewStore = new ReviewStore(
			this.app,
			this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`
		);
		this.voiceService = new VoiceDictationService(this.app, () => ({
			serverUrl: this.settings.whisperServerUrl,
			autoStartServer: this.settings.autoStartWhisperServer,
			pythonPath: this.settings.whisperPythonPath,
			scriptPath: this.settings.whisperScriptPath,
			whisperModel: this.settings.whisperModel,
			whisperDevice: this.settings.whisperDevice,
			whisperComputeType: this.settings.whisperComputeType,
			language: this.settings.whisperLanguage,
		}));

		this.addSettingTab(new SlideFlowSettingTab(this.app, this));

		this.addRibbonIcon("presentation", "SlideFlow", () => {
			void this.startPresentation();
		});

		this.addCommand({
			id: "start-dynamic-slides",
			name: "SlideFlow: Open slide presentation & review cockpit",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "p" }],
			callback: () => {
				void this.startPresentation();
			}
		});

		this.addCommand({
			id: "copy-slideflow-oneshot",
			name: "SlideFlow: Copy pending review comments for /one-shot",
			callback: () => {
				void this.copyPendingCommentsExport(true, false);
			}
		});
	}

	onunload() {
		this.closePresentation();
		console.log("Unloading SlideFlow plugin");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private clearSlideReadTimer() {
		if (this.slideReadTimerId !== null) {
			window.clearTimeout(this.slideReadTimerId);
			this.slideReadTimerId = null;
		}
	}

	private async computeDiffForLoadedNote(
		filePath: string,
		markdownText: string,
		flatNodes: SectionNode[]
	): Promise<{ ctx: NoteDiffContext | null; autoEnable: boolean }> {
		const normPath = normalizeVaultPath(filePath);
		const entry = this.baselinesStore.getNoteEntry(normPath);
		if (!entry) {
			return { ctx: null, autoEnable: false };
		}

		const ctx = buildNoteDiffContext(
			normPath,
			entry.baseline,
			markdownText,
			flatNodes,
			entry.seenSlides || {},
			this.settings.blockDiffThreshold
		);

		if (ctx.totalDirtySlides === 0 && !ctx.deletedSectionsMarkdown) {
			// All slides already seen or content reverted to baseline -> purge entry to 0 bytes
			await this.baselinesStore.markEntireNoteRead(normPath);
			return { ctx: null, autoEnable: false };
		}

		return { ctx, autoEnable: true };
	}

	private getDirtyNodeIdSet(): Set<string> {
		const set = new Set<string>();
		if (!this.activeDiffContext) return set;
		for (const [nodeId, info] of this.activeDiffContext.slideDiffs.entries()) {
			if (info.hasChanges) set.add(nodeId);
		}
		return set;
	}

	private getCommentCountByHeadingForActiveNote(): Map<string, number> {
		const map = new Map<string, number>();
		for (const c of this.reviewStore.getAll()) {
			if (c.notePath === this.activeSourcePath) {
				map.set(c.sectionHeading, (map.get(c.sectionHeading) || 0) + 1);
			}
		}
		return map;
	}

	private buildTOCVisualMeta(): TOCVisualMeta {
		return {
			dirtyNodeIds: this.getDirtyNodeIdSet(),
			descendantDirtyNodeIds: this.activeDiffContext?.descendantDirtyNodeIds,
			commentCountByHeading: this.getCommentCountByHeadingForActiveNote(),
		};
	}

	private resolveLinkTargetFile(linkpath: string, sourcePath: string): TFile | null {
		let decoded = linkpath;
		try {
			decoded = decodeURIComponent(linkpath);
		} catch {
			decoded = linkpath;
		}
		const cleanPath = decoded.split('#')[0].split('^')[0].trim();
		if (!cleanPath) return null;

		let targetFile = this.app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
		if (!targetFile) {
			targetFile = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
		}
		if (!targetFile) {
			const direct = this.app.vault.getAbstractFileByPath(cleanPath);
			if (direct instanceof TFile) targetFile = direct;
		}
		if (!targetFile) {
			const cleanLower = cleanPath.toLowerCase();
			const noExt = cleanLower.replace(/\.md$/, "");
			const allFiles = this.app.vault.getMarkdownFiles();
			targetFile =
				allFiles.find(
					(f) =>
						f.path.toLowerCase() === cleanLower ||
						f.basename.toLowerCase() === noExt ||
						f.name.toLowerCase() === cleanLower
				) || null;
		}
		return targetFile instanceof TFile ? targetFile : null;
	}

	private isLinkTargetModified = (href: string): boolean => {
		if (!href || href.startsWith("#")) return false;
		const targetFile = this.resolveLinkTargetFile(href, this.activeSourcePath);
		if (!targetFile) return false;
		return this.baselinesStore.hasUnreadBaseline(targetFile.path);
	};

	private buildSlideRenderDecoration(node: SectionNode): SlideRenderDecoration {
		let overrideMarkdown: string | undefined = undefined;
		const slideDiff = this.activeDiffContext?.slideDiffs.get(node.id);
		const firstHeadingId = this.flatNodes.length > 1 ? this.flatNodes[1].id : this.flatNodes[0]?.id;

		if (this.diffEnabled && this.activeDiffContext) {
			const parts: string[] = [];
			if (slideDiff && slideDiff.hasChanges) {
				parts.push(slideDiff.diffMarkdown);
			} else {
				parts.push(node.rawOwnMarkdown);
			}
			if (node.childHeadingsHtml) {
				parts.push(node.childHeadingsHtml);
			}
			if (node.id === firstHeadingId && this.activeDiffContext.deletedSectionsMarkdown) {
				parts.push(this.activeDiffContext.deletedSectionsMarkdown);
			}
			overrideMarkdown = parts.join("\n\n");
		}

		return {
			overrideMarkdown,
			dirtyNodeIds: this.getDirtyNodeIdSet(),
			descendantDirtyNodeIds: this.activeDiffContext?.descendantDirtyNodeIds,
			isLinkModified: this.isLinkTargetModified,
		};
	}

	private updateCockpitUI() {
		if (!this.activeModal || !this.currentNode) return;
		const slideDiff = this.activeDiffContext?.slideDiffs.get(this.currentNode.id);
		const currentSlideComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);
		this.activeModal.updateCockpitBar({
			hasNoteDiff: Boolean(
				this.activeDiffContext &&
					(this.activeDiffContext.totalDirtySlides > 0 ||
						this.activeDiffContext.deletedSectionsMarkdown)
			),
			diffEnabled: this.diffEnabled,
			dirtySlidesCount: this.activeDiffContext?.totalDirtySlides || 0,
			currentSlideHasDiff: Boolean(slideDiff?.hasChanges),
			currentSlideCommentsCount: currentSlideComments.length,
			totalPendingCommentsCount: this.reviewStore.getCount(),
		});
	}

	/**
	 * Planifie le marquage comme vu d'une slide après > 1s de consultation (pour la PROCHAINE ouverture).
	 * Le diff reste visible durant la session en cours et l'ancien texte reste disponible pour les commentaires !
	 */
	private scheduleSlideSeenTimer(node: SectionNode) {
		this.clearSlideReadTimer();
		const ctx = this.activeDiffContext;
		if (!ctx) return;

		const slideDiff = ctx.slideDiffs.get(node.id);
		if (!slideDiff) return;

		const firstHeadingId = this.flatNodes.length > 1 ? this.flatNodes[1].id : this.flatNodes[0]?.id;
		const hasDeletedHere = Boolean(node.id === firstHeadingId && ctx.deletedSectionsHash);

		if (!slideDiff.hasChanges && !hasDeletedHere) return;
		if (this.seenInSession.has(slideDiff.slideKey) && !hasDeletedHere) return;

		const targetNotePath = this.activeSourcePath;
		const targetSlideId = node.id;
		const delayMs = Math.max(250, this.settings.autoMarkReadDelayMs || 1000);

		this.slideReadTimerId = window.setTimeout(() => {
			this.slideReadTimerId = null;
			// Vérifier que l'utilisateur est toujours sur la même note et la même slide
			if (
				!this.activeModal ||
				this.activeSourcePath !== targetNotePath ||
				this.currentNode?.id !== targetSlideId
			) {
				return;
			}
			this.seenInSession.add(slideDiff.slideKey);
			void this.baselinesStore.markSlideSeen(
				targetNotePath,
				slideDiff.slideKey,
				slideDiff.rawNewMarkdown,
				ctx.dirtySlideKeys,
				ctx.currentHashesByKey,
				hasDeletedHere ? ctx.deletedSectionsHash : null
			);
		}, delayMs);
	}

	private async startPresentation() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Aucune note Markdown active pour SlideFlow.");
			return;
		}

		const file = view.file;
		if (!file) {
			new Notice("Fichier introuvable.");
			return;
		}

		const markdownText = view.editor.getValue();
		if (!markdownText.trim()) {
			new Notice("Note vide : impossible de démarrer SlideFlow.");
			return;
		}

		// Recharger les baselines (Solution B) et les commentaires en attente
		await Promise.all([
			this.baselinesStore.reload().catch((err) => {
				console.error("[SlideFlow] Erreur lecture unread_baselines.json:", err);
				new Notice(`SlideFlow: erreur lecture baselines (${err.message})`);
			}),
			this.reviewStore.load().catch((err) => {
				console.error("[SlideFlow] Erreur lecture pending_reviews.json:", err);
			}),
		]);

		// Préchauffer le serveur Faster-Whisper GPU silencieusement en arrière-plan
		void this.voiceService.prewarmServer();

		this.documentStack = [];
		this.activeSourcePath = file.path;
		this.sessionRootProjectPath = file.path;
		this.seenInSession = new Set();

		const cache = this.app.metadataCache.getFileCache(file);
		const parsed = parseMarkdownSections(markdownText, cache?.headings);

		if (parsed.error === "no_headings") {
			new Notice("Note sans titres H1–H6 : présentation en slide unique.");
		}

		this.rootNode = parsed.root;
		this.flatNodes = parsed.flatNodes;
		const cursorLine = view.editor.getCursor().line;
		this.currentNode = findCurrentSectionNode(this.flatNodes, cursorLine);
		if (this.currentNode && this.currentNode.level === 0 && this.flatNodes.length > 1) {
			this.currentNode = this.flatNodes[1];
		}

		const diffInit = await this.computeDiffForLoadedNote(file.path, markdownText, this.flatNodes);
		this.activeDiffContext = diffInit.ctx;
		this.diffEnabled = diffInit.autoEnable;

		this.activeModal = new PresentationModal(
			this.app,
			() => {
				this.cleanupNavigation();
				void this.jumpToCurrentSlideInEditor();
			},
			this.settings.transitionDuration,
			this.settings.scrollDuration * 1000,
			this.settings.zoomLevel || 1.0
		);
		this.activeModal.setScrollDuration(this.settings.scrollDuration * 1000);

		this.activeModal.onZoomChangeCallback = (newZoom: number) => {
			this.settings.zoomLevel = newZoom;
			void this.saveSettings();
		};
		this.activeModal.setBreadcrumb(file.basename);
		this.activeModal.setReturnButton(null);
		this.activeModal.onReturnClickCallback = () => {
			void this.popDocumentStack();
		};
		this.activeModal.onLinkClickCallback = (href: string) => {
			void this.handleInternalLinkClick(href);
		};
		this.activeModal.onChildHeadingClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode) {
				this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onSectionClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode) {
				this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onToggleDiffClickCallback = () => this.toggleDiffMode();
		this.activeModal.onCommentTextClickCallback = () => this.openCommentModal(false);
		this.activeModal.onCommentVoiceClickCallback = () => this.openCommentModal(true);
		this.activeModal.onOpenQueueClickCallback = () => this.toggleReviewDrawer();
		this.activeModal.onCopyOneShotClickCallback = () => void this.copyPendingCommentsExport(true, false);

		// Monter CommentOverlayModal et ReviewDrawer DANS overlayEl pour le plein écran
		const overlayEl = this.activeModal.getOverlayElement();
		this.commentModal = new CommentOverlayModal(overlayEl, this.voiceService, {
			onSubmit: async (commentText: string, editingId?: string) => {
				await this.saveSlideComment(commentText, editingId);
			},
			onDeleteExisting: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.updateCockpitUI();
				if (this.tocComp && this.currentNode) {
					this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
				}
			},
			onClose: () => {
				// Return keyboard focus cleanly to presentation
			},
		});

		this.reviewDrawer = new ReviewDrawer(overlayEl, {
			onJumpToComment: (comment: ReviewComment) => {
				void this.jumpToCommentTarget(comment);
			},
			onDeleteComment: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.updateCockpitUI();
				if (this.tocComp && this.currentNode) {
					this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
				}
			},
			onCopyExport: async (includeOneShotPrefix: boolean, clearAfter: boolean) => {
				await this.copyPendingCommentsExport(includeOneShotPrefix, clearAfter);
			},
			onClearAll: async () => {
				const count = await this.reviewStore.clearAll(true);
				this.updateCockpitUI();
				if (this.tocComp && this.currentNode) {
					this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
				}
				new Notice(`🗑️ File vidée (${count} commentaire(s) archivé(s) localement).`);
			},
			onClose: () => {
				// no-op
			},
		});

		await this.activeModal.open(
			this.currentNode,
			this.activeSourcePath,
			this.buildSlideRenderDecoration(this.currentNode)
		);

		this.tocComp = new TOCComponent(overlayEl, (selectedNode) => {
			this.goToNode(selectedNode);
		});
		this.activeModal.setTOC(this.tocComp);
		this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());

		this.updateSlideCounter();
		this.updateCockpitUI();
		this.scheduleSlideSeenTimer(this.currentNode);

		this.keyboardNav = new KeyboardNavigator({
			onNext: () => this.handleNextNavigation(),
			onPrev: () => this.handlePrevNavigation(),
			onFastNext: () => this.fastJumpNext(),
			onFastPrev: () => this.fastJumpPrev(),
			onEscape: () => this.handleEscapeKey(),
			onZoomIn: () => this.activeModal?.zoomIn(),
			onZoomOut: () => this.activeModal?.zoomOut(),
			onZoomReset: () => this.activeModal?.resetZoom(),
			onResetZoom: () => this.activeModal?.resetZoom(),
			onOpenCommentText: () => this.openCommentModal(false),
			onOpenCommentVoice: () => this.openCommentModal(true),
			onToggleDiff: () => this.toggleDiffMode(),
			onNextDiffSlide: () => this.jumpToNextDiffSlide(),
			onToggleReviewDrawer: () => this.toggleReviewDrawer(),
			onCopyOneShot: () => void this.copyPendingCommentsExport(true, false),
			isInputBlocked: () =>
				Boolean(this.commentModal?.isOpen() || this.reviewDrawer?.isOpen()),
		});
		this.keyboardNav.attach();
	}

	private handleEscapeKey() {
		if (this.activeModal?.isMediaZoomActive()) {
			this.activeModal.closeMediaZoom(true);
			return;
		}
		if (this.documentStack.length > 0) {
			void this.popDocumentStack();
			return;
		}
		this.closePresentation();
	}

	private toggleDiffMode() {
		if (
			!this.activeDiffContext ||
			(this.activeDiffContext.totalDirtySlides === 0 &&
				!this.activeDiffContext.deletedSectionsMarkdown)
		) {
			new Notice("Aucun diff non lu sur cette note.");
			return;
		}
		this.diffEnabled = !this.diffEnabled;
		if (this.activeModal && this.currentNode) {
			void this.activeModal.updateSlide(
				this.currentNode,
				this.activeSourcePath,
				'jump',
				'start',
				this.buildSlideRenderDecoration(this.currentNode)
			);
		}
		this.updateCockpitUI();
		new Notice(this.diffEnabled ? "🟢 Mode Diff activé" : "Mode Diff masqué");
	}

	private jumpToNextDiffSlide() {
		if (!this.activeDiffContext || this.activeDiffContext.totalDirtySlides === 0) {
			new Notice("Aucune slide modifiée dans cette note.");
			return;
		}
		const dirtyIds = this.getDirtyNodeIdSet();
		const currIdx = this.flatNodes.findIndex((n) => n.id === this.currentNode?.id);
		for (let offset = 1; offset <= this.flatNodes.length; offset++) {
			const idx = (currIdx + offset) % this.flatNodes.length;
			const cand = this.flatNodes[idx];
			if (dirtyIds.has(cand.id)) {
				this.goToNode(cand, 'jump', 'start');
				return;
			}
		}
	}

	private openCommentModal(startWithVoice: boolean) {
		if (!this.commentModal || !this.currentNode) return;
		const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
		const noteTitle =
			currentFile instanceof TFile
				? currentFile.basename
				: this.activeSourcePath.split("/").pop()?.replace(/\.md$/, "") || "Note";

		const slideDiff = this.activeDiffContext?.slideDiffs.get(this.currentNode.id);
		const existingComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);

		this.commentModal.open({
			noteTitle,
			notePath: this.activeSourcePath,
			sectionHeading: this.currentNode.title,
			hadDiff: Boolean(slideDiff?.hasChanges),
			existingComments,
			startWithVoice,
		});
	}

	private async saveSlideComment(commentText: string, editingId?: string) {
		if (!this.currentNode) return;
		if (editingId) {
			await this.reviewStore.updateComment(editingId, commentText);
			new Notice("💬 Commentaire mis à jour.");
		} else {
			const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
			const noteTitle =
				currentFile instanceof TFile
					? currentFile.basename
					: this.activeSourcePath.split("/").pop()?.replace(/\.md$/, "") || "Note";

			const slideDiff: SlideDiffInfo | undefined = this.activeDiffContext?.slideDiffs.get(
				this.currentNode.id
			);
			const hadDiff = Boolean(slideDiff?.hasChanges);

			await this.reviewStore.addComment({
				projectRootPath: this.sessionRootProjectPath,
				notePath: this.activeSourcePath,
				noteTitle,
				sectionHeading: this.currentNode.title,
				sectionLevel: this.currentNode.level,
				lineStart: this.currentNode.lineStart + 1,
				lineEnd: this.currentNode.lineEnd + 1,
				excerpt: this.currentNode.rawOwnMarkdown.trim(),
				hadDiff,
				oldExcerpt: hadDiff ? slideDiff?.rawOldMarkdown ?? null : undefined,
				commentText,
			});

			const snippet = commentText.length > 52 ? commentText.slice(0, 52) + "…" : commentText;
			new Notice(
				hadDiff
					? `💬 Commentaire (+ancien texte diff) ajouté : « ${snippet} »`
					: `💬 Commentaire ajouté : « ${snippet} »`
			);
		}

		this.updateCockpitUI();
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
	}

	private toggleReviewDrawer() {
		if (!this.reviewDrawer) return;
		if (this.reviewDrawer.isOpen()) {
			this.reviewDrawer.close(true);
		} else {
			this.reviewDrawer.open(this.reviewStore.getAll());
		}
	}

	private async copyPendingCommentsExport(
		includeOneShotPrefix: boolean,
		clearAfter: boolean
	): Promise<void> {
		await this.reviewStore.load();
		const count = this.reviewStore.getCount();
		if (count === 0) {
			new Notice("Aucun commentaire en attente à copier.");
			return;
		}

		const formatted = this.reviewStore.formatExport(includeOneShotPrefix);
		await navigator.clipboard.writeText(formatted);
		await this.reviewStore.archiveBatch(formatted, includeOneShotPrefix);

		if (clearAfter) {
			await this.reviewStore.clearAll(false);
		} else {
			await this.reviewStore.markAllCopied();
		}

		this.updateCockpitUI();
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}

		const modeLabel = includeOneShotPrefix ? "/one-shot" : "sans /one-shot";
		new Notice(
			`📋 ${count} commentaire(s) copié(s) (${modeLabel}) ! Collez dans Antigravity (R pour gérer/vider la file).`
		);
	}

	private async jumpToCommentTarget(comment: ReviewComment) {
		if (comment.notePath === this.activeSourcePath) {
			const match = this.flatNodes.find((n) => n.title === comment.sectionHeading);
			if (match) {
				this.goToNode(match, 'jump', 'start');
				return;
			}
		}
		await this.handleInternalLinkClick(`${comment.notePath}#${comment.sectionHeading}`);
	}

	private updateSlideCounter() {
		if (!this.activeModal || !this.currentNode) return;
		const total = this.flatNodes.length > 1 ? this.flatNodes.length - 1 : 1;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		const current = this.flatNodes.length > 1 ? idx : 1;
		this.activeModal.setCounter(current, total);
	}

	private handleNextNavigation() {
		if (this.activeModal) {
			const handled = this.activeModal.handleNext();
			if (!handled) {
				this.nextSlide();
			}
		} else {
			this.nextSlide();
		}
	}

	private handlePrevNavigation() {
		if (this.activeModal) {
			const handled = this.activeModal.handlePrev();
			if (!handled) {
				this.prevSlide();
			}
		} else {
			this.prevSlide();
		}
	}

	private fastJumpNext() {
		if (this.activeModal) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
		}
		this.nextSlide();
	}

	private fastJumpPrev() {
		if (this.activeModal) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
		}
		this.prevSlide('start');
	}

	private async handleInternalLinkClick(linkpath: string) {
		let decodedLink = linkpath;
		try {
			decodedLink = decodeURIComponent(linkpath);
		} catch {
			decodedLink = linkpath;
		}

		// Local anchors (#Heading)
		if (decodedLink.startsWith("#")) {
			const anchorQuery = decodedLink.substring(1).trim().toLowerCase();
			const targetNode = this.flatNodes.find(n => {
				const titleLower = n.title.toLowerCase().trim();
				return titleLower === anchorQuery ||
					titleLower.replace(/^[#\s\d\.\-_]+/, '') === anchorQuery.replace(/^[#\s\d\.\-_]+/, '') ||
					titleLower.includes(anchorQuery) ||
					anchorQuery.includes(titleLower);
			}) || this.flatNodes.find(n => n.contentMarkdown.toLowerCase().includes(anchorQuery));

			if (targetNode) {
				this.goToNode(targetNode, 'zoom-in', 'start');
			} else {
				new Notice("Section introuvable dans cette note.");
			}
			return;
		}

		const targetFile = this.resolveLinkTargetFile(decodedLink, this.activeSourcePath);
		if (targetFile && targetFile instanceof TFile) {
			const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
			const activeFileBasename = (currentFile instanceof TFile)
				? currentFile.basename
				: (this.activeSourcePath.split('/').pop()?.replace(/\.md$/, '') || "Main note");

			if (targetFile.path === this.activeSourcePath && decodedLink.includes("#")) {
				const anchorQuery = decodedLink.split("#")[1].trim().toLowerCase();
				const targetNode = this.flatNodes.find(n => {
					const titleLower = n.title.toLowerCase().trim();
					return titleLower === anchorQuery ||
						titleLower.replace(/^[#\s\d\.\-_]+/, '') === anchorQuery.replace(/^[#\s\d\.\-_]+/, '') ||
						titleLower.includes(anchorQuery) ||
						anchorQuery.includes(titleLower);
				}) || this.flatNodes.find(n => n.contentMarkdown.toLowerCase().includes(anchorQuery));

				if (targetNode) {
					this.goToNode(targetNode, 'zoom-in', 'start');
				} else {
					new Notice("Section introuvable dans cette note.");
				}
				return;
			}

			this.clearSlideReadTimer();

			if (this.currentNode && this.rootNode) {
				this.documentStack.push({
					filePath: this.activeSourcePath,
					fileTitle: activeFileBasename,
					currentNode: this.currentNode,
					flatNodes: this.flatNodes,
					rootNode: this.rootNode,
					diffContext: this.activeDiffContext,
					diffEnabled: this.diffEnabled,
					seenInSession: new Set(this.seenInSession),
				});
			}

			// Recharger les baselines fraîches à l'entrée de la sous-note
			await this.baselinesStore.reload().catch(() => undefined);

			const markdownText = await this.app.vault.read(targetFile);
			const cache = this.app.metadataCache.getFileCache(targetFile);
			const parsed = parseMarkdownSections(markdownText, cache?.headings);

			this.activeSourcePath = targetFile.path;
			this.rootNode = parsed.root;
			this.flatNodes = parsed.flatNodes;
			this.seenInSession = new Set();

			let initialNode: SectionNode | null = null;
			if (decodedLink.includes("#")) {
				const anchorQuery = decodedLink.split("#")[1].trim().toLowerCase();
				initialNode = this.flatNodes.find(n => {
					const titleLower = n.title.toLowerCase().trim();
					return titleLower === anchorQuery ||
						titleLower.replace(/^[#\s\d\.\-_]+/, '') === anchorQuery.replace(/^[#\s\d\.\-_]+/, '') ||
						titleLower.includes(anchorQuery) ||
						anchorQuery.includes(titleLower);
				}) || this.flatNodes.find(n => n.contentMarkdown.toLowerCase().includes(anchorQuery)) || null;
			}

			this.currentNode = initialNode || ((this.flatNodes.length > 1) ? this.flatNodes[1] : this.rootNode);

			const diffInit = await this.computeDiffForLoadedNote(targetFile.path, markdownText, this.flatNodes);
			this.activeDiffContext = diffInit.ctx;
			this.diffEnabled = diffInit.autoEnable;

			if (this.activeModal && this.currentNode) {
				this.activeModal.closeMediaZoom(false);
				this.activeModal.cancelScrollAnimation(false);
				await this.activeModal.updateSlide(
					this.currentNode,
					this.activeSourcePath,
					'zoom-in',
					'start',
					this.buildSlideRenderDecoration(this.currentNode)
				);
				const parentFrame = this.documentStack[this.documentStack.length - 1];
				this.activeModal.setBreadcrumb(targetFile.basename, parentFrame?.fileTitle);
				this.activeModal.setReturnButton(parentFrame ? parentFrame.fileTitle : null);
				this.updateSlideCounter();
				this.updateCockpitUI();
				this.activeModal.showSubNoteBanner(targetFile.basename, () => void this.popDocumentStack());
				this.scheduleSlideSeenTimer(this.currentNode);
			}

			if (this.tocComp && this.currentNode) {
				this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
			}

			new Notice(
				this.diffEnabled
					? `📄 ${targetFile.basename} (🟢 Diff actif : ${this.activeDiffContext?.totalDirtySlides || 0} slide(s))`
					: `📄 ${targetFile.basename}`
			);
		} else {
			new Notice(`Fichier ou section introuvable pour le lien : ${decodedLink}`);
		}
	}

	private async popDocumentStack() {
		if (this.documentStack.length === 0) return;
		this.clearSlideReadTimer();

		const parentFrame = this.documentStack.pop()!;
		this.activeSourcePath = parentFrame.filePath;
		this.flatNodes = parentFrame.flatNodes;
		this.rootNode = parentFrame.rootNode;
		this.currentNode = parentFrame.currentNode;
		this.activeDiffContext = parentFrame.diffContext;
		this.diffEnabled = parentFrame.diffEnabled;
		this.seenInSession = parentFrame.seenInSession;

		// Recharger unread_baselines.json afin que les pastilles 🟢 Modifié se mettent à jour
		// immédiatement si Henri vient de lire intégralement la sous-note !
		await this.baselinesStore.reload().catch(() => undefined);

		if (this.activeModal && this.currentNode) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
			await this.activeModal.updateSlide(
				this.currentNode,
				this.activeSourcePath,
				'zoom-out',
				'start',
				this.buildSlideRenderDecoration(this.currentNode)
			);
			const prevParent = this.documentStack[this.documentStack.length - 1];
			this.activeModal.setReturnButton(prevParent ? prevParent.fileTitle : null);
			if (this.documentStack.length > 0) {
				this.activeModal.showSubNoteBanner(parentFrame.fileTitle, () => void this.popDocumentStack());
			} else {
				this.activeModal.hideSubNoteBanner();
			}
			this.updateSlideCounter();
			this.updateCockpitUI();
			this.scheduleSlideSeenTimer(this.currentNode);
		}

		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}

		new Notice(`↩ Retour : ${parentFrame.fileTitle}`);
	}

	private goToNode(
		node: SectionNode,
		overrideDirection?: 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump',
		enterFrom: 'start' | 'end' = 'start'
	) {
		const direction = overrideDirection ?? computeDirection(this.currentNode, node);
		this.currentNode = node;
		if (this.activeModal && this.currentNode) {
			void this.activeModal.updateSlide(
				this.currentNode,
				this.activeSourcePath,
				direction,
				enterFrom,
				this.buildSlideRenderDecoration(this.currentNode)
			);
			this.updateSlideCounter();
			this.updateCockpitUI();
			this.scheduleSlideSeenTimer(this.currentNode);
		}
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
	}

	private nextSlide() {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx === -1 && this.flatNodes.length > 0) {
			this.goToNode(this.flatNodes[0], undefined, 'start');
			return;
		}
		if (idx >= 0 && idx < this.flatNodes.length - 1) {
			this.goToNode(this.flatNodes[idx + 1], undefined, 'start');
		} else if (idx === this.flatNodes.length - 1) {
			new Notice("Fin de la note atteinte.");
		}
	}

	private prevSlide(enterFrom: 'start' | 'end' = 'end') {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx > 0) {
			this.goToNode(this.flatNodes[idx - 1], undefined, enterFrom);
		} else {
			if (this.documentStack.length > 0) {
				void this.popDocumentStack();
			} else {
				new Notice("Début de la note atteint.");
			}
		}
	}

	private closePresentation() {
		this.clearSlideReadTimer();
		if (this.commentModal) {
			this.commentModal.close(false);
			this.commentModal = null;
		}
		if (this.reviewDrawer) {
			this.reviewDrawer.close(false);
			this.reviewDrawer = null;
		}
		if (this.activeModal) {
			const modal = this.activeModal;
			this.activeModal = null;
			modal.close();
		} else {
			this.cleanupNavigation();
			void this.jumpToCurrentSlideInEditor();
		}
	}

	private async jumpToCurrentSlideInEditor() {
		if (!this.activeSourcePath) return;

		const targetPath = this.activeSourcePath;
		const targetLine = this.currentNode ? Math.max(0, this.currentNode.lineStart) : 0;

		let view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!view || !view.file || view.file.path !== targetPath) {
			const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (targetFile instanceof TFile) {
				const leaves = this.app.workspace.getLeavesOfType("markdown");
				const matchingLeaf = leaves.find(l => (l.view as MarkdownView)?.file?.path === targetPath);
				if (matchingLeaf) {
					this.app.workspace.setActiveLeaf(matchingLeaf, { focus: true });
					view = matchingLeaf.view as MarkdownView;
				} else {
					const leaf = this.app.workspace.getLeaf(false);
					await leaf.openFile(targetFile);
					view = this.app.workspace.getActiveViewOfType(MarkdownView);
				}
			}
		}

		if (view && view.editor) {
			const editor = view.editor;
			const totalLines = editor.lineCount();
			const clampedLine = Math.min(Math.max(0, targetLine), Math.max(0, totalLines - 1));

			editor.setCursor({ line: clampedLine, ch: 0 });
			editor.scrollIntoView(
				{
					from: { line: clampedLine, ch: 0 },
					to: { line: clampedLine, ch: 0 }
				},
				true
			);
			view.editor.focus();
		}
	}

	private cleanupNavigation() {
		this.clearSlideReadTimer();
		if (this.keyboardNav) {
			this.keyboardNav.detach();
			this.keyboardNav = null;
		}
		if (this.tocComp) {
			this.tocComp.destroy();
			this.tocComp = null;
		}
	}
}

export class SlideFlowSettingTab extends PluginSettingTab {
	plugin: SlideFlowPlugin;

	constructor(app: App, plugin: SlideFlowPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "SlideFlow — Présentation, Diffs & Revue" });

		const setting = new Setting(containerEl)
			.setName("Transition animation duration")
			.setDesc(`Current duration: ${this.plugin.settings.transitionDuration}s`)
			.addSlider(slider =>
				slider
					.setLimits(0.2, 1.5, 0.05)
					.setValue(this.plugin.settings.transitionDuration)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const roundedValue = Math.round(value * 100) / 100;
						this.plugin.settings.transitionDuration = roundedValue;
						await this.plugin.saveSettings();
						setting.setDesc(`Current duration: ${roundedValue}s`);
					})
			);

		new Setting(containerEl)
			.setName("Smooth scroll duration")
			.setDesc("Adjust the vertical scrolling animation duration (in seconds) for slide text.")
			.addSlider(slider =>
				slider
					.setLimits(0.5, 4.0, 0.1)
					.setValue(this.plugin.settings.scrollDuration)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const roundedValue = Math.round(value * 10) / 10;
						this.plugin.settings.scrollDuration = roundedValue;
						await this.plugin.saveSettings();
					})
			);

		const zoomSetting = new Setting(containerEl)
			.setName("Default zoom / scale level")
			.setDesc(`Current scale: ${Math.round((this.plugin.settings.zoomLevel || 1.0) * 100)}%`)
			.addSlider(slider =>
				slider
					.setLimits(0.7, 2.0, 0.05)
					.setValue(this.plugin.settings.zoomLevel || 1.0)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const roundedValue = Math.round(value * 100) / 100;
						this.plugin.settings.zoomLevel = roundedValue;
						await this.plugin.saveSettings();
						zoomSetting.setDesc(`Current scale: ${Math.round(roundedValue * 100)}%`);
					})
			);

		containerEl.createEl("h3", { text: "Diffs (Dirty-Only _agents/unread_baselines.json)" });

		const diffThreshSetting = new Setting(containerEl)
			.setName("Seuil de bascule bloc rouge/vert (%)")
			.setDesc(`Au-delà de ${Math.round(this.plugin.settings.blockDiffThreshold * 100)}% de mots modifiés, le paragraphe s'affiche en bloc complet (défaut : 25%).`)
			.addSlider(slider =>
				slider
					.setLimits(10, 80, 5)
					.setValue(Math.round(this.plugin.settings.blockDiffThreshold * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.blockDiffThreshold = value / 100;
						await this.plugin.saveSettings();
						diffThreshSetting.setDesc(`Au-delà de ${value}% de mots modifiés, le paragraphe s'affiche en bloc complet (défaut : 25%).`);
					})
			);

		const readDelaySetting = new Setting(containerEl)
			.setName("Délai de marquage « vu » d'une slide (secondes)")
			.setDesc(`Actuel : ${(this.plugin.settings.autoMarkReadDelayMs / 1000).toFixed(1)}s — passé ce délai sur une slide, son diff disparaîtra à la prochaine ouverture.`)
			.addSlider(slider =>
				slider
					.setLimits(0.5, 5.0, 0.5)
					.setValue(this.plugin.settings.autoMarkReadDelayMs / 1000)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autoMarkReadDelayMs = Math.round(value * 1000);
						await this.plugin.saveSettings();
						readDelaySetting.setDesc(`Actuel : ${value.toFixed(1)}s — passé ce délai sur une slide, son diff disparaîtra à la prochaine ouverture.`);
					})
			);

		containerEl.createEl("h3", { text: "Dictée vocale locale Faster-Whisper GPU (V / Ctrl+M)" });

		new Setting(containerEl)
			.setName("Démarrer automatiquement le serveur Faster-Whisper GPU")
			.setDesc("Lance silencieusement whisper_dictation_server.py en arrière-plan dès l'ouverture de SlideFlow.")
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.autoStartWhisperServer)
					.onChange(async (val) => {
						this.plugin.settings.autoStartWhisperServer = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("URL du serveur Whisper")
			.setDesc("Adresse locale du micro-serveur HTTP Faster-Whisper (défaut : http://127.0.0.1:3056).")
			.addText(text =>
				text
					.setPlaceholder("http://127.0.0.1:3056")
					.setValue(this.plugin.settings.whisperServerUrl)
					.onChange(async (val) => {
						this.plugin.settings.whisperServerUrl = val.trim() || "http://127.0.0.1:3056";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Chemin du script serveur Whisper")
			.setDesc("Chemin relatif au coffre ou absolu vers whisper_dictation_server.py.")
			.addText(text =>
				text
					.setPlaceholder("_agents/scripts-for-skills/whisper_dictation_server.py")
					.setValue(this.plugin.settings.whisperScriptPath)
					.onChange(async (val) => {
						this.plugin.settings.whisperScriptPath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Exécutable Python")
			.setDesc("Commande Python disposant de faster-whisper (défaut : python).")
			.addText(text =>
				text
					.setPlaceholder("python")
					.setValue(this.plugin.settings.whisperPythonPath)
					.onChange(async (val) => {
						this.plugin.settings.whisperPythonPath = val.trim() || "python";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Modèle Faster-Whisper")
			.setDesc("Modèle local chargé sur GPU CUDA FP16 (medium recommandé).")
			.addDropdown(dd =>
				dd
					.addOption("tiny", "tiny (ultra-rapide)")
					.addOption("base", "base (rapide)")
					.addOption("small", "small (équilibré)")
					.addOption("medium", "medium (recommandé GPU)")
					.addOption("large-v3-turbo", "large-v3-turbo")
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (val) => {
						this.plugin.settings.whisperModel = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Langue de dictée")
			.setDesc("Code ISO (fr, en) ou auto pour détection automatique.")
			.addDropdown(dd =>
				dd
					.addOption("fr", "Français (fr)")
					.addOption("en", "English (en)")
					.addOption("auto", "Auto-détection")
					.setValue(this.plugin.settings.whisperLanguage)
					.onChange(async (val) => {
						this.plugin.settings.whisperLanguage = val;
						await this.plugin.saveSettings();
					})
			);
	}
}
