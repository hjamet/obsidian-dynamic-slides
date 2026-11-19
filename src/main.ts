import { Plugin, Notice, MarkdownView, PluginSettingTab, Setting, App, TFile } from "obsidian";
import * as path from "path";
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
import {
	AnchorRect,
	ExtractedCommentContext,
	extractSelectionContext,
	extractVisibleSlideContext,
	extractZoomContext,
} from "./contextExtractor";
import { ReviewComment, ReviewStore } from "./reviewStore";
import { VoiceDictationService } from "./voiceDictation";
import { CommentOverlayModal } from "./commentModal";
import { ReviewDrawer } from "./reviewDrawer";
import { ConfirmOverlayModal } from "./confirmModal";
import {
	DEFAULT_CLI_COMMAND,
	getCliDisplayName,
	parseCommandTemplate,
	runCliCommand,
	templateIncludesOneShot,
} from "./cliRunner";
import {
	ActiveJobsTracker,
	extractModelLabelFromCommand,
} from "./activeJobsTracker";

export interface SlideFlowSettings {
	transitionDuration: number; // in seconds
	scrollDuration: number;
	zoomLevel: number; // 0.7 to 2.0 (1.0 = 100%)
	blockDiffThreshold: number; // 0.1 to 0.8 (default 0.25 = 25%)
	directCliEnabled: boolean; // optional direct CLI send (instead of clipboard)
	directCliCommand: string; // command template containing {{COMMENTS}}
	whisperModel: string;
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
}

export const DEFAULT_SETTINGS: SlideFlowSettings = {
	transitionDuration: 0.65,
	scrollDuration: 1.0,
	zoomLevel: 1.0,
	blockDiffThreshold: DEFAULT_BLOCK_DIFF_THRESHOLD,
	directCliEnabled: false,
	directCliCommand: DEFAULT_CLI_COMMAND,
	whisperModel: "medium",
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
	private exitConfirmModal: ConfirmOverlayModal | null = null;

	private baselinesStore!: BaselinesStore;
	public reviewStore!: ReviewStore;
	private voiceService!: VoiceDictationService;
	private activeJobsTracker!: ActiveJobsTracker;

	private rootNode: SectionNode | null = null;
	private flatNodes: SectionNode[] = [];
	private currentNode: SectionNode | null = null;
	private activeSourcePath: string = "";
	private sessionRootProjectPath: string = "";
	private documentStack: DocumentStackFrame[] = [];

	private activeDiffContext: NoteDiffContext | null = null;
	private diffEnabled: boolean = false;
	private pendingCommentContext: ExtractedCommentContext | null = null;
	private inFlightCliCommentIds: Set<string> = new Set();

	async onload() {
		console.log("Loading SlideFlow plugin");
		await this.loadSettings();

		const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
		this.baselinesStore = new BaselinesStore(this.app);
		this.reviewStore = new ReviewStore(this.app, pluginDir);
		this.activeJobsTracker = new ActiveJobsTracker(this.app, pluginDir);

		this.app.workspace.onLayoutReady(() => {
			void this.activeJobsTracker.refreshAndSync();
		});
		this.registerInterval(
			window.setInterval(() => {
				void this.activeJobsTracker.refreshAndSync();
			}, 30000)
		);

		this.voiceService = new VoiceDictationService(this.app, pluginDir, () => ({
			whisperModel: this.settings.whisperModel,
			language: this.settings.whisperLanguage,
		}));

		this.addSettingTab(new SlideFlowSettingTab(this.app, this));

		this.addRibbonIcon("presentation", "SlideFlow", () => {
			void this.startPresentation();
		});

		this.addCommand({
			id: "start-slideflow",
			name: "Open slide presentation & review cockpit",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "p" }],
			callback: () => {
				void this.startPresentation();
			}
		});

		this.addCommand({
			id: "copy-slideflow-oneshot",
			name: "Copy pending review comments as XML (/one-shot)",
			callback: () => {
				void this.copyPendingCommentsExport(true);
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
			const allFiles = this.app.vault.getFiles();
			targetFile =
				allFiles.find(
					(f) =>
						f.path.toLowerCase() === cleanLower ||
						f.name.toLowerCase() === cleanLower ||
						f.basename.toLowerCase() === noExt
				) || null;
		}
		return targetFile instanceof TFile ? targetFile : null;
	}

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

		return { overrideMarkdown };
	}

	private updateCockpitUI() {
		if (!this.activeModal || !this.currentNode) return;
		const slideDiff = this.activeDiffContext?.slideDiffs.get(this.currentNode.id);
		const firstHeadingId = this.flatNodes.length > 1 ? this.flatNodes[1].id : this.flatNodes[0]?.id;
		const hasDeletedHere = Boolean(
			this.activeDiffContext &&
				this.currentNode.id === firstHeadingId &&
				this.activeDiffContext.deletedSectionsMarkdown
		);
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
			currentSlideHasDiff: Boolean(slideDiff?.hasChanges || hasDeletedHere),
			currentSlideCommentsCount: currentSlideComments.length,
			totalPendingCommentsCount: this.reviewStore.getCount(),
			directCliEnabled: this.settings.directCliEnabled,
		});
	}

	private applyCurrentSlideHighlights(): void {
		if (!this.activeModal || !this.currentNode) return;
		const slideComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);
		this.activeModal.applyCommentHighlights(slideComments);
	}

	private refreshAllActiveUI(): void {
		this.updateCockpitUI();
		this.applyCurrentSlideHighlights();
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
		if (this.reviewDrawer?.isOpen()) {
			this.reviewDrawer.refresh(this.reviewStore.getAll(), this.inFlightCliCommentIds);
		}
	}

	private async markCurrentSlideDiffRead(clearVisuallyNow: boolean): Promise<boolean> {
		const ctx = this.activeDiffContext;
		const node = this.currentNode;
		if (!ctx || !node) return false;

		const slideDiff = ctx.slideDiffs.get(node.id);
		const firstHeadingId = this.flatNodes.length > 1 ? this.flatNodes[1].id : this.flatNodes[0]?.id;
		const hasDeletedHere = Boolean(node.id === firstHeadingId && ctx.deletedSectionsHash);

		if (!slideDiff) return false;
		if (!slideDiff.hasChanges && !hasDeletedHere) return false;

		await this.baselinesStore.markSlideSeen(
			this.activeSourcePath,
			slideDiff.slideKey,
			slideDiff.rawNewMarkdown,
			ctx.dirtySlideKeys,
			ctx.currentHashesByKey,
			hasDeletedHere ? ctx.deletedSectionsHash : null
		);

		if (clearVisuallyNow) {
			slideDiff.hasChanges = false;
			slideDiff.diffMarkdown = slideDiff.rawNewMarkdown;
			slideDiff.rawOldMarkdown = slideDiff.rawNewMarkdown;
			slideDiff.addedCount = 0;
			slideDiff.removedCount = 0;

			ctx.dirtySlideKeys = ctx.dirtySlideKeys.filter((k) => k !== slideDiff.slideKey);
			ctx.totalDirtySlides = ctx.dirtySlideKeys.length;

			if (hasDeletedHere) {
				ctx.deletedSectionsMarkdown = null;
				ctx.deletedSectionsHash = null;
			}

			ctx.descendantDirtyNodeIds = new Set<string>();
			for (const n of this.flatNodes) {
				const info = ctx.slideDiffs.get(n.id);
				if (info?.hasChanges) {
					let p = n.parent;
					while (p) {
						ctx.descendantDirtyNodeIds.add(p.id);
						p = p.parent;
					}
				}
			}

			if (ctx.totalDirtySlides === 0 && !ctx.deletedSectionsMarkdown) {
				this.activeDiffContext = null;
				this.diffEnabled = false;
			}

			if (this.activeModal) {
				await this.activeModal.refreshSlideInPlace(
					node,
					this.activeSourcePath,
					this.buildSlideRenderDecoration(node)
				);
			}
			this.refreshAllActiveUI();
		}

		return true;
	}

	private async startPresentation() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("No active Markdown note for SlideFlow.");
			return;
		}

		const file = view.file;
		if (!file) {
			new Notice("File not found.");
			return;
		}

		const markdownText = view.editor.getValue();
		if (!markdownText.trim()) {
			new Notice("Empty note: cannot start SlideFlow.");
			return;
		}

		await Promise.all([
			this.baselinesStore.reload().catch((err) => {
				console.error("[SlideFlow] Failed reading unread_baselines.json:", err);
				new Notice(`SlideFlow: failed reading baselines (${err.message})`);
			}),
			this.reviewStore.loadFromDisk().catch((err) => {
				console.error("[SlideFlow] Failed reading pending_reviews.json:", err);
			}),
		]);

		void this.voiceService.prewarmServer();

		this.documentStack = [];
		this.activeSourcePath = file.path;
		this.sessionRootProjectPath = file.path;

		const cache = this.app.metadataCache.getFileCache(file);
		const parsed = parseMarkdownSections(markdownText, cache?.headings);

		if (parsed.error === "no_headings") {
			new Notice("Note without headings: presenting as a single slide.");
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
		this.activeModal.onExternalPdfLinkClickCallback = (href: string) => {
			void this.handleExternalPdfLinkClick(href);
		};
		this.activeModal.onChildHeadingClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode) {
				void this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onSectionClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode) {
				void this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onToggleDiffClickCallback = () => this.toggleDiffMode();
		this.activeModal.onCommentTextClickCallback = () => this.openCommentModal(false);
		this.activeModal.onCommentVoiceClickCallback = () => this.openCommentModal(true);
		this.activeModal.onOpenQueueClickCallback = () => this.toggleReviewDrawer();
		this.activeModal.onCopyOneShotClickCallback = () => void this.handleSlideCtrlEnter();
		this.activeModal.onSelectionCommentCallback = (range: Range, startWithVoice: boolean) => {
			this.openCommentModal(startWithVoice, range);
		};
		this.activeModal.onHighlightCommentClickCallback = (commentId: string, anchorRect: AnchorRect) => {
			this.openEditCommentById(commentId, anchorRect);
		};
		this.activeModal.onMediaZoomOpenedCallback = () => {
			this.applyCurrentSlideHighlights();
		};

		const overlayEl = this.activeModal.getOverlayElement();
		this.exitConfirmModal = new ConfirmOverlayModal(overlayEl);

		this.commentModal = new CommentOverlayModal(overlayEl, this.voiceService, {
			onSubmit: async (commentText: string, editingId?: string) => {
				await this.saveSlideComment(commentText, editingId);
			},
			onDeleteExisting: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.refreshAllActiveUI();
			},
			onClose: () => {
				this.pendingCommentContext = null;
			},
		});

		this.reviewDrawer = new ReviewDrawer(overlayEl, {
			onEditComment: async (comment: ReviewComment) => {
				await this.jumpAndEditComment(comment);
			},
			onDeleteComment: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.refreshAllActiveUI();
			},
			onClearAll: async () => {
				const count = await this.reviewStore.clearAll();
				this.refreshAllActiveUI();
				new Notice(`Review queue cleared (${count} comment${count > 1 ? "s" : ""}).`);
			},
			onPrimaryAction: async () => {
				if (this.settings.directCliEnabled) {
					const launched = this.sendPendingCommentsToCli();
					if (launched) {
						this.reviewDrawer?.close(false);
					}
				} else {
					await this.copyPendingCommentsExport(true);
					this.reviewDrawer?.refresh(this.reviewStore.getAll(), this.inFlightCliCommentIds);
				}
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
			void this.goToNode(selectedNode);
		});
		this.activeModal.setTOC(this.tocComp);
		this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());

		this.updateSlideCounter();
		this.updateCockpitUI();
		this.applyCurrentSlideHighlights();

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
			onCopyOneShot: () => void this.handleSlideCtrlEnter(),
			isInputBlocked: () =>
				Boolean(
					this.commentModal?.isOpen() ||
						this.reviewDrawer?.isOpen() ||
						this.exitConfirmModal?.isOpen()
				),
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
		this.requestClosePresentation();
	}

	/**
	 * Comments are ALWAYS persisted across sessions in both modes (never auto-deleted on exit).
	 * - Direct CLI mode: if unsent comments exist, prompts Ctrl+Enter to send & exit (auto-clears on exit 0),
	 *   Esc to return, or click "Exit & Keep" to close while keeping comments saved.
	 * - Clipboard mode: if uncopied comments exist, prompts Ctrl+Enter to copy & exit,
	 *   Esc to return, or click "Exit & Keep" to close while keeping comments saved until manual Clear queue.
	 */
	private requestClosePresentation(): void {
		if (!this.exitConfirmModal) {
			this.closePresentation();
			return;
		}

		if (this.settings.directCliEnabled) {
			if (!this.reviewStore.hasUnsentComments(this.inFlightCliCommentIds)) {
				this.closePresentation();
				return;
			}
			const unsentCount = this.reviewStore
				.getAll()
				.filter((c) => !this.inFlightCliCommentIds.has(c.id)).length;
			const cliName = getCliDisplayName(this.settings.directCliCommand);

			this.exitConfirmModal.open({
				title: `Unsent comments (${unsentCount})`,
				message: `Send ${unsentCount} review comment${unsentCount > 1 ? "s" : ""} to ${cliName} before closing? Comments stay saved and clear automatically once ${cliName} succeeds.`,
				confirmLabelHtml: `Send & Exit <strong>Ctrl+↵</strong>`,
				confirmVariant: "primary",
				confirmShortcut: "Ctrl+Enter",
				cancelLabelHtml: `Return <strong>Esc</strong>`,
				discardLabel: "Exit & Keep",
				onConfirm: () => {
					const launched = this.sendPendingCommentsToCli();
					if (launched) {
						this.closePresentation();
					}
				},
				onCancel: () => {
					// Stay in presentation
				},
				onDiscard: () => {
					// Exit cleanly without deleting persisted comments
					this.closePresentation();
				},
			});
			return;
		}

		// Clipboard mode
		if (!this.reviewStore.hasUncopiedComments()) {
			this.closePresentation();
			return;
		}

		const count = this.reviewStore.getCount();
		this.exitConfirmModal.open({
			title: `Uncopied comments (${count})`,
			message: `Copy ${count} review comment${count > 1 ? "s" : ""} to clipboard before closing? Comments stay saved in the queue until you click Clear queue.`,
			confirmLabelHtml: `Copy & Exit <strong>Ctrl+↵</strong>`,
			confirmVariant: "primary",
			confirmShortcut: "Ctrl+Enter",
			cancelLabelHtml: `Return <strong>Esc</strong>`,
			discardLabel: "Exit & Keep",
			onConfirm: async () => {
				await this.copyPendingCommentsExport(true);
				this.closePresentation();
			},
			onCancel: () => {
				// Stay in presentation
			},
			onDiscard: () => {
				// Exit cleanly without deleting persisted comments
				this.closePresentation();
			},
		});
	}

	private async handleSlideCtrlEnter(): Promise<void> {
		const validatedDiff = await this.markCurrentSlideDiffRead(true);

		if (this.settings.directCliEnabled) {
			new Notice(validatedDiff ? "Slide diff validated." : "No unread diff on this slide.");
			return;
		}

		const count = this.reviewStore.getCount();
		if (count > 0) {
			const formatted = this.reviewStore.formatExport(true);
			await navigator.clipboard.writeText(formatted);
			await this.reviewStore.markAllCopied();
			this.refreshAllActiveUI();
			new Notice(
				validatedDiff
					? `Slide diff validated & copied ${count} comment(s) (XML).`
					: `Copied ${count} comment(s) (XML /one-shot).`
			);
			return;
		}

		new Notice(
			validatedDiff
				? "Slide diff validated."
				: "No unread diff or comments to copy."
		);
	}

	private toggleDiffMode() {
		if (
			!this.activeDiffContext ||
			(this.activeDiffContext.totalDirtySlides === 0 &&
				!this.activeDiffContext.deletedSectionsMarkdown)
		) {
			new Notice("No unread diff on this note.");
			return;
		}
		this.diffEnabled = !this.diffEnabled;
		if (this.activeModal && this.currentNode) {
			void this.activeModal.refreshSlideInPlace(
				this.currentNode,
				this.activeSourcePath,
				this.buildSlideRenderDecoration(this.currentNode)
			).then(() => this.applyCurrentSlideHighlights());
		}
		this.updateCockpitUI();
		new Notice(this.diffEnabled ? "Diff view enabled" : "Diff view hidden");
	}

	private jumpToNextDiffSlide() {
		if (!this.activeDiffContext || this.activeDiffContext.totalDirtySlides === 0) {
			new Notice("No modified slide in this note.");
			return;
		}
		const dirtyIds = this.getDirtyNodeIdSet();
		const currIdx = this.flatNodes.findIndex((n) => n.id === this.currentNode?.id);
		for (let offset = 1; offset <= this.flatNodes.length; offset++) {
			const idx = (currIdx + offset) % this.flatNodes.length;
			const cand = this.flatNodes[idx];
			if (dirtyIds.has(cand.id)) {
				void this.goToNode(cand, 'jump', 'start');
				return;
			}
		}
	}

	private openCommentModal(startWithVoice: boolean, explicitRange?: Range | null) {
		if (!this.commentModal || !this.currentNode || !this.activeModal) return;

		const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
		const noteTitle =
			currentFile instanceof TFile
				? currentFile.basename
				: this.activeSourcePath.split("/").pop()?.replace(/\.md$/, "") || "Note";

		const slideDiff: SlideDiffInfo | undefined = this.activeDiffContext?.slideDiffs.get(
			this.currentNode.id
		);

		const activeRange = explicitRange ?? this.activeModal.getActiveSelectionRange();
		let extracted: ExtractedCommentContext | null = null;
		let highlightRange: Range | null = null;

		if (activeRange) {
			const activeContainer = this.activeModal.isMediaZoomActive()
				? this.activeModal.getZoomContentElement()
				: this.activeModal.getContentElement();
			extracted = extractSelectionContext(
				activeRange,
				this.activeSourcePath,
				this.currentNode.title,
				activeContainer
			);
			if (extracted) {
				highlightRange = activeRange;
				this.activeModal.hideSelectionToolbar(true);
				window.getSelection()?.removeAllRanges();
			}
		}

		if (!extracted && this.activeModal.isMediaZoomActive()) {
			const zoomEl = this.activeModal.getZoomContentElement();
			if (zoomEl) {
				extracted = extractZoomContext(
					zoomEl,
					this.activeSourcePath,
					this.currentNode.title,
					this.activeModal.getActiveZoomIndex(),
					this.currentNode.rawOwnMarkdown
				);
			}
		}

		if (!extracted) {
			extracted = extractVisibleSlideContext(
				this.activeModal.getContentElement(),
				this.activeSourcePath,
				this.currentNode.title,
				slideDiff,
				this.diffEnabled
			);
		}

		this.pendingCommentContext = extracted;

		const existingComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);

		this.commentModal.open({
			noteTitle,
			notePath: this.activeSourcePath,
			sectionHeading: this.currentNode.title,
			scopeLabel: extracted.scopeLabel,
			hadDiff: extracted.hadDiff,
			existingComments,
			startWithVoice,
			anchorRect: extracted.anchorRect || null,
			highlightRange,
			slideContentEl: this.activeModal.getContentElement(),
			isMediaZoomActive: this.activeModal.isMediaZoomActive(),
		});
	}

	private async saveSlideComment(commentText: string, editingId?: string) {
		if (!this.currentNode) return;
		if (editingId) {
			await this.reviewStore.updateComment(editingId, commentText);
			new Notice("Comment updated.");
		} else {
			const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
			const noteTitle =
				currentFile instanceof TFile
					? currentFile.basename
					: this.activeSourcePath.split("/").pop()?.replace(/\.md$/, "") || "Note";

			const ctx = this.pendingCommentContext;
			const excerpt = ctx?.excerpt || this.currentNode.rawOwnMarkdown.trim();
			const hadDiff = Boolean(ctx?.hadDiff);
			const oldExcerpt = hadDiff ? ctx?.oldExcerpt ?? null : undefined;

			await this.reviewStore.addComment({
				projectRootPath: this.sessionRootProjectPath,
				notePath: this.activeSourcePath,
				noteTitle,
				sectionHeading: this.currentNode.title,
				sectionLevel: this.currentNode.level,
				lineStart: this.currentNode.lineStart + 1,
				lineEnd: this.currentNode.lineEnd + 1,
				scopeType: ctx?.scopeType || "viewport",
				scopeLabel: ctx?.scopeLabel || "Slide",
				contextKey: ctx?.contextKey,
				selectionQuote: ctx?.selectionQuote,
				selectionPrefix: ctx?.selectionPrefix,
				selectionSuffix: ctx?.selectionSuffix,
				excerpt,
				hadDiff,
				oldExcerpt,
				commentText,
			});

			void this.markCurrentSlideDiffRead(false);

			const snippet = commentText.length > 52 ? commentText.slice(0, 52) + "…" : commentText;
			new Notice(`Comment saved (${ctx?.scopeLabel || "Slide"}): "${snippet}"`);
		}

		this.pendingCommentContext = null;
		this.refreshAllActiveUI();
	}

	private toggleReviewDrawer() {
		if (!this.reviewDrawer) return;
		if (this.reviewDrawer.isOpen()) {
			this.reviewDrawer.close(true);
		} else {
			this.reviewDrawer.open({
				comments: this.reviewStore.getAll(),
				directCliEnabled: this.settings.directCliEnabled,
				cliDisplayName: getCliDisplayName(this.settings.directCliCommand),
				inFlightIds: this.inFlightCliCommentIds,
			});
		}
	}

	private async copyPendingCommentsExport(includeOneShotPrefix: boolean): Promise<void> {
		if (!this.activeModal) {
			await this.reviewStore.loadFromDisk();
		}
		const count = this.reviewStore.getCount();
		if (count === 0) {
			new Notice("No pending comments to copy.");
			return;
		}

		const formatted = this.reviewStore.formatExport(includeOneShotPrefix);
		await navigator.clipboard.writeText(formatted);
		await this.reviewStore.markAllCopied();
		this.refreshAllActiveUI();

		new Notice(`Copied ${count} comment(s) (XML /one-shot).`);
	}

	private sendPendingCommentsToCli(): boolean {
		const toSend = this.reviewStore
			.getAll()
			.filter((c) => !this.inFlightCliCommentIds.has(c.id));

		if (toSend.length === 0) {
			if (this.inFlightCliCommentIds.size > 0) {
				new Notice("CLI invocation is already running for these comments…");
			} else {
				new Notice("No pending comments to send.");
			}
			return false;
		}

		const includeOneShotPrefix = !templateIncludesOneShot(this.settings.directCliCommand);
		const formatted = this.reviewStore.formatExport(includeOneShotPrefix, toSend);
		let cliDisplayName = "CLI";

		try {
			const parsed = parseCommandTemplate(this.settings.directCliCommand, formatted);
			cliDisplayName = parsed.displayName;
		} catch (err: any) {
			new Notice(`SlideFlow CLI config error: ${err?.message || String(err)}`, 9000);
			return false;
		}

		const sentIds = toSend.map((c) => c.id);
		for (const id of sentIds) {
			this.inFlightCliCommentIds.add(id);
		}
		this.refreshAllActiveUI();

		const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const jobsDir = this.activeJobsTracker.ensureJobsLogDir();
		const noteTitles = Array.from(new Set(toSend.map((c) => c.noteTitle || c.notePath)));
		const modelLabel = extractModelLabelFromCommand(this.settings.directCliCommand);

		void this.activeJobsTracker.registerJob({
			id: jobId,
			pid: null,
			cli: cliDisplayName,
			model: modelLabel,
			status: "running",
			startedAt: new Date().toISOString(),
			commentCount: sentIds.length,
			notes: noteTitles,
			logPath: path.join(jobsDir, `${jobId}.log`),
		});

		new Notice(`Sending ${sentIds.length} comment(s) to ${cliDisplayName}…`, 5000);

		const cwd = this.reviewStore.getVaultBasePath();
		void runCliCommand(this.settings.directCliCommand, formatted, {
			cwd,
			jobsDir,
			jobId,
			onSpawn: (pid) => {
				void this.activeJobsTracker.updateJobPid(jobId, pid);
			},
		})
			.then(async (res) => {
				for (const id of sentIds) {
					this.inFlightCliCommentIds.delete(id);
				}

				if (res.exitCode === 0) {
					await this.reviewStore.removeCommentsByIds(sentIds);
					await this.activeJobsTracker.completeJob(jobId, 0, null);
					this.refreshAllActiveUI();
					new Notice(
						`${res.displayName} finished — ${sentIds.length} comment(s) sent & cleared.`,
						6000
					);
				} else {
					const rawErr = (res.stderr || res.stdout || "").trim().replace(/\s+/g, " ");
					const detail = rawErr ? rawErr.slice(0, 140) : "";
					await this.activeJobsTracker.completeJob(jobId, res.exitCode, detail || null);
					this.refreshAllActiveUI();
					console.error("[SlideFlow CLI] Non-zero exit:", res);
					new Notice(
						`SlideFlow: ${res.displayName} failed (exit ${res.exitCode}). Comments kept in queue.${detail ? " " + detail : ""}`,
						10000
					);
				}
			})
			.catch(async (err: any) => {
				for (const id of sentIds) {
					this.inFlightCliCommentIds.delete(id);
				}
				const errMsg = err?.message || String(err);
				await this.activeJobsTracker.completeJob(jobId, -1, errMsg);
				this.refreshAllActiveUI();
				console.error("[SlideFlow CLI] Execution failed:", err);
				new Notice(
					`SlideFlow CLI error: ${errMsg}. Comments kept in queue.`,
					10000
				);
			});

		return true;
	}

	private openEditCommentById(commentId: string, anchorRect?: AnchorRect | null): void {
		if (!this.commentModal || !this.activeModal) return;
		const comment = this.reviewStore.getAll().find((c) => c.id === commentId);
		if (!comment) return;

		const existingComments = this.reviewStore.getForSlide(
			comment.notePath,
			comment.sectionHeading
		);

		this.commentModal.open({
			noteTitle: comment.noteTitle,
			notePath: comment.notePath,
			sectionHeading: comment.sectionHeading,
			scopeLabel: comment.scopeLabel || "Selection",
			hadDiff: comment.hadDiff,
			existingComments,
			startWithVoice: false,
			anchorRect: anchorRect || null,
			highlightRange: null,
			editingComment: comment,
			slideContentEl: this.activeModal.getContentElement(),
			isMediaZoomActive: this.activeModal.isMediaZoomActive(),
		});
	}

	private async jumpToCommentTarget(comment: ReviewComment): Promise<void> {
		if (comment.notePath === this.activeSourcePath) {
			const match = this.flatNodes.find((n) => n.title === comment.sectionHeading);
			if (match) {
				await this.goToNode(match, 'jump', 'start');
				return;
			}
		}
		await this.handleInternalLinkClick(`${comment.notePath}#${comment.sectionHeading}`);
	}

	private async jumpAndEditComment(comment: ReviewComment): Promise<void> {
		await this.jumpToCommentTarget(comment);
		if (!this.commentModal || !this.currentNode || !this.activeModal) return;

		const existingComments = this.reviewStore.getForSlide(
			comment.notePath,
			comment.sectionHeading
		);

		this.commentModal.open({
			noteTitle: comment.noteTitle,
			notePath: comment.notePath,
			sectionHeading: comment.sectionHeading,
			scopeLabel: comment.scopeLabel || "Slide",
			hadDiff: comment.hadDiff,
			existingComments,
			startWithVoice: false,
			anchorRect: null,
			highlightRange: null,
			editingComment: comment,
			slideContentEl: this.activeModal.getContentElement(),
			isMediaZoomActive: this.activeModal.isMediaZoomActive(),
		});
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

	private async handleExternalPdfLinkClick(fileUrl: string): Promise<void> {
		if (!this.activeModal) return;
		try {
			const hashIdx = fileUrl.indexOf("#");
			const basePart = hashIdx >= 0 ? fileUrl.slice(0, hashIdx) : fileUrl;
			const hashPart = hashIdx >= 0 ? fileUrl.slice(hashIdx) : "";

			let decodedPath = decodeURIComponent(basePart.replace(/^file:\/\//i, ""));
			if (process.platform === "win32") {
				decodedPath = decodedPath.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\");
			}

			// If this local PDF lives inside the vault, open it through Obsidian's native PDF.js viewer!
			const vaultBase = this.reviewStore.getVaultBasePath();
			if (vaultBase) {
				const rel = path.relative(vaultBase, decodedPath);
				if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
					const vaultRel = rel.replace(/\\/g, "/");
					const vaultFile = this.app.vault.getAbstractFileByPath(vaultRel);
					if (vaultFile instanceof TFile && vaultFile.extension.toLowerCase() === "pdf") {
						await this.activeModal.openVaultPdfZoom(
							vaultFile.path,
							hashPart,
							vaultFile.name,
							this.activeSourcePath
						);
						return;
					}
				}
			}

			await this.activeModal.openLocalFilePdfZoom(decodedPath, hashPart);
		} catch (err: any) {
			console.error("[SlideFlow] Failed opening local PDF:", err);
			new Notice(`SlideFlow PDF error: ${err?.message || String(err)}`);
		}
	}

	private async handleInternalLinkClick(linkpath: string) {
		let decodedLink = linkpath;
		try {
			decodedLink = decodeURIComponent(linkpath);
		} catch {
			decodedLink = linkpath;
		}

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
				await this.goToNode(targetNode, 'zoom-in', 'start');
			} else {
				new Notice("Section not found in presentation.");
			}
			return;
		}

		const targetFile = this.resolveLinkTargetFile(decodedLink, this.activeSourcePath);
		if (targetFile && targetFile instanceof TFile) {
			// Local vault PDF clicked -> open directly in SlideFlow's fullscreen PDF zoom viewer!
			if (targetFile.extension.toLowerCase() === "pdf") {
				const hashIdx = decodedLink.indexOf("#");
				const subpath = hashIdx >= 0 ? decodedLink.slice(hashIdx) : "";
				await this.activeModal?.openVaultPdfZoom(
					targetFile.path,
					subpath,
					targetFile.name,
					this.activeSourcePath
				);
				return;
			}

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
					await this.goToNode(targetNode, 'zoom-in', 'start');
				} else {
					new Notice("Section not found in presentation.");
				}
				return;
			}

			if (this.currentNode && this.rootNode) {
				this.documentStack.push({
					filePath: this.activeSourcePath,
					fileTitle: activeFileBasename,
					currentNode: this.currentNode,
					flatNodes: this.flatNodes,
					rootNode: this.rootNode,
					diffContext: this.activeDiffContext,
					diffEnabled: this.diffEnabled,
				});
			}

			await this.baselinesStore.reload().catch(() => undefined);

			const markdownText = await this.app.vault.read(targetFile);
			const cache = this.app.metadataCache.getFileCache(targetFile);
			const parsed = parseMarkdownSections(markdownText, cache?.headings);

			this.activeSourcePath = targetFile.path;
			this.rootNode = parsed.root;
			this.flatNodes = parsed.flatNodes;

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
				this.applyCurrentSlideHighlights();
				this.activeModal.showSubNoteBanner(targetFile.basename, () => void this.popDocumentStack());
			}

			if (this.tocComp && this.currentNode) {
				this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
			}
		} else {
			new Notice(`File or section not found: ${decodedLink}`);
		}
	}

	private async popDocumentStack() {
		if (this.documentStack.length === 0) return;

		const parentFrame = this.documentStack.pop()!;
		this.activeSourcePath = parentFrame.filePath;
		this.flatNodes = parentFrame.flatNodes;
		this.rootNode = parentFrame.rootNode;
		this.currentNode = parentFrame.currentNode;
		this.activeDiffContext = parentFrame.diffContext;
		this.diffEnabled = parentFrame.diffEnabled;

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
			this.applyCurrentSlideHighlights();
		}

		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
	}

	private async goToNode(
		node: SectionNode,
		overrideDirection?: 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump',
		enterFrom: 'start' | 'end' = 'start'
	): Promise<void> {
		const direction = overrideDirection ?? computeDirection(this.currentNode, node);
		this.currentNode = node;
		if (this.activeModal && this.currentNode) {
			await this.activeModal.updateSlide(
				this.currentNode,
				this.activeSourcePath,
				direction,
				enterFrom,
				this.buildSlideRenderDecoration(this.currentNode)
			);
			this.updateSlideCounter();
			this.updateCockpitUI();
			this.applyCurrentSlideHighlights();
		}
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
	}

	private nextSlide() {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx === -1 && this.flatNodes.length > 0) {
			void this.goToNode(this.flatNodes[0], undefined, 'start');
			return;
		}
		if (idx >= 0 && idx < this.flatNodes.length - 1) {
			void this.goToNode(this.flatNodes[idx + 1], undefined, 'start');
		} else if (idx === this.flatNodes.length - 1) {
			new Notice("End of presentation reached.");
		}
	}

	private prevSlide(enterFrom: 'start' | 'end' = 'end') {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx > 0) {
			void this.goToNode(this.flatNodes[idx - 1], undefined, enterFrom);
		} else {
			if (this.documentStack.length > 0) {
				void this.popDocumentStack();
			} else {
				new Notice("Beginning of presentation reached.");
			}
		}
	}

	private closePresentation() {
		if (this.exitConfirmModal) {
			this.exitConfirmModal.close();
			this.exitConfirmModal = null;
		}
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

		containerEl.createEl("h2", { text: "SlideFlow" });

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

		containerEl.createEl("h3", { text: "Diffs (_agents/unread_baselines.json)" });

		const diffThreshSetting = new Setting(containerEl)
			.setName("Block diff threshold (%)")
			.setDesc(`Above ${Math.round(this.plugin.settings.blockDiffThreshold * 100)}% modified tokens, switches paragraph to full red/green block diff (default: 25%). Slide diffs are marked as read only when you comment or press Ctrl+Enter.`)
			.addSlider(slider =>
				slider
					.setLimits(10, 80, 5)
					.setValue(Math.round(this.plugin.settings.blockDiffThreshold * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.blockDiffThreshold = value / 100;
						await this.plugin.saveSettings();
						diffThreshSetting.setDesc(`Above ${value}% modified tokens, switches paragraph to full red/green block diff (default: 25%). Slide diffs are marked as read only when you comment or press Ctrl+Enter.`);
					})
			);

		containerEl.createEl("h3", { text: "Direct CLI Execution (Optional)" });

		new Setting(containerEl)
			.setName("Send comments directly to CLI (instead of clipboard)")
			.setDesc(
				"When enabled, Ctrl+Enter on a slide only validates its diff. Pressing Ctrl+Enter on exit or inside the Review Queue (R) runs the command below with the XML /one-shot payload, and sent comments are automatically cleared once the command exits with code 0. When disabled, comments persist until manually cleared via Clear queue."
			)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.directCliEnabled)
					.onChange(async (val) => {
						this.plugin.settings.directCliEnabled = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("CLI command template")
			.setDesc(
				"Terminal command with {{COMMENTS}} marking where the XML /one-shot payload is injected directly as an argument (no shell escaping issues). Runs in the vault root directory."
			)
			.addTextArea(text => {
				text
					.setPlaceholder(DEFAULT_CLI_COMMAND)
					.setValue(this.plugin.settings.directCliCommand)
					.onChange(async (val) => {
						this.plugin.settings.directCliCommand = val.trim() || DEFAULT_CLI_COMMAND;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 3;
				text.inputEl.addClass("slideflow-settings-cli-textarea");
			});

		containerEl.createEl("h3", { text: "Voice Dictation (V / Ctrl+M)" });

		new Setting(containerEl)
			.setName("Whisper model")
			.setDesc("Managed automatically by SlideFlow (runtime, CUDA GPU detection, and model download happen automatically on first use).")
			.addDropdown(dd =>
				dd
					.addOption("tiny", "tiny")
					.addOption("base", "base")
					.addOption("small", "small")
					.addOption("medium", "medium (recommended)")
					.addOption("large-v3-turbo", "large-v3-turbo")
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (val) => {
						this.plugin.settings.whisperModel = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dictation language")
			.setDesc("ISO language code (fr, en) or automatic detection.")
			.addDropdown(dd =>
				dd
					.addOption("fr", "French (fr)")
					.addOption("en", "English (en)")
					.addOption("auto", "Auto-detect")
					.setValue(this.plugin.settings.whisperLanguage)
					.onChange(async (val) => {
						this.plugin.settings.whisperLanguage = val;
						await this.plugin.saveSettings();
					})
			);
	}
}
