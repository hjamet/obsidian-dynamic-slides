import { Plugin, Notice, MarkdownView, PluginSettingTab, Setting, App, TFile, EventRef, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import {
	buildChildHeadingsHtml,
	buildInlineDeletedHeadingHtml,
	hasSubstantivePreamble,
	isHeadingOnlySkippedSlide,
	parseMarkdownSections,
	findCurrentSectionNode,
	SectionNode,
} from "./parser";
import { InternalLinkVisualState, PresentationModal, SlideRenderDecoration } from "./modal";
import { KeyboardNavigator } from "./keyboard";
import { TOCComponent, TOCVisualMeta } from "./toc";
import {
	buildNoteDiffContext,
	DEFAULT_BLOCK_DIFF_THRESHOLD,
	DeletedSectionItem,
	normalizeTitle,
	NoteDiffContext,
	SlideDiffInfo,
} from "./diffEngine";
import { BaselinesStore, normalizeVaultPath } from "./baselinesStore";
import {
	AnchorRect,
	ExtractedCommentContext,
	extractBlockContext,
	extractSelectionContext,
	extractTableRowContext,
	extractVisibleSlideContext,
	extractZoomContext,
} from "./contextExtractor";
import { captureSelectionAnchorSnippet } from "./commentHighlighter";
import {
	BlockHighlightTarget,
	toggleMarkdownHighlightInSection,
} from "./markdownHighlighter";
import {
	CliSessionBatch,
	GENERAL_NOTE_PATH,
	isGeneralComment,
	partitionCommentsForCliSessions,
	ReviewComment,
	ReviewStore,
} from "./reviewStore";
import { CommentImageAttachment, pruneStaleTempImages } from "./commentImages";
import { VoiceDictationService } from "./voiceDictation";
import { CommentOverlayModal } from "./commentModal";
import { ReviewDrawer } from "./reviewDrawer";
import { ConfirmOverlayModal } from "./confirmModal";
import { SlideCommentsRail } from "./slideCommentsRail";
import {
	DEFAULT_CLI_COMMAND,
	getCliDisplayName,
	parseCommandTemplate,
	runCliCommand,
	stripAgyRemoteControlFlagFromTemplate,
	templateIncludesOneShot,
} from "./cliRunner";
import {
	ActiveJobsTracker,
	extractModelLabelFromCommand,
	formatJobNotesLabel,
	isPidAlive,
} from "./activeJobsTracker";
import {
	AgyServerManager,
	getDefaultAgyServerName,
	listAvailableAgyProjects,
	resolveAgyProjectInfo,
} from "./agyServerManager";
import {
	AntigravityHubInfo,
	createHubConversation,
	getHubConversation,
	monitorHubConversation,
	readHubConversationLiveProgress,
} from "./antigravityHubClient";
import { AgySidebarView, SLIDEFLOW_AGY_VIEW_TYPE } from "./agySidebarView";
import { QuotaTracker } from "./quotaTracker";

export interface SlideFlowSettings {
	transitionDuration: number; // in seconds
	scrollDuration: number;
	zoomLevel: number; // 0.7 to 2.0 (1.0 = 100%)
	blockDiffThreshold: number; // 0.1 to 0.8 (default 0.25 = 25%)
	directCliEnabled: boolean; // optional direct CLI send (instead of clipboard)
	directCliCommand: string; // command template containing {{COMMENTS}}
	agyProjectName: string; // Antigravity project name or ID (default "Obsidian")
	agyServerAutoStart: boolean; // start `agy remote-control serve` with Obsidian & stop on unload
	agyServerName: string; // custom instance name (empty = auto `obsidian-<hostname>`)
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
	readingFocusActive?: boolean;
	readingFocusIndex?: number;
	focusedLinkIndex?: number;
	zoomIndex?: number;
	zoomTableRowIndex?: number;
}

export const DEFAULT_SETTINGS: SlideFlowSettings = {
	transitionDuration: 0.65,
	scrollDuration: 1.0,
	zoomLevel: 1.0,
	blockDiffThreshold: DEFAULT_BLOCK_DIFF_THRESHOLD,
	directCliEnabled: false,
	directCliCommand: DEFAULT_CLI_COMMAND,
	agyProjectName: "Obsidian",
	agyServerAutoStart: true,
	agyServerName: "",
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
	private slideCommentsRail: SlideCommentsRail | null = null;

	private baselinesStore!: BaselinesStore;
	public reviewStore!: ReviewStore;
	private voiceService!: VoiceDictationService;
	private activeJobsTracker!: ActiveJobsTracker;
	private agyServer!: AgyServerManager;
	private quotaTracker!: QuotaTracker;
	private knownRunningJobIds: Set<string> = new Set();
	private unsubJobsForQuotas: (() => void) | null = null;

	private rootNode: SectionNode | null = null;
	private flatNodes: SectionNode[] = [];
	private currentNode: SectionNode | null = null;
	private activeSourcePath: string = "";
	private sessionRootProjectPath: string = "";
	private documentStack: DocumentStackFrame[] = [];

	private activeDiffContext: NoteDiffContext | null = null;
	private diffEnabled: boolean = false;
	private pendingCommentContext: ExtractedCommentContext | null = null;
	private liveOwnedJobIds: Set<string> = new Set();
	private unloaded: boolean = false;
	private activeLoadedMarkdown: string = "";
	private activeVaultModifyRef: EventRef | null = null;
	private liveReloadTimerId: number | null = null;

	async onload() {
		console.log("Loading SlideFlow plugin");
		await this.loadSettings();

		const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
		this.baselinesStore = new BaselinesStore(this.app);
		this.reviewStore = new ReviewStore(this.app, pluginDir);
		this.activeJobsTracker = new ActiveJobsTracker(this.app, pluginDir);
		this.activeJobsTracker.setProtectedBatchIdsProvider(() =>
			this.reviewStore.getActiveFailedBatchIds()
		);

		this.agyServer = new AgyServerManager(
			() => this.reviewStore.getVaultBasePath(),
			() => this.activeJobsTracker.ensureJobsLogDir(),
			() => ({
				cliCommandTemplate: this.settings.directCliCommand,
				projectName: this.settings.agyProjectName,
				serverName: this.settings.agyServerName,
				autoStart: this.settings.agyServerAutoStart,
			})
		);

		this.quotaTracker = new QuotaTracker(() => this.settings.directCliCommand);
		this.unsubJobsForQuotas = this.activeJobsTracker.subscribe((jobs) => {
			const currentRunning = new Set<string>();
			for (const j of jobs) {
				if (j.status === "running") {
					currentRunning.add(j.id);
				}
			}
			let finishedDetected = false;
			for (const prevId of this.knownRunningJobIds) {
				if (!currentRunning.has(prevId)) {
					finishedDetected = true;
					break;
				}
			}
			this.knownRunningJobIds = currentRunning;
			if (finishedDetected) {
				void this.quotaTracker.refresh();
			}
		});

		this.registerView(
			SLIDEFLOW_AGY_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new AgySidebarView(leaf, {
					getServerSnapshot: () => this.agyServer.getSnapshot(),
					getServerHomeUrl: () => this.agyServer.getServerHomeUrl(),
					getConversationUrl: (convId, projId, overrideInst) =>
						this.agyServer.getConversationUrl(convId, projId, overrideInst),
					getQuotaSnapshot: () => this.quotaTracker.getSnapshot(),
					getJobs: () => this.activeJobsTracker.getCachedJobs(),
					getFailedBatches: () => this.reviewStore.getFailedBatches(),
					getNewPendingComments: () => this.reviewStore.getNewPendingComments(),
					getVaultBasePath: () => this.reviewStore.getVaultBasePath(),
					onStartServer: () => this.agyServer.start(),
					onStopServer: () => this.agyServer.stop(),
					onRestartServer: () => this.agyServer.restart(),
					onRefreshAll: async () => {
						await this.agyServer.ensureConnected();
						await this.reviewStore.loadFromDisk();
						await this.activeJobsTracker.refreshAndSync();
						await this.reconcileOrphanWipBatches();
						await this.activeJobsTracker.refreshAndSync();
						void this.quotaTracker.refresh();
						this.refreshAgySidebarViews();
					},
					onRefreshQuotas: async () => {
						await this.quotaTracker.refresh();
					},
					onRetryFailedBatch: (groupKey) => this.retryFailedBatch(groupKey),
					onDiscardFailedBatch: (groupKey) => this.discardFailedBatch(groupKey),
					onSendNewPending: async () => {
						await this.sendNewPendingCommentsToCli();
					},
					onRemoveHistoryJob: (jobId) => this.activeJobsTracker.removeJob(jobId),
					subscribeServer: (fn) => this.agyServer.subscribe(() => fn()),
					subscribeJobs: (fn) => this.activeJobsTracker.subscribe(() => fn()),
					subscribeQuotas: (fn) => this.quotaTracker.subscribe(() => fn()),
				})
		);

		this.app.workspace.onLayoutReady(() => {
			void this.activateAgySidebarView(false);
			if (this.settings.agyServerAutoStart) {
				void this.agyServer.start();
			} else if (this.settings.directCliEnabled) {
				void this.agyServer.getLiveHub();
			}
			void this.quotaTracker.refresh();
			void this.reviewStore
				.loadFromDisk()
				.then(() => this.activeJobsTracker.stripLegacyDashboardBlock())
				.then(() => this.activeJobsTracker.refreshAndSync())
				.then(() => this.reconcileOrphanWipBatches())
				.then(() => {
					pruneStaleTempImages(this.reviewStore.getAllReferencedImagePaths());
				})
				.then(() => this.activeJobsTracker.refreshAndSync())
				.then(() => this.refreshAgySidebarViews())
				.catch((err) => console.error("[SlideFlow] Startup reconcile failed:", err));
		});
		this.registerInterval(
			window.setInterval(() => {
				void this.reconcileOrphanWipBatches()
					.then(() => this.activeJobsTracker.refreshAndSync())
					.catch(() => undefined);
			}, 20000)
		);

		this.voiceService = new VoiceDictationService(this.app, pluginDir, () => ({
			whisperModel: this.settings.whisperModel,
			language: this.settings.whisperLanguage,
		}));

		this.addSettingTab(new SlideFlowSettingTab(this.app, this));

		this.addRibbonIcon("presentation", "SlideFlow", () => {
			void this.startPresentation();
		});

		this.addRibbonIcon("bot", "SlideFlow AGY Panel", () => {
			void this.activateAgySidebarView(true);
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
			id: "open-slideflow-agy-sidebar",
			name: "Open SlideFlow AGY sidebar",
			callback: () => {
				void this.activateAgySidebarView(true);
			}
		});

		this.addCommand({
			id: "restart-agy-server",
			name: "Restart AGY Remote Control server",
			callback: () => {
				void this.agyServer.restart();
				new Notice("Redémarrage du serveur AGY Remote Control…");
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
		this.unloaded = true;
		this.closePresentation();
		this.voiceService?.shutdownNow();
		this.agyServer?.stop();
		if (this.unsubJobsForQuotas) {
			this.unsubJobsForQuotas();
			this.unsubJobsForQuotas = null;
		}
		console.log("Unloading SlideFlow plugin");
	}

	public refreshAgySidebarViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(SLIDEFLOW_AGY_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof AgySidebarView) {
				leaf.view.render();
			}
		}
	}

	public async activateAgySidebarView(reveal: boolean): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(SLIDEFLOW_AGY_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			await rightLeaf.setViewState({
				type: SLIDEFLOW_AGY_VIEW_TYPE,
				active: reveal,
			});
			leaf = rightLeaf;
		}
		if (reveal && leaf) {
			workspace.revealLeaf(leaf);
		}
		this.refreshAgySidebarViews();
	}

	public onAgyServerConfigChanged(): void {
		this.agyServer?.refreshProjectConfig();
	}

	public applyAgyServerAutoStartToggle(enabled: boolean): void {
		if (!this.agyServer) return;
		if (enabled) {
			this.agyServer.start();
		} else {
			this.agyServer.stop();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (this.settings.agyServerAutoStart && this.settings.directCliCommand) {
			const cleaned = stripAgyRemoteControlFlagFromTemplate(this.settings.directCliCommand);
			if (cleaned && cleaned !== this.settings.directCliCommand) {
				this.settings.directCliCommand = cleaned;
				await this.saveSettings();
			}
		}
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

		if (ctx.totalDirtySlides === 0 && ctx.deletedSections.length === 0) {
			await this.baselinesStore.markEntireNoteRead(normPath);
			return { ctx: null, autoEnable: false };
		}

		this.attachDeletedSectionNodes(flatNodes, ctx);
		return { ctx, autoEnable: true };
	}

	private attachDeletedSectionNodes(flatNodes: SectionNode[], ctx: NoteDiffContext): void {
		ctx.inlineDeletedByParentId.clear();
		if (ctx.deletedSections.length === 0 || flatNodes.length <= 1) return;

		const defaultParent = flatNodes[1] || flatNodes[0];
		const attachedNodes: SectionNode[] = [...flatNodes];

		for (const del of ctx.deletedSections) {
			let parentNode = defaultParent;
			let resolvedParent = false;
			if (del.parentMatchedNodeId) {
				const matchedParent = attachedNodes.find(
					(n) => !n.isVirtualDeleted && n.id === del.parentMatchedNodeId && n.level < del.level
				);
				if (matchedParent) {
					parentNode = matchedParent;
					resolvedParent = true;
				}
			}
			if (!resolvedParent && del.parentNormTitle) {
				const found =
					attachedNodes.find(
						(n) =>
							!n.isVirtualDeleted &&
							n.level > 0 &&
							n.level < del.level &&
							normalizeTitle(n.title) === del.parentNormTitle
					) ||
					attachedNodes.find(
						(n) =>
							n.isVirtualDeleted &&
							n.level > 0 &&
							n.level < del.level &&
							normalizeTitle(n.title) === del.parentNormTitle
					);
				if (found) parentNode = found;
			}
			if (parentNode.level >= del.level && parentNode.parent) {
				parentNode = parentNode.parent;
			}

			if (del.isTitleOnly) {
				// Never attach an inline deleted heading to rootNode (level 0 / "0. Full document"),
				// which is skipped at presentation start and would force backwards jumps to Slide 0.
				const inlineHost =
					parentNode.level === 0 && flatNodes.length > 1 ? flatNodes[1] : parentNode;
				const list = ctx.inlineDeletedByParentId.get(inlineHost.id) || [];
				list.push(del);
				ctx.inlineDeletedByParentId.set(inlineHost.id, list);

				let anc: SectionNode | null = inlineHost.parent;
				while (anc) {
					ctx.descendantDirtyNodeIds.add(anc.id);
					anc = anc.parent;
				}
				continue;
			}

			const vNode: SectionNode = {
				id: del.id,
				title: del.title,
				displayTitle: del.displayTitle,
				level: Math.max(parentNode.level + 1, del.level),
				lineStart: parentNode.lineEnd,
				lineEnd: parentNode.lineEnd,
				parent: parentNode,
				children: [],
				contentMarkdown: del.diffMarkdown,
				rawOwnMarkdown: "",
				childHeadingsHtml: "",
				isPureLinkLeaf: false,
				isVirtualDeleted: true,
			};

			if (del.prevSiblingNormTitle === null) {
				parentNode.children.splice(0, 0, vNode);
			} else {
				const prevIdx = parentNode.children.findIndex(
					(c) => normalizeTitle(c.title) === del.prevSiblingNormTitle
				);
				if (prevIdx !== -1) {
					parentNode.children.splice(prevIdx + 1, 0, vNode);
				} else {
					parentNode.children.push(vNode);
				}
			}
			attachedNodes.push(vNode);

			let anc: SectionNode | null = parentNode;
			while (anc) {
				ctx.descendantDirtyNodeIds.add(anc.id);
				anc = anc.parent;
			}
		}

		// Rebuild flatNodes in-place in exact pre-order DFS so deleted subsections always appear
		// immediately under their parent in natural document order (never stranded at the end!).
		const rootNode = flatNodes[0];
		const ordered: SectionNode[] = [rootNode];
		const visit = (node: SectionNode) => {
			for (const child of node.children) {
				ordered.push(child);
				visit(child);
			}
		};
		visit(rootNode);
		flatNodes.splice(0, flatNodes.length, ...ordered);

		flatNodes.forEach((n, idx) => {
			n.flatIndex = idx;
			if (n.children.length > 0) {
				n.childHeadingsHtml = buildChildHeadingsHtml(n.children, false);
				n.contentMarkdown = `${n.rawOwnMarkdown}\n${n.childHeadingsHtml}`;
			}
		});
	}

	private hasNodeUnreadDiff(node: SectionNode | null): boolean {
		if (!this.activeDiffContext || !node) return false;
		const info = this.activeDiffContext.slideDiffs.get(node.id);
		if (info?.hasChanges && !info.validatedByComment) return true;
		const inlineDels = this.activeDiffContext.inlineDeletedByParentId.get(node.id);
		return Boolean(inlineDels && inlineDels.length > 0);
	}

	private getDirtyNodeIdSet(): Set<string> {
		const set = new Set<string>();
		if (!this.activeDiffContext) return set;
		for (const [nodeId, info] of this.activeDiffContext.slideDiffs.entries()) {
			if (info.hasChanges && !info.validatedByComment) set.add(nodeId);
		}
		for (const [parentId, items] of this.activeDiffContext.inlineDeletedByParentId.entries()) {
			if (items.length > 0) set.add(parentId);
		}
		return set;
	}

	private recomputeDescendantDirtyNodeIds(ctx: NoteDiffContext): void {
		ctx.descendantDirtyNodeIds = new Set<string>();
		for (const n of this.flatNodes) {
			if (this.hasNodeUnreadDiff(n)) {
				let p = n.parent;
				while (p) {
					ctx.descendantDirtyNodeIds.add(p.id);
					p = p.parent;
				}
			}
		}
	}

	/**
	 * Removes a validated virtual deleted slide from the tree & flatNodes while reparenting
	 * any remaining children (e.g. deleted H3s under a deleted H2) so no zombie parent exists.
	 * Returns the forward next slide in presentation order (never jumps backwards to Slide 1).
	 */
	private removeVirtualDeletedNode(node: SectionNode): {
		nextNode: SectionNode | null;
		movedForward: boolean;
	} {
		const removedIdx = this.flatNodes.findIndex((n) => n.id === node.id);
		const parent = node.parent;

		if (parent) {
			const childIdx = parent.children.findIndex((c) => c.id === node.id);
			const promotedChildren = node.children.filter((c) => c.id !== node.id);
			for (const ch of promotedChildren) {
				ch.parent = parent;
			}
			if (childIdx !== -1) {
				parent.children.splice(childIdx, 1, ...promotedChildren);
			} else {
				parent.children = parent.children.filter((c) => c.id !== node.id);
				parent.children.push(...promotedChildren);
			}
			parent.childHeadingsHtml = buildChildHeadingsHtml(parent.children, false);
			parent.contentMarkdown =
				parent.children.length > 0
					? `${parent.rawOwnMarkdown}\n${parent.childHeadingsHtml}`
					: parent.rawOwnMarkdown;
		}

		this.flatNodes = this.flatNodes.filter((n) => n.id !== node.id);
		this.flatNodes.forEach((n, idx) => {
			n.flatIndex = idx;
		});

		const minValidIdx = this.flatNodes.length > 1 ? 1 : 0;
		for (let i = Math.max(minValidIdx, removedIdx); i < this.flatNodes.length; i++) {
			if (!this.isSkippedEmptySlide(this.flatNodes[i])) {
				return { nextNode: this.flatNodes[i], movedForward: true };
			}
		}
		for (let i = Math.min(removedIdx - 1, this.flatNodes.length - 1); i >= minValidIdx; i--) {
			if (!this.isSkippedEmptySlide(this.flatNodes[i])) {
				return { nextNode: this.flatNodes[i], movedForward: false };
			}
		}
		return { nextNode: this.flatNodes[0] || null, movedForward: false };
	}

	/**
	 * When leaving a slide that was already validated by a comment (where we kept the diff
	 * visually rendered only while still on that slide), finalize clearing its visual diff.
	 */
	private finalizeCommentValidatedNode(prevNode: SectionNode): void {
		const ctx = this.activeDiffContext;
		if (!ctx) return;

		const slideDiff = ctx.slideDiffs.get(prevNode.id);
		if (!slideDiff || !slideDiff.validatedByComment) return;

		slideDiff.hasChanges = false;
		slideDiff.validatedByComment = false;
		slideDiff.diffMarkdown = slideDiff.rawNewMarkdown;
		slideDiff.rawOldMarkdown = slideDiff.rawNewMarkdown;
		slideDiff.addedCount = 0;
		slideDiff.removedCount = 0;

		if (prevNode.isVirtualDeleted) {
			ctx.deletedSections = ctx.deletedSections.filter((d) => d.id !== prevNode.id);
			this.removeVirtualDeletedNode(prevNode);
		}

		this.recomputeDescendantDirtyNodeIds(ctx);
		if (ctx.totalDirtySlides === 0 && ctx.deletedSections.length === 0) {
			this.activeDiffContext = null;
			this.diffEnabled = false;
		}
	}

	/**
	 * Syncs a restored parent DocumentStack frame's diffContext against the freshly reloaded
	 * `_agents/unread_baselines.json` so already-validated diffs are never resurrected on pop.
	 */
	private reconcileActiveDiffWithBaselines(): void {
		const ctx = this.activeDiffContext;
		if (!ctx) return;

		const freshEntry = this.baselinesStore.getNoteEntry(this.activeSourcePath);
		if (!freshEntry) {
			const virtualNodes = this.flatNodes.filter((n) => n.isVirtualDeleted);
			for (const vn of virtualNodes) {
				const res = this.removeVirtualDeletedNode(vn);
				if (this.currentNode?.id === vn.id && res.nextNode) {
					this.currentNode = res.nextNode;
				}
			}
			this.activeDiffContext = null;
			this.diffEnabled = false;
			return;
		}

		const seen = freshEntry.seenSlides || {};
		const newlyClearedKeys = new Set<string>();
		const clearedDeletedIds = new Set<string>();

		for (const n of [...this.flatNodes]) {
			const info = ctx.slideDiffs.get(n.id);
			if (info && info.hasChanges) {
				const rec = seen[info.slideKey];
				if (rec && rec.hash === info.currentHash) {
					info.hasChanges = false;
					info.validatedByComment = false;
					info.diffMarkdown = info.rawNewMarkdown;
					info.rawOldMarkdown = info.rawNewMarkdown;
					info.addedCount = 0;
					info.removedCount = 0;
					newlyClearedKeys.add(info.slideKey);
					if (n.isVirtualDeleted) {
						clearedDeletedIds.add(n.id);
						const res = this.removeVirtualDeletedNode(n);
						if (this.currentNode?.id === n.id && res.nextNode) {
							this.currentNode = res.nextNode;
						}
					}
				}
			}
		}

		for (const [parentId, items] of Array.from(ctx.inlineDeletedByParentId.entries())) {
			const remaining = items.filter((d) => {
				const rec = seen[d.slideKey];
				if (rec && rec.hash === d.hash) {
					newlyClearedKeys.add(d.slideKey);
					clearedDeletedIds.add(d.id);
					return false;
				}
				return true;
			});
			if (remaining.length === 0) {
				ctx.inlineDeletedByParentId.delete(parentId);
			} else {
				ctx.inlineDeletedByParentId.set(parentId, remaining);
			}
		}

		if (newlyClearedKeys.size > 0 || clearedDeletedIds.size > 0) {
			ctx.dirtySlideKeys = ctx.dirtySlideKeys.filter((k) => !newlyClearedKeys.has(k));
			ctx.totalDirtySlides = ctx.dirtySlideKeys.length;
			ctx.deletedSections = ctx.deletedSections.filter((d) => !clearedDeletedIds.has(d.id));
			this.recomputeDescendantDirtyNodeIds(ctx);
			if (ctx.totalDirtySlides === 0 && ctx.deletedSections.length === 0) {
				this.activeDiffContext = null;
				this.diffEnabled = false;
			}
		}
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

	private isNodeDeletionOnlyDiff(node: SectionNode): boolean {
		if (!this.activeDiffContext) return false;
		if (node.isVirtualDeleted) {
			const info = this.activeDiffContext.slideDiffs.get(node.id);
			return Boolean(info?.hasChanges && !info.validatedByComment);
		}
		const info = this.activeDiffContext.slideDiffs.get(node.id);
		const hasOwnUnread = Boolean(info?.hasChanges && !info.validatedByComment);
		const inlineDels = this.activeDiffContext.inlineDeletedByParentId.get(node.id) || [];

		if (hasOwnUnread && info) {
			return info.addedCount === 0 && info.removedCount > 0;
		}
		return inlineDels.length > 0;
	}

	private computeDeletionOnlyTOCSets(): {
		deletionOnlyNodeIds: Set<string>;
		descendantDeletionOnlyNodeIds: Set<string>;
	} {
		const deletionOnlyNodeIds = new Set<string>();
		const descendantDeletionOnlyNodeIds = new Set<string>();
		if (!this.activeDiffContext) {
			return { deletionOnlyNodeIds, descendantDeletionOnlyNodeIds };
		}

		const ancestorHasDirtyDesc = new Set<string>();
		const ancestorHasNonDeletionDesc = new Set<string>();

		for (const n of this.flatNodes) {
			if (!this.hasNodeUnreadDiff(n)) continue;
			const delOnly = this.isNodeDeletionOnlyDiff(n);
			if (delOnly) {
				deletionOnlyNodeIds.add(n.id);
			}
			let p = n.parent;
			while (p) {
				ancestorHasDirtyDesc.add(p.id);
				if (!delOnly) {
					ancestorHasNonDeletionDesc.add(p.id);
				}
				p = p.parent;
			}
		}

		for (const id of ancestorHasDirtyDesc) {
			if (!ancestorHasNonDeletionDesc.has(id)) {
				descendantDeletionOnlyNodeIds.add(id);
			}
		}

		return { deletionOnlyNodeIds, descendantDeletionOnlyNodeIds };
	}

	private isSkippedEmptySlide(node: SectionNode | null | undefined): boolean {
		if (!isHeadingOnlySkippedSlide(node) || !node) return false;
		if (this.diffEnabled && this.activeDiffContext) {
			const info = this.activeDiffContext.slideDiffs.get(node.id);
			// Keep an empty heading-only leaf navigable while diff mode still displays deleted body
			// content (including after commenting on it, until leaving the slide clears `hasChanges`).
			if (info && info.hasChanges && info.removedCount > 0) {
				return false;
			}
		}
		return true;
	}

	private resolveNavigableTarget(node: SectionNode | null): SectionNode | null {
		let curr = node;
		while (curr && this.isSkippedEmptySlide(curr) && curr.parent) {
			curr = curr.parent;
		}
		return curr;
	}

	private buildTOCVisualMeta(): TOCVisualMeta {
		const { deletionOnlyNodeIds, descendantDeletionOnlyNodeIds } = this.computeDeletionOnlyTOCSets();
		const skippedNodeIds = new Set<string>();
		for (const n of this.flatNodes) {
			if (this.isSkippedEmptySlide(n)) {
				skippedNodeIds.add(n.id);
			}
		}
		return {
			dirtyNodeIds: this.getDirtyNodeIdSet(),
			descendantDirtyNodeIds: this.activeDiffContext?.descendantDirtyNodeIds,
			deletionOnlyNodeIds,
			descendantDeletionOnlyNodeIds,
			commentCountByHeading: this.getCommentCountByHeadingForActiveNote(),
			showVirtualDeleted: this.diffEnabled,
			skippedNodeIds,
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

	private buildMergedChildHeadingsHtmlForDiff(
		node: SectionNode,
		inlineDels: DeletedSectionItem[]
	): string {
		if (inlineDels.length === 0) {
			return node.children.length > 0 ? buildChildHeadingsHtml(node.children, true) : "";
		}
		const entries: Array<{ normTitle: string; html: string }> = node.children.map((child) => ({
			normTitle: normalizeTitle(child.title),
			html: buildChildHeadingsHtml([child], true),
		}));

		for (const del of inlineDels) {
			const entry = {
				normTitle: normalizeTitle(del.title),
				html: buildInlineDeletedHeadingHtml(del),
			};
			if (del.prevSiblingNormTitle === null) {
				entries.splice(0, 0, entry);
			} else {
				const prevIdx = entries.findIndex((e) => e.normTitle === del.prevSiblingNormTitle);
				if (prevIdx !== -1) {
					entries.splice(prevIdx + 1, 0, entry);
				} else {
					entries.push(entry);
				}
			}
		}

		return entries.map((e) => e.html).join("\n");
	}

	private buildSlideRenderDecoration(node: SectionNode): SlideRenderDecoration {
		let overrideMarkdown: string | undefined = undefined;
		const slideDiff = this.activeDiffContext?.slideDiffs.get(node.id);

		if (this.diffEnabled && this.activeDiffContext) {
			const parts: string[] = [];
			if (slideDiff && slideDiff.hasChanges) {
				parts.push(slideDiff.diffMarkdown);
			} else {
				parts.push(node.rawOwnMarkdown);
			}
			const inlineDels = this.activeDiffContext.inlineDeletedByParentId.get(node.id) || [];
			if (node.children.length > 0 || inlineDels.length > 0) {
				const childHtml = this.buildMergedChildHeadingsHtmlForDiff(node, inlineDels);
				if (childHtml) {
					parts.push(childHtml);
				}
			}
			overrideMarkdown = parts.join("\n\n");
		}

		return { overrideMarkdown };
	}

	private updateCockpitUI() {
		if (!this.activeModal || !this.currentNode) return;
		const currentSlideComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);
		const hasNoteDiff = Boolean(
			this.activeDiffContext &&
				(this.activeDiffContext.totalDirtySlides > 0 ||
					this.activeDiffContext.deletedSections.length > 0 ||
					Array.from(this.activeDiffContext.slideDiffs.values()).some((s) => s.hasChanges))
		);
		this.activeModal.updateCockpitBar({
			hasNoteDiff,
			diffEnabled: this.diffEnabled,
			dirtySlidesCount: this.activeDiffContext?.totalDirtySlides || 0,
			currentSlideHasDiff: this.hasNodeUnreadDiff(this.currentNode),
			currentSlideCommentsCount: currentSlideComments.length,
			totalPendingCommentsCount: this.reviewStore.getCount(),
			directCliEnabled: this.settings.directCliEnabled,
		});
	}

	private isLinkAlreadyOpenInStack(targetFilePath: string, rawHref: string): boolean {
		const normTarget = normalizeVaultPath(targetFilePath);
		if (this.documentStack.some((frame) => normalizeVaultPath(frame.filePath) === normTarget)) {
			return true;
		}
		if (
			normTarget === normalizeVaultPath(this.activeSourcePath) &&
			!rawHref.includes("#")
		) {
			return true;
		}
		return false;
	}

	private applyCurrentSlideHighlights(): void {
		if (!this.activeModal || !this.currentNode) return;
		const slideComments = this.reviewStore.getForSlide(
			this.activeSourcePath,
			this.currentNode.title
		);
		this.activeModal.applyCommentHighlights(slideComments);
		this.slideCommentsRail?.update(slideComments);
		this.activeModal.decorateModifiedInternalLinks((href: string): InternalLinkVisualState => {
			let decoded = href;
			try {
				decoded = decodeURIComponent(href);
			} catch {
				decoded = href;
			}
			const targetFile = this.resolveLinkTargetFile(decoded, this.activeSourcePath);
			if (!targetFile || targetFile.extension.toLowerCase() !== "md") return "normal";
			if (this.isLinkAlreadyOpenInStack(targetFile.path, decoded)) {
				return "already-open";
			}
			return this.baselinesStore.hasUnreadBaseline(targetFile.path) ? "dirty" : "normal";
		});
		this.activeModal.decorateSlideHeadingDiffDots(this.currentNode, this.buildTOCVisualMeta());
	}

	/**
	 * Reads the authoritative, up-to-date Markdown bytes directly from disk unless the user
	 * currently has unsaved typing in an active Edit/Live Preview view of that exact file.
	 * Fixes Obsidian's stale hidden `view.editor.getValue()` buffer in Reading Mode when a note
	 * (such as `🎯 Projets.md`) is updated externally by scripts, agents, or Obsidian Sync.
	 */
	private async readFreshMarkdownForFile(
		file: TFile,
		activeView?: MarkdownView | null
	): Promise<string> {
		if (
			activeView &&
			activeView.file?.path === file.path &&
			activeView.getMode() === "source" &&
			Boolean((activeView as any).dirty)
		) {
			return activeView.editor.getValue();
		}
		try {
			return await this.app.vault.adapter.read(file.path);
		} catch {
			return await this.app.vault.read(file);
		}
	}

	private findMatchingNodeAfterReload(
		newFlatNodes: SectionNode[],
		prevNode: SectionNode | null
	): SectionNode | null {
		if (newFlatNodes.length === 0) return null;
		if (!prevNode) {
			return newFlatNodes.length > 1 ? newFlatNodes[1] : newFlatNodes[0];
		}
		if (prevNode.level === 0) {
			return newFlatNodes[0];
		}
		const prevNorm = normalizeTitle(prevNode.title);
		const exactMatch = newFlatNodes.find(
			(n) =>
				!n.isVirtualDeleted &&
				n.level === prevNode.level &&
				normalizeTitle(n.title) === prevNorm
		);
		if (exactMatch) return exactMatch;

		const titleOnlyMatch = newFlatNodes.find(
			(n) => !n.isVirtualDeleted && normalizeTitle(n.title) === prevNorm
		);
		if (titleOnlyMatch) return titleOnlyMatch;

		const fallbackIdx = Math.max(
			newFlatNodes.length > 1 ? 1 : 0,
			Math.min(prevNode.flatIndex ?? 1, newFlatNodes.length - 1)
		);
		return newFlatNodes[fallbackIdx] || newFlatNodes[0];
	}

	private attachLiveVaultWatcher(): void {
		this.detachLiveVaultWatcher();
		this.activeVaultModifyRef = this.app.vault.on("modify", (abstractFile) => {
			if (!this.activeModal || !(abstractFile instanceof TFile)) return;
			if (abstractFile.path !== this.activeSourcePath) return;
			if (this.liveReloadTimerId !== null) {
				window.clearTimeout(this.liveReloadTimerId);
			}
			this.liveReloadTimerId = window.setTimeout(() => {
				this.liveReloadTimerId = null;
				void this.reloadActiveNoteFromDiskIfChanged();
			}, 220);
		});
	}

	private detachLiveVaultWatcher(): void {
		if (this.liveReloadTimerId !== null) {
			window.clearTimeout(this.liveReloadTimerId);
			this.liveReloadTimerId = null;
		}
		if (this.activeVaultModifyRef) {
			this.app.vault.offref(this.activeVaultModifyRef);
			this.activeVaultModifyRef = null;
		}
	}

	private async reloadActiveNoteFromDiskIfChanged(): Promise<void> {
		if (!this.activeModal || !this.activeSourcePath) return;
		const abstractFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
		if (!(abstractFile instanceof TFile)) return;

		const freshMarkdown = await this.readFreshMarkdownForFile(abstractFile);
		if (!this.activeModal || abstractFile.path !== this.activeSourcePath) return;
		if (freshMarkdown === this.activeLoadedMarkdown) return;

		this.activeLoadedMarkdown = freshMarkdown;
		await this.baselinesStore.reload().catch(() => undefined);

		const parsed = parseMarkdownSections(freshMarkdown);
		const prevNode = this.currentNode;
		const prevDiffEnabled = this.diffEnabled;

		this.rootNode = parsed.root;
		this.flatNodes = parsed.flatNodes;

		const diffInit = await this.computeDiffForLoadedNote(
			abstractFile.path,
			freshMarkdown,
			this.flatNodes
		);
		this.activeDiffContext = diffInit.ctx;
		this.diffEnabled = diffInit.ctx ? prevDiffEnabled || diffInit.autoEnable : false;

		const matched = this.findMatchingNodeAfterReload(this.flatNodes, prevNode);
		this.currentNode = this.resolveNavigableTarget(matched) || matched || this.rootNode;

		if (this.activeModal && this.currentNode) {
			await this.activeModal.refreshSlideInPlace(
				this.currentNode,
				this.activeSourcePath,
				this.buildSlideRenderDecoration(this.currentNode)
			);
			this.updateSlideCounter();
			this.refreshAllActiveUI();
		}
	}

	private refreshAllActiveUI(): void {
		this.updateCockpitUI();
		this.applyCurrentSlideHighlights();
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes, this.buildTOCVisualMeta());
		}
		if (this.reviewDrawer?.isOpen()) {
			const wipBatches = this.reviewStore.getWipBatches();
			this.reviewDrawer.refresh(
				this.reviewStore.getAll(),
				wipBatches.length,
				this.reviewStore.getWipCommentCount()
			);
		}
		this.refreshAgySidebarViews();
	}

	/**
	 * Checks persisted WIP batches against live OS PIDs.
	 * If a WIP batch's PID no longer exists without a confirmed exit code 0 purge
	 * (e.g. process crashed/killed or Obsidian reloaded before exit), restores ONLY
	 * that batch's comments into the visible queue with a `failed` badge!
	 */
	private async reconcileOrphanWipBatches(): Promise<number> {
		const batches = this.reviewStore.getWipBatches();
		if (batches.length === 0) return 0;

		const trackedJobs = this.activeJobsTracker.getCachedJobs();
		const jobsById = new Map(trackedJobs.map((j) => [j.id, j]));

		let totalRestored = 0;
		let totalCompleted = 0;
		const nowMs = Date.now();

		for (const batch of batches) {
			// If actively monitored by this live Obsidian session, let its monitor handle completion
			if (this.liveOwnedJobIds.has(batch.jobId)) {
				continue;
			}

			const tracked = jobsById.get(batch.jobId);
			if (tracked?.backendMode === "hub" && tracked.conversationId) {
				const liveHub = await this.agyServer.getLiveHub();
				if (liveHub) {
					try {
						const conv = await getHubConversation(liveHub, tracked.conversationId);
						if (conv && (conv.runState === "RUN_STATE_RUNNING" || conv.runState === "RUN_STATE_CANCELLING")) {
							// Survived Obsidian reload cleanly — re-attach live monitor!
							this.attachHubJobMonitor(
								batch.jobId,
								tracked.conversationId,
								tracked.projectId || "",
								liveHub
							);
							continue;
						}
						if (conv && conv.runState === "RUN_STATE_IDLE") {
							const prog = readHubConversationLiveProgress(tracked.conversationId);
							if (prog.terminalState === "canceled" || prog.terminalState === "error") {
								const reason = prog.errorDetail || "Conversation interrompue dans Antigravity";
								const restoredCount = await this.reviewStore.restoreWipBatchAsFailed(batch.jobId, reason);
								await this.activeJobsTracker.completeJob(batch.jobId, 1, reason, {
									conversationId: tracked.conversationId,
									projectId: conv.projectId || tracked.projectId || undefined,
									instanceId: liveHub.instanceId || tracked.instanceId || undefined,
								});
								totalRestored += restoredCount;
							} else {
								const purged = await this.reviewStore.purgeWipBatch(batch.jobId);
								await this.activeJobsTracker.completeJob(batch.jobId, 0, null, {
									conversationId: tracked.conversationId,
									projectId: conv.projectId || tracked.projectId || undefined,
									instanceId: liveHub.instanceId || tracked.instanceId || undefined,
								});
								totalCompleted += purged;
							}
							continue;
						}
					} catch {
						// Hub briefly unreachable — give a grace window before marking failed
						const ageMs = nowMs - new Date(batch.startedAt).getTime();
						if (ageMs < 30_000) continue;
					}
				} else {
					const ageMs = nowMs - new Date(batch.startedAt).getTime();
					if (ageMs < 30_000) continue;
				}

				const reason = "Conversation Antigravity Hub interrompue ou introuvable après rechargement";
				const restoredCount = await this.reviewStore.restoreWipBatchAsFailed(batch.jobId, reason);
				await this.activeJobsTracker.completeJob(batch.jobId, -1, reason);
				totalRestored += restoredCount;
				continue;
			}

			// CLI process path: if the process is still alive in the OS (e.g. survived an Obsidian reload), keep it in WIP
			if (batch.pid && isPidAlive(batch.pid)) {
				continue;
			}

			// Grace window for brand-new batch waiting on spawn PID
			const ageMs = nowMs - new Date(batch.startedAt).getTime();
			if (!batch.pid && ageMs < 15000) {
				continue;
			}

			const reason = batch.pid
				? `PID ${batch.pid} ended without confirmed success (exit 0 not received)`
				: `${batch.cli} did not report a running PID`;
			const restoredCount = await this.reviewStore.restoreWipBatchAsFailed(batch.jobId, reason);
			await this.activeJobsTracker.completeJob(batch.jobId, -1, reason);
			totalRestored += restoredCount;
		}

		if (totalCompleted > 0) {
			void this.quotaTracker.refresh();
			this.refreshAllActiveUI();
		}

		if (totalRestored > 0) {
			this.refreshAllActiveUI();
			new Notice(
				`SlideFlow: ${totalRestored} WIP comment(s) restored as failed (process exited without confirmation). Ready to retry.`,
				9000
			);
		}

		return totalRestored;
	}

	private collectVirtualDeletedSubtree(node: SectionNode): SectionNode[] {
		const collected: SectionNode[] = [];
		const visit = (children: SectionNode[]) => {
			for (const ch of children) {
				if (ch.isVirtualDeleted) {
					collected.push(ch);
					if (ch.children.length > 0) {
						visit(ch.children);
					}
				}
			}
		};
		visit(node.children);
		return collected;
	}

	private async markCurrentSlideDiffRead(
		clearVisuallyNow: boolean
	): Promise<"validated" | "jumped_deleted_child" | "none"> {
		const ctx = this.activeDiffContext;
		const node = this.currentNode;
		if (!ctx || !node) return "none";

		const slideDiff = ctx.slideDiffs.get(node.id);
		const inlineDels = ctx.inlineDeletedByParentId.get(node.id) || [];
		const itemsToMark: Array<{ slideKey: string; text: string }> = [];

		const shouldMarkSlide = Boolean(
			slideDiff && slideDiff.hasChanges && (clearVisuallyNow || !slideDiff.validatedByComment)
		);
		if (shouldMarkSlide && slideDiff) {
			itemsToMark.push({
				slideKey: slideDiff.slideKey,
				text: slideDiff.rawNewMarkdown,
			});
		}
		for (const del of inlineDels) {
			itemsToMark.push({
				slideKey: del.slideKey,
				text: "",
			});
		}

		// When validating a non-deleted slide with Ctrl+Enter (`clearVisuallyNow`), ALSO atomically
		// validate any virtual deleted child headings visibly rendered as `<del>` on this slide so
		// pressing Ctrl+Enter on a slide with additions + deletions clears BOTH cleanly in one shot.
		const virtualDelSubtree: SectionNode[] =
			clearVisuallyNow && this.diffEnabled && !node.isVirtualDeleted
				? this.collectVirtualDeletedSubtree(node)
				: [];
		const virtualDelToClear: SectionNode[] = [];
		for (const vChild of virtualDelSubtree) {
			const vInfo = ctx.slideDiffs.get(vChild.id);
			if (vInfo && vInfo.hasChanges) {
				itemsToMark.push({
					slideKey: vInfo.slideKey,
					text: "",
				});
				virtualDelToClear.push(vChild);
			}
		}

		// Also atomically validate any skipped heading-only leaf children rendered inside this parent slide
		const skippedChildrenToClear: SectionNode[] = [];
		if (clearVisuallyNow && !node.isVirtualDeleted && node.children.length > 0) {
			for (const ch of node.children) {
				if (!this.isSkippedEmptySlide(ch)) continue;
				const chInfo = ctx.slideDiffs.get(ch.id);
				if (chInfo && chInfo.hasChanges && !chInfo.validatedByComment) {
					itemsToMark.push({
						slideKey: chInfo.slideKey,
						text: chInfo.rawNewMarkdown,
					});
					skippedChildrenToClear.push(ch);
				}
			}
		}

		if (itemsToMark.length === 0) {
			return "none";
		}

		await this.baselinesStore.markSlidesSeen(
			this.activeSourcePath,
			itemsToMark,
			ctx.dirtySlideKeys,
			ctx.currentHashesByKey,
			null
		);

		const markedKeys = new Set(itemsToMark.map((i) => i.slideKey));
		const markedInlineIds = new Set(inlineDels.map((d) => d.id));
		const markedVirtualIds = new Set(virtualDelToClear.map((v) => v.id));

		// Always update logical unread tracking immediately (even on comment validation!)
		// so TOC dots clear and `N` NEVER wraps backwards to an already-seen/commented slide.
		if (inlineDels.length > 0) {
			ctx.inlineDeletedByParentId.delete(node.id);
		}
		ctx.dirtySlideKeys = ctx.dirtySlideKeys.filter((k) => !markedKeys.has(k));
		ctx.totalDirtySlides = ctx.dirtySlideKeys.length;
		ctx.deletedSections = ctx.deletedSections.filter(
			(d) =>
				!markedInlineIds.has(d.id) &&
				!markedVirtualIds.has(d.id) &&
				(!clearVisuallyNow || d.id !== node.id)
		);

		if (clearVisuallyNow) {
			if (slideDiff && slideDiff.hasChanges) {
				slideDiff.hasChanges = false;
				slideDiff.validatedByComment = false;
				slideDiff.diffMarkdown = slideDiff.rawNewMarkdown;
				slideDiff.rawOldMarkdown = slideDiff.rawNewMarkdown;
				slideDiff.addedCount = 0;
				slideDiff.removedCount = 0;
			}

			for (const vChild of virtualDelToClear) {
				const vInfo = ctx.slideDiffs.get(vChild.id);
				if (vInfo) {
					vInfo.hasChanges = false;
					vInfo.validatedByComment = false;
					vInfo.diffMarkdown = "";
					vInfo.rawOldMarkdown = "";
					vInfo.addedCount = 0;
					vInfo.removedCount = 0;
				}
			}
			for (const sChild of skippedChildrenToClear) {
				const sInfo = ctx.slideDiffs.get(sChild.id);
				if (sInfo) {
					sInfo.hasChanges = false;
					sInfo.validatedByComment = false;
					sInfo.diffMarkdown = sInfo.rawNewMarkdown;
					sInfo.rawOldMarkdown = sInfo.rawNewMarkdown;
					sInfo.addedCount = 0;
					sInfo.removedCount = 0;
				}
			}
			if (virtualDelToClear.length > 0) {
				node.children = node.children.filter((c) => !markedVirtualIds.has(c.id));
				node.childHeadingsHtml = buildChildHeadingsHtml(node.children, false);
				node.contentMarkdown =
					node.children.length > 0
						? `${node.rawOwnMarkdown}\n${node.childHeadingsHtml}`
						: node.rawOwnMarkdown;
				this.flatNodes = this.flatNodes.filter((n) => !markedVirtualIds.has(n.id));
				this.flatNodes.forEach((n, idx) => {
					n.flatIndex = idx;
				});
			}

			let jumpTargetAfterDelete: SectionNode | null = null;
			let jumpDirection: "next" | "prev" = "next";
			if (node.isVirtualDeleted) {
				const removed = this.removeVirtualDeletedNode(node);
				jumpTargetAfterDelete = removed.nextNode;
				jumpDirection = removed.movedForward ? "next" : "prev";
			}

			this.recomputeDescendantDirtyNodeIds(ctx);

			if (ctx.totalDirtySlides === 0 && ctx.deletedSections.length === 0) {
				this.activeDiffContext = null;
				this.diffEnabled = false;
			}

			if (jumpTargetAfterDelete) {
				await this.goToNode(jumpTargetAfterDelete, jumpDirection, "start");
			} else if (this.activeModal) {
				await this.activeModal.refreshSlideInPlace(
					node,
					this.activeSourcePath,
					this.buildSlideRenderDecoration(node)
				);
				this.updateSlideCounter();
				this.refreshAllActiveUI();
			} else {
				this.updateSlideCounter();
				this.refreshAllActiveUI();
			}
		} else {
			// Validated via comment: keep visual diff on the current slide only until leaving it,
			// so the user can still add a second comment on the same diff without losing context.
			if (slideDiff && slideDiff.hasChanges) {
				slideDiff.validatedByComment = true;
			}
			this.recomputeDescendantDirtyNodeIds(ctx);
		}

		return "validated";
	}

	/**
	 * Immediately validates all unread diffs of the currently displayed note in one click,
	 * purging its entry from `_agents/unread_baselines.json`, removing any virtual deleted
	 * slides from the active tree, and refreshing the current slide & TOC cleanly.
	 */
	private async validateAllNoteDiffs(): Promise<void> {
		const hadContext = Boolean(this.activeDiffContext);
		const hadBaseline = this.activeSourcePath
			? this.baselinesStore.hasUnreadBaseline(this.activeSourcePath)
			: false;
		if (!hadContext && !hadBaseline) {
			new Notice("No unread diffs in this note.");
			return;
		}

		if (this.activeSourcePath) {
			await this.baselinesStore.markEntireNoteRead(this.activeSourcePath);
		}

		const prevNode = this.currentNode;
		const prevIdx = prevNode ? this.flatNodes.findIndex((n) => n.id === prevNode.id) : 0;
		const wasOnVirtualDeleted = Boolean(prevNode?.isVirtualDeleted);

		const virtualNodes = this.flatNodes
			.filter((n) => n.isVirtualDeleted)
			.sort((a, b) => b.level - a.level);
		for (const vn of virtualNodes) {
			this.removeVirtualDeletedNode(vn);
		}

		this.activeDiffContext = null;
		this.diffEnabled = false;

		let targetNode: SectionNode | null = prevNode;
		const stillExists = Boolean(targetNode && this.flatNodes.some((n) => n.id === targetNode!.id));
		if (wasOnVirtualDeleted || !stillExists || (targetNode && this.isSkippedEmptySlide(targetNode))) {
			const minValidIdx = this.flatNodes.length > 1 ? 1 : 0;
			let picked: SectionNode | null = null;
			for (let i = Math.max(minValidIdx, prevIdx); i < this.flatNodes.length; i++) {
				if (!this.isSkippedEmptySlide(this.flatNodes[i])) {
					picked = this.flatNodes[i];
					break;
				}
			}
			if (!picked) {
				for (let i = Math.min(prevIdx - 1, this.flatNodes.length - 1); i >= minValidIdx; i--) {
					if (!this.isSkippedEmptySlide(this.flatNodes[i])) {
						picked = this.flatNodes[i];
						break;
					}
				}
			}
			targetNode = picked || this.flatNodes[0] || this.rootNode;
		}

		if (targetNode && targetNode !== prevNode) {
			await this.goToNode(targetNode, "next", "start");
		} else if (this.activeModal && this.currentNode) {
			await this.activeModal.refreshSlideInPlace(
				this.currentNode,
				this.activeSourcePath,
				this.buildSlideRenderDecoration(this.currentNode)
			);
			this.updateSlideCounter();
			this.refreshAllActiveUI();
		} else {
			this.updateSlideCounter();
			this.refreshAllActiveUI();
		}

		new Notice("All diffs in this note validated.");
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

		const markdownText = await this.readFreshMarkdownForFile(file, view);
		if (!markdownText.trim()) {
			new Notice("Empty note: cannot start SlideFlow.");
			return;
		}
		this.activeLoadedMarkdown = markdownText;

		await Promise.all([
			this.baselinesStore.reload().catch((err) => {
				console.error("[SlideFlow] Failed reading unread_baselines.json:", err);
				new Notice(`SlideFlow: failed reading baselines (${err.message})`);
			}),
			this.reviewStore
				.loadFromDisk()
				.then(() => this.reconcileOrphanWipBatches())
				.catch((err) => {
					console.error("[SlideFlow] Failed reading pending_reviews.json:", err);
				}),
		]);

		void this.voiceService.prewarmServer();

		this.documentStack = [];
		this.activeSourcePath = file.path;
		this.sessionRootProjectPath = file.path;

		// Parse headings directly from the freshly read file bytes (never stale metadataCache)
		const parsed = parseMarkdownSections(markdownText);

		if (parsed.error === "no_headings") {
			new Notice("Note without headings: presenting as a single slide.");
		}

		this.rootNode = parsed.root;
		this.flatNodes = parsed.flatNodes;
		const cursorLine = view.getMode() === "source" ? view.editor.getCursor().line : 0;
		const hasPreamble =
			this.flatNodes.length > 1 &&
			hasSubstantivePreamble(markdownText, this.flatNodes[1].lineStart);
		this.currentNode = findCurrentSectionNode(this.flatNodes, cursorLine);
		if (this.currentNode && this.currentNode.level === 0 && this.flatNodes.length > 1 && !hasPreamble) {
			this.currentNode = this.flatNodes[1];
		}

		const diffInit = await this.computeDiffForLoadedNote(file.path, markdownText, this.flatNodes);
		this.activeDiffContext = diffInit.ctx;
		this.diffEnabled = diffInit.autoEnable;
		this.currentNode = this.resolveNavigableTarget(this.currentNode) || this.currentNode || this.rootNode;

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
			this.slideCommentsRail?.trackLayoutTransition(380);
		};
		this.activeModal.onLinkClickCallback = (href: string) => {
			void this.handleInternalLinkClick(href);
		};
		this.activeModal.onExternalPdfLinkClickCallback = (href: string) => {
			void this.handleExternalPdfLinkClick(href);
		};
		this.activeModal.onChildHeadingClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode && !this.isSkippedEmptySlide(targetNode)) {
				void this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onSectionClickCallback = (nodeId: string) => {
			const targetNode = this.flatNodes.find(n => n.id === nodeId);
			if (targetNode && !this.isSkippedEmptySlide(targetNode)) {
				void this.goToNode(targetNode, 'zoom-in', 'start');
			}
		};
		this.activeModal.onToggleDiffClickCallback = () => this.toggleDiffMode();
		this.activeModal.onValidateAllDiffsClickCallback = () => void this.validateAllNoteDiffs();
		this.activeModal.onCommentTextClickCallback = () => this.openCommentModal(false);
		this.activeModal.onCommentVoiceClickCallback = () => this.openCommentModal(true);
		this.activeModal.onToggleHighlightClickCallback = () => void this.toggleMarkdownHighlight();
		this.activeModal.onOpenQueueClickCallback = () => this.toggleReviewDrawer();
		this.activeModal.onCopyOneShotClickCallback = () => void this.handleSlideCtrlEnter();
		this.activeModal.onSelectionCommentCallback = (range: Range, startWithVoice: boolean) => {
			this.openCommentModal(startWithVoice, range);
		};
		this.activeModal.onSelectionHighlightCallback = (range: Range) => {
			void this.toggleMarkdownHighlight(range);
		};
		this.activeModal.onHighlightCommentClickCallback = (commentId: string, anchorRect: AnchorRect) => {
			this.openEditCommentById(commentId, anchorRect);
		};
		this.activeModal.onMediaZoomOpenedCallback = () => {
			this.slideCommentsRail?.hidePopoverImmediate();
			this.slideCommentsRail?.setHoveredBlock(null);
			this.applyCurrentSlideHighlights();
		};
		this.activeModal.onMediaZoomClosedCallback = () => {
			this.slideCommentsRail?.positionRail();
		};
		this.activeModal.onHoveredBlockChangeCallback = (blockEl: HTMLElement | null) => {
			if (blockEl) {
				this.slideCommentsRail?.setHoveredBlock(blockEl);
			} else {
				this.slideCommentsRail?.setHoveredBlock(
					this.activeModal?.getReadingFocusBlockElement() || null
				);
			}
		};
		this.activeModal.onReadingFocusChangeCallback = (blockEl: HTMLElement | null) => {
			if (!this.activeModal?.getHoveredBlockElement()) {
				this.slideCommentsRail?.setHoveredBlock(blockEl);
			}
		};

		const overlayEl = this.activeModal.getOverlayElement();
		this.exitConfirmModal = new ConfirmOverlayModal(overlayEl);

		this.slideCommentsRail = new SlideCommentsRail(overlayEl, {
			onEditComment: (comment: ReviewComment, anchorRect?: AnchorRect | null) => {
				this.openEditCommentById(comment.id, anchorRect);
			},
			onDeleteComment: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.refreshAllActiveUI();
				new Notice("Comment deleted.");
			},
			onAddBlockComment: (blockEl: HTMLElement) => {
				this.openCommentModal(false, null, blockEl);
			},
			onHoverAddEnter: () => {
				this.activeModal?.cancelHoverClear();
			},
			onHoverAddLeave: () => {
				this.activeModal?.scheduleHoverClear();
			},
			getSlideContainer: () => {
				if (!this.activeModal) return null;
				return this.activeModal.getContentElement();
			},
		});

		this.commentModal = new CommentOverlayModal(overlayEl, this.voiceService, {
			onSubmit: async (
				commentText: string,
				editingId?: string,
				images?: CommentImageAttachment[]
			) => {
				this.activeModal?.setActiveCommentBlock(null);
				await this.saveSlideComment(commentText, editingId, images);
				this.slideCommentsRail?.trackLayoutTransition(420);
			},
			onDeleteExisting: async (commentId: string) => {
				await this.reviewStore.deleteComment(commentId);
				this.refreshAllActiveUI();
				this.slideCommentsRail?.trackLayoutTransition(420);
			},
			onClose: () => {
				this.pendingCommentContext = null;
				this.activeModal?.setActiveCommentBlock(null);
				this.slideCommentsRail?.trackLayoutTransition(420);
			},
		});

		this.reviewDrawer = new ReviewDrawer(overlayEl, {
			onAddGeneralComment: async (commentText: string) => {
				const trimmed = commentText.trim();
				if (!trimmed) return null;
				const created = await this.reviewStore.addComment({
					projectRootPath: this.sessionRootProjectPath,
					notePath: GENERAL_NOTE_PATH,
					noteTitle: "General",
					sectionHeading: "General",
					sectionLevel: 0,
					lineStart: 0,
					lineEnd: 0,
					scopeType: "general",
					scopeLabel: "General",
					excerpt: "",
					hadDiff: false,
					commentText: trimmed,
				});
				this.refreshAllActiveUI();
				return created;
			},
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
					const launched = await this.sendPendingCommentsToCli();
					if (launched) {
						this.reviewDrawer?.close(false);
					}
				} else {
					await this.copyPendingCommentsExport(true);
					const wipBatches = this.reviewStore.getWipBatches();
					this.reviewDrawer?.refresh(
						this.reviewStore.getAll(),
						wipBatches.length,
						this.reviewStore.getWipCommentCount()
					);
				}
			},
			onCopyAndDiscard: async () => {
				const copied = await this.copyAndDiscardPendingComments();
				if (copied) {
					this.reviewDrawer?.close(false);
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
		this.tocComp.onToggleCallback = () => {
			this.slideCommentsRail?.trackLayoutTransition(420);
		};
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
			onTab: (shiftKey: boolean) => this.handleTabKey(shiftKey),
			onEnter: () => this.handleEnterKey(),
			onEscape: () => this.handleEscapeKey(),
			onZoomIn: () => this.activeModal?.zoomIn(),
			onZoomOut: () => this.activeModal?.zoomOut(),
			onZoomReset: () => this.activeModal?.resetZoom(),
			onResetZoom: () => this.activeModal?.resetZoom(),
			onOpenCommentText: () => this.openCommentModal(false),
			onOpenCommentVoice: () => this.openCommentModal(true),
			onToggleHighlight: () => void this.toggleMarkdownHighlight(),
			onToggleDiff: () => this.toggleDiffMode(),
			onNextDiffSlide: () => this.jumpToNextDiffSlide(),
			onToggleReviewDrawer: () => this.toggleReviewDrawer(),
			onOpenGeneralComment: () => this.openReviewDrawerForGeneralComment(),
			onCopyOneShot: () => void this.handleSlideCtrlEnter(),
			isInputBlocked: () =>
				Boolean(
					this.commentModal?.isOpen() ||
						this.reviewDrawer?.isOpen() ||
						this.exitConfirmModal?.isOpen()
				),
		});
		this.keyboardNav.attach();
		this.attachLiveVaultWatcher();
	}

	private handleTabKey(shiftKey: boolean): boolean {
		if (!this.activeModal) return false;
		if (this.activeModal.isTableZoomActive() && this.activeModal.hasZoomTableRowSelection()) {
			this.activeModal.stepZoomTableFocusedLink(shiftKey ? "prev" : "next");
			return true;
		}
		if (!this.activeModal.isReadingFocusActive()) {
			return false;
		}
		this.activeModal.stepFocusedLink(shiftKey ? "prev" : "next");
		return true;
	}

	private handleEnterKey(): boolean {
		if (!this.activeModal) return false;
		if (this.activeModal.isTableZoomActive() && this.activeModal.hasZoomTableRowSelection()) {
			return this.activeModal.activateZoomTableRowLink();
		}
		return this.activeModal.activateReadingFocusLink();
	}

	private handleEscapeKey() {
		if (this.activeModal?.isTableZoomActive()) {
			if (this.activeModal.hasZoomTableFocusedLink()) {
				this.activeModal.clearZoomTableFocusedLink();
				return;
			}
			if (this.activeModal.hasZoomTableRowSelection()) {
				this.activeModal.clearTableZoomRowSelection();
				return;
			}
		}
		if (this.activeModal?.isMediaZoomActive()) {
			this.activeModal.closeMediaZoom(true);
			return;
		}
		if (this.activeModal?.hasFocusedLink()) {
			this.activeModal.clearFocusedLink();
			return;
		}
		if (this.activeModal?.isReadingFocusActive()) {
			this.activeModal.clearReadingFocus();
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
	 *   Esc or click "Exit & Keep" to close while keeping comments saved, or click outside modal to return.
	 * - Clipboard mode: if uncopied comments exist, prompts Ctrl+Enter to copy & exit,
	 *   Esc or click "Exit & Keep" to close while keeping comments saved, or click outside modal to return.
	 */
	private requestClosePresentation(): void {
		if (!this.exitConfirmModal) {
			this.closePresentation();
			return;
		}

		if (this.settings.directCliEnabled) {
			if (!this.reviewStore.hasUnsentComments()) {
				this.closePresentation();
				return;
			}
			const unsentCount = this.reviewStore.getCount();
			const cliName = getCliDisplayName(this.settings.directCliCommand);
			const sessions = partitionCommentsForCliSessions(this.reviewStore.getAll());
			const sessionNote =
				sessions.length > 1
					? ` across ${sessions.length} separate ${cliName} sessions`
					: ` to ${cliName}`;

			this.exitConfirmModal.open({
				title: `Unsent comments (${unsentCount})`,
				message: `Send ${unsentCount} review comment${unsentCount > 1 ? "s" : ""}${sessionNote} before closing? Comments move to background WIP and purge automatically on success (or reappear as failed on error).`,
				confirmLabelHtml: `Send & Exit <strong>Ctrl+↵</strong>`,
				confirmVariant: "primary",
				confirmShortcut: "Ctrl+Enter",
				hideCancelButton: true,
				discardLabelHtml: `Exit & Keep <strong>Esc</strong>`,
				escapeAction: "discard",
				extraActionLabel: "Copy & Discard",
				extraActionTitle:
					"Copy all comments as XML (/one-shot) to clipboard, clear the queue, and exit (click only)",
				extraActionVariant: "secondary",
				onConfirm: async () => {
					const launched = await this.sendPendingCommentsToCli();
					if (launched) {
						this.closePresentation();
					}
				},
				onCancel: () => {
					// Backdrop click: stay in presentation
				},
				onDiscard: () => {
					this.closePresentation();
				},
				onExtraAction: async () => {
					const copied = await this.copyAndDiscardPendingComments();
					if (copied) {
						this.closePresentation();
					}
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
			hideCancelButton: true,
			discardLabelHtml: `Exit & Keep <strong>Esc</strong>`,
			escapeAction: "discard",
			onConfirm: async () => {
				await this.copyPendingCommentsExport(true);
				this.closePresentation();
			},
			onCancel: () => {
				// Backdrop click: stay in presentation
			},
			onDiscard: () => {
				// Exit cleanly without deleting persisted comments
				this.closePresentation();
			},
		});
	}

	private async handleSlideCtrlEnter(): Promise<void> {
		const status = await this.markCurrentSlideDiffRead(true);
		if (status === "jumped_deleted_child") {
			new Notice("Inspecting deleted subsection — press Ctrl+Enter to validate.");
			return;
		}
		const validatedDiff = status === "validated";

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
		if (!this.activeDiffContext || this.activeDiffContext.totalDirtySlides === 0) {
			new Notice("No unread diff on this note.");
			return;
		}
		this.diffEnabled = !this.diffEnabled;
		if (!this.diffEnabled && this.currentNode?.isVirtualDeleted) {
			const fallback =
				this.currentNode.parent ||
				this.flatNodes.find((n) => !n.isVirtualDeleted && n.level > 0) ||
				this.flatNodes[0];
			if (fallback) {
				void this.goToNode(fallback, "zoom-out", "start");
				new Notice("Diff view hidden");
				return;
			}
		}
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

	/**
	 * Extracts visible plain text from a DOM Range or element while stripping deleted diff spans,
	 * UI badges, and hidden MathJax/KaTeX assistive duplicates so Markdown matching stays exact.
	 */
	private extractCleanHighlightText(source: Range | HTMLElement): string {
		const wrapper = document.createElement("div");
		if (source instanceof Range) {
			wrapper.appendChild(source.cloneContents());
		} else {
			wrapper.appendChild(source.cloneNode(true));
		}
		wrapper
			.querySelectorAll(
				"del, .dv-del, .dv-block-del, .dv-pre-del, .slideflow-deleted-sections, .slideflow-link-dirty-badge, .slideflow-heading-diff-dot, .copy-code-button, .slideflow-table-selector-bar, mjx-assistive-mml, .katex-mathml, .MJX_Assistive_MathML"
			)
			.forEach((el) => el.remove());

		const blockTags = new Set(["p", "li", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);
		const parts: string[] = [];
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				parts.push(node.textContent || "");
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node as HTMLElement;
			const tag = el.tagName.toLowerCase();
			if (tag === "br") {
				parts.push("\n");
				return;
			}
			if (tag === "td" || tag === "th") {
				for (const ch of Array.from(el.childNodes)) walk(ch);
				parts.push(" ");
				return;
			}
			const isBlock = blockTags.has(tag);
			if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
				parts.push("\n");
			}
			for (const ch of Array.from(el.childNodes)) walk(ch);
			if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
				parts.push("\n");
			}
		};
		walk(wrapper);
		return parts
			.join("")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{2,}/g, "\n")
			.trim();
	}

	/**
	 * Toggles persistent Obsidian Markdown highlighting (`==...==`) directly in the source note
	 * for the active selection, zoomed table row/table, or focused/hovered reading block (`H`).
	 */
	private async toggleMarkdownHighlight(explicitRange?: Range | null): Promise<void> {
		if (!this.activeModal || !this.currentNode || !this.activeSourcePath) return;
		if (this.currentNode.isVirtualDeleted) {
			new Notice("Cannot highlight a deleted section.");
			return;
		}

		const abstractFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
		if (!(abstractFile instanceof TFile)) {
			new Notice("Active note file not found.");
			return;
		}

		const activeRange = explicitRange ?? this.activeModal.getActiveSelectionRange();
		let target: BlockHighlightTarget | null = null;

		if (activeRange) {
			const ancestorEl =
				activeRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
					? (activeRange.commonAncestorContainer as HTMLElement)
					: activeRange.commonAncestorContainer.parentElement;
			if (ancestorEl?.closest("del, .dv-del, .dv-block-del, .dv-pre-del, .slideflow-deleted-sections")) {
				new Notice("Cannot highlight deleted diff text.");
				return;
			}
			if (ancestorEl?.closest("pre")) {
				new Notice("Markdown ==highlight== is not supported inside code blocks.");
				return;
			}
			const activeContainer = this.activeModal.isMediaZoomActive()
				? this.activeModal.getZoomContentElement()
				: this.activeModal.getContentElement();
			const anchor = activeContainer
				? captureSelectionAnchorSnippet(activeRange, activeContainer)
				: { selectionQuote: "", selectionPrefix: "", selectionSuffix: "" };
			const cleanText = this.extractCleanHighlightText(activeRange);
			if (!cleanText) {
				new Notice("Selection has no highlightable text.");
				return;
			}
			this.activeModal.hideSelectionToolbar(true);
			window.getSelection()?.removeAllRanges();
			target = {
				kind: "selection",
				plainText: cleanText,
				prefixText: anchor.selectionPrefix,
				suffixText: anchor.selectionSuffix,
			};
		} else if (this.activeModal.isTableZoomActive()) {
			const tableIndex = this.activeModal.getActiveTableIndexInSlide();
			const rowEl = this.activeModal.getZoomTableRowElement();
			if (rowEl) {
				target = {
					kind: "table_row",
					tableIndex,
					rowIndex: this.activeModal.getZoomTableRowIndex(),
					plainText: this.extractCleanHighlightText(rowEl),
				};
			} else {
				const tableEl = this.activeModal.getZoomTableElement();
				if (tableEl) {
					target = {
						kind: "table",
						tableIndex,
						plainText: this.extractCleanHighlightText(tableEl),
					};
				}
			}
		} else if (this.activeModal.isMediaZoomActive()) {
			new Notice("Highlight (H) applies to text selections, blocks, and tables.");
			return;
		} else {
			const blockEl =
				this.activeModal.getReadingFocusBlockElement() ??
				this.activeModal.getHoveredBlockElement();
			if (!blockEl) {
				new Notice("Select text or focus a block (↑/↓) before pressing H to highlight.");
				return;
			}
			if (
				blockEl.classList.contains("dv-block-del") ||
				blockEl.classList.contains("is-deleted-child-heading") ||
				blockEl.classList.contains("is-inline-deleted-heading") ||
				Boolean(blockEl.closest(".dv-block-del, .slideflow-deleted-sections"))
			) {
				new Notice("Cannot highlight deleted diff content.");
				return;
			}
			if (blockEl.classList.contains("dynamic-slides-child-heading")) {
				new Notice("Open the subsection to highlight its content.");
				return;
			}
			const tag = blockEl.tagName.toLowerCase();
			if (tag === "table") {
				const allTables = Array.from(
					this.activeModal.getContentElement().querySelectorAll<HTMLTableElement>("table")
				);
				const tableIndex = Math.max(0, allTables.indexOf(blockEl as HTMLTableElement));
				target = {
					kind: "table",
					tableIndex,
					plainText: this.extractCleanHighlightText(blockEl),
					tagName: "table",
				};
			} else {
				target = {
					kind: "block",
					tagName: tag,
					plainText: this.extractCleanHighlightText(blockEl),
				};
			}
		}

		if (!target || !target.plainText) {
			new Notice("Nothing highlightable at the current target.");
			return;
		}

		const freshMarkdown = await this.readFreshMarkdownForFile(abstractFile);
		const result = toggleMarkdownHighlightInSection(
			freshMarkdown,
			this.currentNode.lineStart,
			this.currentNode.lineEnd,
			target
		);

		if (!result.changed) {
			new Notice(result.reason || "Could not toggle Markdown highlight.");
			return;
		}

		// Record changed lines so an active unread baseline stays in sync with Henri's manual highlight
		const lineReplacements: Array<{ before: string; after: string }> = [];
		if (
			typeof result.affectedLineStart === "number" &&
			typeof result.affectedLineEnd === "number"
		) {
			const oldLines = freshMarkdown.replace(/\r\n/g, "\n").split("\n");
			const newLines = result.updatedMarkdown.replace(/\r\n/g, "\n").split("\n");
			for (let i = result.affectedLineStart; i <= result.affectedLineEnd; i++) {
				if (oldLines[i] !== undefined && newLines[i] !== undefined && oldLines[i] !== newLines[i]) {
					lineReplacements.push({ before: oldLines[i], after: newLines[i] });
				}
			}
		}

		this.activeLoadedMarkdown = result.updatedMarkdown;
		await this.app.vault.modify(abstractFile, result.updatedMarkdown);

		if (lineReplacements.length > 0 && this.baselinesStore.hasUnreadBaseline(abstractFile.path)) {
			await this.baselinesStore
				.syncLineReplacementsInBaseline(abstractFile.path, lineReplacements)
				.catch((err) => console.error("[SlideFlow] Failed syncing highlight to baseline:", err));
		}

		const parsed = parseMarkdownSections(result.updatedMarkdown);
		const prevNode = this.currentNode;
		const prevDiffEnabled = this.diffEnabled;
		this.rootNode = parsed.root;
		this.flatNodes = parsed.flatNodes;

		const diffInit = await this.computeDiffForLoadedNote(
			abstractFile.path,
			result.updatedMarkdown,
			this.flatNodes
		);
		this.activeDiffContext = diffInit.ctx;
		this.diffEnabled = diffInit.ctx ? prevDiffEnabled : false;

		const matched = this.findMatchingNodeAfterReload(this.flatNodes, prevNode);
		this.currentNode = this.resolveNavigableTarget(matched) || matched || this.rootNode;

		if (this.activeModal && this.currentNode) {
			await this.activeModal.refreshSlideInPlace(
				this.currentNode,
				this.activeSourcePath,
				this.buildSlideRenderDecoration(this.currentNode)
			);
			this.updateSlideCounter();
			this.refreshAllActiveUI();
		}

		new Notice(
			result.action === "removed"
				? "Highlight removed from note."
				: "Highlight (==…==) saved to note."
		);
	}

	private jumpToNextDiffSlide() {
		const dirtyIds = this.getDirtyNodeIdSet();
		if (!this.activeDiffContext || dirtyIds.size === 0) {
			new Notice("All diffs in this note are already validated.");
			return;
		}
		const currIdx = this.flatNodes.findIndex((n) => n.id === this.currentNode?.id);
		const skipRoot = this.flatNodes.length > 1;

		for (let offset = 1; offset <= this.flatNodes.length; offset++) {
			const idx = (currIdx + offset) % this.flatNodes.length;
			const cand = this.flatNodes[idx];
			if (skipRoot && cand.level === 0) continue;
			if (dirtyIds.has(cand.id)) {
				const target = this.resolveNavigableTarget(cand) || cand;
				if (target.isVirtualDeleted && !this.diffEnabled) {
					this.diffEnabled = true;
				}
				const wrapped = currIdx >= 0 && idx < currIdx;
				void this.goToNode(target, "jump", "start");
				if (wrapped) {
					new Notice("Wrapped to an earlier unvalidated diff.");
				}
				return;
			}
		}
		new Notice("All diffs in this note are already validated.");
	}

	private openCommentModal(
		startWithVoice: boolean,
		explicitRange?: Range | null,
		explicitBlockEl?: HTMLElement | null
	) {
		if (!this.commentModal || !this.currentNode || !this.activeModal) return;
		this.slideCommentsRail?.hidePopoverImmediate();

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
		let activeTargetBlock: HTMLElement | null = null;

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
				const selectedRow = this.activeModal.isTableZoomActive()
					? this.activeModal.getZoomTableRowElement()
					: null;
				const tableEl = selectedRow ? this.activeModal.getZoomTableElement() : null;
				if (selectedRow && tableEl) {
					extracted = extractTableRowContext(
						selectedRow,
						tableEl,
						this.activeSourcePath,
						this.currentNode.title,
						this.activeModal.getActiveZoomIndex(),
						this.activeModal.getZoomTableRowIndex()
					);
				} else {
					extracted = extractZoomContext(
						zoomEl,
						this.activeSourcePath,
						this.currentNode.title,
						this.activeModal.getActiveZoomIndex(),
						this.currentNode.rawOwnMarkdown
					);
				}
			}
		}

		// When reading-focus mode (ArrowDown/ArrowUp) is active OR cursor hovers a specific Markdown element,
		// C / V automatically highlight and target that element instead of the entire slide!
		// Reading-focus takes priority over stray hover; outside slide card with no reading-focus -> general slide comment.
		if (!extracted && !this.activeModal.isMediaZoomActive()) {
			const targetBlock =
				explicitBlockEl ??
				this.activeModal.getReadingFocusBlockElement() ??
				this.activeModal.getHoveredBlockElement();
			if (targetBlock) {
				const blockRes = extractBlockContext(
					targetBlock,
					this.activeSourcePath,
					this.currentNode.title,
					this.activeModal.getContentElement()
				);
				if (blockRes) {
					extracted = blockRes.context;
					highlightRange = blockRes.range;
					activeTargetBlock = targetBlock;
				}
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

		this.activeModal.clearHoveredBlock();
		this.activeModal.setActiveCommentBlock(activeTargetBlock);
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

	private async saveSlideComment(
		commentText: string,
		editingId?: string,
		images?: CommentImageAttachment[]
	) {
		if (!this.currentNode) return;
		if (editingId) {
			await this.reviewStore.updateComment(editingId, commentText, images);
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
				stackDepth: this.documentStack.length,
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
				images: images && images.length > 0 ? images : undefined,
			});

			await this.markCurrentSlideDiffRead(false);

			const imgSuffix = images && images.length > 0 ? ` + ${images.length} img` : "";
			const baseText = commentText || "(Image attached)";
			const snippet = baseText.length > 52 ? baseText.slice(0, 52) + "…" : baseText;
			new Notice(`Comment saved (${ctx?.scopeLabel || "Slide"}${imgSuffix}): "${snippet}"`);
		}

		this.pendingCommentContext = null;
		this.refreshAllActiveUI();
	}

	private toggleReviewDrawer() {
		if (!this.reviewDrawer) return;
		this.slideCommentsRail?.hidePopoverImmediate();
		if (this.reviewDrawer.isOpen()) {
			this.reviewDrawer.close(true);
		} else {
			void this.reconcileOrphanWipBatches().then(() => {
				if (!this.reviewDrawer) return;
				const wipBatches = this.reviewStore.getWipBatches();
				this.reviewDrawer.open({
					comments: this.reviewStore.getAll(),
					directCliEnabled: this.settings.directCliEnabled,
					cliDisplayName: getCliDisplayName(this.settings.directCliCommand),
					wipBatchCount: wipBatches.length,
					wipCommentCount: this.reviewStore.getWipCommentCount(),
				});
			});
		}
	}

	private openReviewDrawerForGeneralComment() {
		if (!this.reviewDrawer) return;
		this.slideCommentsRail?.hidePopoverImmediate();
		if (this.reviewDrawer.isOpen()) {
			this.reviewDrawer.focusGeneralInput();
			return;
		}
		void this.reconcileOrphanWipBatches().then(() => {
			if (!this.reviewDrawer) return;
			const wipBatches = this.reviewStore.getWipBatches();
			this.reviewDrawer.open({
				comments: this.reviewStore.getAll(),
				directCliEnabled: this.settings.directCliEnabled,
				cliDisplayName: getCliDisplayName(this.settings.directCliCommand),
				wipBatchCount: wipBatches.length,
				wipCommentCount: this.reviewStore.getWipCommentCount(),
				focusGeneralInput: true,
			});
		});
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

	private async copyAndDiscardPendingComments(): Promise<boolean> {
		if (!this.activeModal) {
			await this.reviewStore.loadFromDisk();
		}
		const count = this.reviewStore.getCount();
		if (count === 0) {
			new Notice("No pending comments to copy.");
			return false;
		}

		const formatted = this.reviewStore.formatExport(true);
		// Fail-Fast ordering: only purge the queue after clipboard write succeeds.
		await navigator.clipboard.writeText(formatted);
		const cleared = await this.reviewStore.clearAll({ keepTempImages: true });
		this.refreshAllActiveUI();

		new Notice(
			`Copied ${count} comment${count > 1 ? "s" : ""} (XML /one-shot) & discarded ${cleared} from queue.`
		);
		return true;
	}

	/**
	 * Partitions pending comments into isolated CLI sessions (`failed` retry batches first, each
	 * failed project/batch in its own session, and fresh new comments in their own separate session(s)),
	 * moving each batch immediately into WIP tied to `{ jobId, pid }` so the visible queue clears
	 * immediately for the next project!
	 */
	private async sendPendingCommentsToCli(): Promise<boolean> {
		const toSend = this.reviewStore.getAll();
		if (toSend.length === 0) {
			new Notice("No pending comments to send.");
			return false;
		}
		const sessions = partitionCommentsForCliSessions(toSend);
		return this.launchCliSessionBatches(sessions);
	}

	public async sendNewPendingCommentsToCli(): Promise<boolean> {
		const fresh = this.reviewStore.getNewPendingComments();
		if (fresh.length === 0) {
			new Notice("Aucun nouveau commentaire en attente.");
			return false;
		}
		const sessions = partitionCommentsForCliSessions(fresh);
		return this.launchCliSessionBatches(sessions);
	}

	public async retryFailedBatch(groupKey: string): Promise<void> {
		const failedBatches = this.reviewStore.getFailedBatches();
		const target = failedBatches.find((b) => b.groupKey === groupKey);
		if (!target || target.comments.length === 0) {
			new Notice("Ce lot interrompu n'existe plus dans la file.");
			this.refreshAgySidebarViews();
			return;
		}
		await this.launchCliSessionBatches([target]);
	}

	public async discardFailedBatch(groupKey: string): Promise<void> {
		const failedBatches = this.reviewStore.getFailedBatches();
		const target = failedBatches.find((b) => b.groupKey === groupKey);
		const oldBatchId = target?.comments[0]?.failedBatchId || null;
		const removed = await this.reviewStore.discardFailedBatch(groupKey);
		if (oldBatchId) {
			await this.activeJobsTracker.removeJob(oldBatchId);
		}
		this.refreshAllActiveUI();
		if (removed > 0) {
			new Notice(`Lot échoué supprimé (${removed} commentaire${removed > 1 ? "s" : ""}).`);
		}
	}

	private attachHubJobMonitor(
		jobId: string,
		conversationId: string,
		expectedProjectId: string,
		initialHub: AntigravityHubInfo
	): void {
		if (this.liveOwnedJobIds.has(jobId)) return;
		this.liveOwnedJobIds.add(jobId);

		void monitorHubConversation({
			conversationId,
			expectedProjectId,
			initialHub,
			isStopped: () => this.unloaded,
			onStepUpdate: (liveStep) => {
				if (this.unloaded) return;
				void this.activeJobsTracker.updateJobMetadata(jobId, { liveStep }, false);
			},
			onHubUpdated: (updatedHub) => {
				if (this.unloaded) return;
				void this.activeJobsTracker.updateJobMetadata(
					jobId,
					{
						pid: updatedHub.pid,
						instanceId: updatedHub.instanceId || undefined,
					},
					true
				);
			},
		})
			.then(async (res) => {
				this.liveOwnedJobIds.delete(jobId);
				if (res.aborted || this.unloaded) {
					return;
				}
				const finalMeta = {
					conversationId: res.conversationId,
					projectId: res.projectId || expectedProjectId || undefined,
					instanceId: res.instanceId || initialHub.instanceId || undefined,
				};

				if (res.exitCode === 0) {
					const purged = await this.reviewStore.purgeWipBatch(jobId);
					await this.activeJobsTracker.completeJob(jobId, 0, null, finalMeta);
					void this.quotaTracker.refresh();
					this.refreshAllActiveUI();
					new Notice(
						`Antigravity Hub finished — ${purged} comment(s) completed & purged.`,
						6000
					);
				} else {
					const reason = res.streamError || `Antigravity Hub exit ${res.exitCode}`;
					const restored = await this.reviewStore.restoreWipBatchAsFailed(jobId, reason);
					await this.activeJobsTracker.completeJob(jobId, res.exitCode, reason, finalMeta);
					void this.quotaTracker.refresh();
					this.refreshAllActiveUI();
					new Notice(
						`SlideFlow: Antigravity Hub failed (${reason}). ${restored} comment(s) restored for retry.`,
						10000
					);
				}
			})
			.catch(async (err: any) => {
				this.liveOwnedJobIds.delete(jobId);
				const errMsg = err?.message || String(err);
				const restored = await this.reviewStore.restoreWipBatchAsFailed(jobId, errMsg);
				await this.activeJobsTracker.completeJob(jobId, -1, errMsg);
				void this.quotaTracker.refresh();
				this.refreshAllActiveUI();
				console.error("[SlideFlow Hub] Monitor failed:", err);
				new Notice(
					`SlideFlow Hub error: ${errMsg}. ${restored} comment(s) restored for retry.`,
					10000
				);
			});
	}

	private async launchCliSessionBatches(sessions: CliSessionBatch[]): Promise<boolean> {
		if (sessions.length === 0) {
			return false;
		}

		const includeOneShotPrefix = !templateIncludesOneShot(this.settings.directCliCommand);
		let cliDisplayName = "CLI";

		// Validate command template up front (Fail-Fast before moving any comments to WIP)
		try {
			const sampleFormatted = this.reviewStore.formatExport(
				includeOneShotPrefix,
				sessions[0].comments
			);
			const parsed = parseCommandTemplate(this.settings.directCliCommand, sampleFormatted);
			cliDisplayName = parsed.displayName;
		} catch (err: any) {
			new Notice(`SlideFlow CLI config error: ${err?.message || String(err)}`, 9000);
			return false;
		}

		const isAgy = cliDisplayName.toLowerCase() === "agy";
		const jobsDir = this.activeJobsTracker.ensureJobsLogDir();
		const modelLabel = extractModelLabelFromCommand(this.settings.directCliCommand);
		const cwd = this.reviewStore.getVaultBasePath();
		const configuredProject = (this.settings.agyProjectName || "Obsidian").trim();
		const resolvedProj = resolveAgyProjectInfo(configuredProject, cwd);

		// Fail-Fast project guard: NEVER silently launch an AGY conversation into default-cli-project or outside-of-project
		if (isAgy && !resolvedProj.id) {
			const available = listAvailableAgyProjects()
				.map((p) => p.name)
				.slice(0, 8)
				.join(", ");
			new Notice(
				`SlideFlow : projet Antigravity « ${configuredProject} » introuvable dans ~/.gemini/config/projects/${available ? ` (disponibles : ${available})` : ""}. Annulation pour éviter tout lancement hors projet.`,
				12000
			);
			return false;
		}

		// Primary path: launch directly into the running Antigravity Desktop App Hub (unified project & single Remote Control!)
		const liveHub = isAgy ? await this.agyServer.getLiveHub() : null;
		if (isAgy && !liveHub && this.settings.agyServerAutoStart) {
			void this.agyServer.ensureConnected();
		}

		const baseTs = Date.now();
		let totalSentComments = 0;
		let launchedSessions = 0;
		let retrySessions = 0;
		let hubSessions = 0;

		for (let idx = 0; idx < sessions.length; idx++) {
			const session = sessions[idx];
			const oldFailedBatchId =
				session.kind === "retry" ? session.comments[0]?.failedBatchId || null : null;
			const formatted = this.reviewStore.formatExport(includeOneShotPrefix, session.comments);
			const sentIds = session.comments.map((c) => c.id);
			const jobId = `job_${baseTs + idx}_${Math.random().toString(36).slice(2, 6)}`;
			const startedAt = new Date().toISOString();
			const noteTitles = await this.activeJobsTracker.orderNotesForJob(session.comments);

			// Immediately move this session's comments into its own isolated WIP batch
			const moved = await this.reviewStore.moveCommentsToWip(sentIds, {
				jobId,
				cli: liveHub ? "Antigravity Hub" : cliDisplayName,
				model: modelLabel,
				startedAt,
			});
			if (moved.length === 0) {
				continue;
			}

			if (oldFailedBatchId) {
				void this.activeJobsTracker.removeJob(oldFailedBatchId);
			}

			if (isAgy && liveHub) {
				const hubPrompt =
					templateIncludesOneShot(this.settings.directCliCommand) &&
					!formatted.trimStart().startsWith("/one-shot")
						? `/one-shot\n\n${formatted}`
						: formatted;
				const convTitle = `SlideFlow · ${formatJobNotesLabel(noteTitles)}`;

				try {
					const created = await createHubConversation(liveHub, {
						projectId: resolvedProj.id,
						title: convTitle,
						model: modelLabel || null,
						prompt: hubPrompt,
						tags: ["slideflow"],
					});

					totalSentComments += moved.length;
					launchedSessions += 1;
					hubSessions += 1;
					if (session.kind === "retry") retrySessions += 1;

					await this.reviewStore.setWipBatchPid(jobId, created.hubPid);
					await this.activeJobsTracker.registerJob({
						id: jobId,
						pid: created.hubPid,
						cli: "Antigravity Hub",
						model: modelLabel,
						status: "running",
						backendMode: "hub",
						startedAt,
						commentCount: moved.length,
						notes: noteTitles,
						projectName: resolvedProj.name || configuredProject,
						projectId: created.projectId,
						conversationId: created.conversationId,
						instanceId: created.instanceId,
						liveStep: `🚀 Démarré dans ${resolvedProj.name || configuredProject}`,
					});

					this.attachHubJobMonitor(jobId, created.conversationId, created.projectId, liveHub);
					continue;
				} catch (err: any) {
					const errMsg = err?.message || String(err);
					console.error("[SlideFlow Hub] CreateConversation failed:", err);
					const restored = await this.reviewStore.restoreWipBatchAsFailed(jobId, errMsg);
					await this.activeJobsTracker.registerJob({
						id: jobId,
						pid: liveHub.pid,
						cli: "Antigravity Hub",
						model: modelLabel,
						status: "error",
						backendMode: "hub",
						startedAt,
						finishedAt: new Date().toISOString(),
						exitCode: -1,
						errorSummary: errMsg,
						commentCount: moved.length,
						notes: noteTitles,
						projectName: resolvedProj.name || configuredProject,
						projectId: resolvedProj.id,
						instanceId: liveHub.instanceId,
						liveStep: null,
					});
					new Notice(
						`SlideFlow Hub error: ${errMsg}. ${restored} comment(s) restored for retry.`,
						10000
					);
					continue;
				}
			}

			// Fallback CLI path (when Antigravity Desktop App is closed, or non-agy CLI configured)
			totalSentComments += moved.length;
			launchedSessions += 1;
			if (session.kind === "retry") retrySessions += 1;
			this.liveOwnedJobIds.add(jobId);

			const fallbackInstanceId = this.agyServer.getSnapshot().instanceId;
			void this.activeJobsTracker.registerJob({
				id: jobId,
				pid: null,
				cli: cliDisplayName,
				model: modelLabel,
				status: "running",
				backendMode: "cli",
				startedAt,
				commentCount: moved.length,
				notes: noteTitles,
				logPath: path.join(jobsDir, `${jobId}.log`),
				agyLogPath: path.join(jobsDir, `${jobId}.agy.log`),
				projectName: resolvedProj.name || configuredProject || null,
				projectId: resolvedProj.id || null,
				instanceId: fallbackInstanceId,
				liveStep: "⏳ Démarrage…",
			});

			void runCliCommand(this.settings.directCliCommand, formatted, {
				cwd,
				jobsDir,
				jobId,
				projectName: resolvedProj.id || configuredProject,
				disablePerTaskRemoteControl:
					this.settings.agyServerAutoStart || this.agyServer.getSnapshot().status !== "stopped",
				onSpawn: (pid) => {
					void this.reviewStore.setWipBatchPid(jobId, pid);
					void this.activeJobsTracker.updateJobPid(jobId, pid);
				},
				onConversationId: (conversationId) => {
					void this.activeJobsTracker.updateJobMetadata(jobId, { conversationId }, true);
				},
				onProjectId: (projectId) => {
					void this.activeJobsTracker.updateJobMetadata(jobId, { projectId }, true);
				},
				onRemoteInstanceId: (liveInstanceId) => {
					void this.activeJobsTracker.updateJobMetadata(jobId, { liveInstanceId }, true);
				},
				onStepUpdate: (liveStep) => {
					void this.activeJobsTracker.updateJobMetadata(jobId, { liveStep }, false);
				},
			})
				.then(async (res) => {
					this.liveOwnedJobIds.delete(jobId);

					const finalMeta = {
						conversationId: res.conversationId || undefined,
						projectId: res.projectId || resolvedProj.id || undefined,
						instanceId: this.agyServer.getSnapshot().instanceId || fallbackInstanceId || undefined,
						liveInstanceId: res.liveInstanceId || undefined,
						agyLogPath: res.agyLogPath || undefined,
					};

					if (res.exitCode === 0) {
						const purged = await this.reviewStore.purgeWipBatch(jobId);
						await this.activeJobsTracker.completeJob(jobId, 0, null, finalMeta);
						void this.quotaTracker.refresh();
						this.refreshAllActiveUI();
						new Notice(
							`${res.displayName} finished — ${purged} comment(s) completed & purged.`,
							6000
						);
					} else {
						const rawErr = (res.streamError || res.stderr || res.stdout || "")
							.trim()
							.replace(/\s+/g, " ");
						const detail = rawErr ? rawErr.slice(0, 140) : "";
						const reason = `exit ${res.exitCode}${detail ? `: ${detail}` : ""}`;
						const restored = await this.reviewStore.restoreWipBatchAsFailed(jobId, reason);
						await this.activeJobsTracker.completeJob(
							jobId,
							res.exitCode,
							detail || null,
							finalMeta
						);
						void this.quotaTracker.refresh();
						this.refreshAllActiveUI();
						console.error("[SlideFlow CLI] Non-zero exit:", res);
						new Notice(
							`SlideFlow: ${res.displayName} failed (${reason}). ${restored} comment(s) restored as failed in queue.`,
							10000
						);
					}
				})
				.catch(async (err: any) => {
					this.liveOwnedJobIds.delete(jobId);
					const errMsg = err?.message || String(err);
					const restored = await this.reviewStore.restoreWipBatchAsFailed(jobId, errMsg);
					await this.activeJobsTracker.completeJob(jobId, -1, errMsg);
					void this.quotaTracker.refresh();
					this.refreshAllActiveUI();
					console.error("[SlideFlow CLI] Execution failed:", err);
					new Notice(
						`SlideFlow CLI error: ${errMsg}. ${restored} comment(s) restored as failed in queue.`,
						10000
					);
				});
		}

		this.refreshAllActiveUI();

		if (launchedSessions === 0) {
			return false;
		}

		const targetLabel = hubSessions > 0 ? "Antigravity Hub" : cliDisplayName;
		if (launchedSessions === 1) {
			new Notice(
				`Sent ${totalSentComments} comment(s) to ${targetLabel} (${resolvedProj.name || configuredProject}) — queue is now clear.`,
				5000
			);
		} else {
			const retryInfo = retrySessions > 0 ? ` (${retrySessions} retry + ${launchedSessions - retrySessions} new)` : "";
			new Notice(
				`Launched ${launchedSessions} separate ${targetLabel} sessions${retryInfo} for ${totalSentComments} comment(s) — queue is now clear.`,
				6500
			);
		}

		return true;
	}

	private openEditCommentById(commentId: string, anchorRect?: AnchorRect | null): void {
		if (!this.commentModal || !this.activeModal) return;
		this.slideCommentsRail?.hidePopoverImmediate();
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
		const normCommentPath = normalizeVaultPath(comment.notePath);
		if (normCommentPath === normalizeVaultPath(this.activeSourcePath)) {
			const match = this.flatNodes.find((n) => n.title === comment.sectionHeading);
			if (match) {
				await this.goToNode(match, 'jump', 'start');
				return;
			}
		}
		// If the comment lives in a parent note already open higher in the stack, pop back to it cleanly
		// instead of pushing a duplicate loop frame.
		const stackIdx = this.documentStack.findIndex(
			(frame) => normalizeVaultPath(frame.filePath) === normCommentPath
		);
		if (stackIdx !== -1) {
			while (this.documentStack.length > stackIdx) {
				await this.popDocumentStack();
			}
			const match = this.flatNodes.find((n) => n.title === comment.sectionHeading);
			if (match) {
				await this.goToNode(match, 'jump', 'start');
			}
			return;
		}
		await this.handleInternalLinkClick(`${comment.notePath}#${comment.sectionHeading}`, true);
	}

	private async jumpAndEditComment(comment: ReviewComment): Promise<void> {
		if (!isGeneralComment(comment)) {
			await this.jumpToCommentTarget(comment);
		}
		if (!this.commentModal || !this.currentNode || !this.activeModal) return;

		const existingComments = isGeneralComment(comment)
			? this.reviewStore.getAll().filter(isGeneralComment)
			: this.reviewStore.getForSlide(comment.notePath, comment.sectionHeading);

		this.commentModal.open({
			noteTitle: isGeneralComment(comment) ? "General" : comment.noteTitle,
			notePath: comment.notePath,
			sectionHeading: isGeneralComment(comment) ? "General" : comment.sectionHeading,
			scopeLabel: isGeneralComment(comment) ? "General" : comment.scopeLabel || "Slide",
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

	private getNavigableNodes(): SectionNode[] {
		return this.flatNodes.filter(
			(n) => (this.diffEnabled || !n.isVirtualDeleted) && !this.isSkippedEmptySlide(n)
		);
	}

	private updateSlideCounter() {
		if (!this.activeModal || !this.currentNode) return;
		const nav = this.getNavigableNodes();
		const total = nav.length > 1 ? nav.length - 1 : 1;
		const idx = nav.findIndex(n => n.id === this.currentNode?.id);
		let current: number;
		if (idx >= 0) {
			current = nav.length > 1 ? Math.max(1, idx) : 1;
		} else {
			const currFlatIdx = this.currentNode.flatIndex ?? 0;
			const passedCount = nav.filter(
				(n) => (nav.length === 1 || n.level > 0) && (n.flatIndex ?? 0) <= currFlatIdx
			).length;
			current = Math.max(1, Math.min(total, passedCount));
		}
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
		if (this.activeModal?.isPdfZoomActive()) {
			this.activeModal.scrollPdfZoom("down", 0.45);
			return;
		}
		if (this.activeModal?.isTableZoomActive()) {
			this.activeModal.stepTableZoomRow("down");
			return;
		}
		if (this.activeModal?.isMediaZoomActive()) {
			return;
		}
		this.activeModal?.stepReadingFocus("down");
	}

	private fastJumpPrev() {
		if (this.activeModal?.isPdfZoomActive()) {
			this.activeModal.scrollPdfZoom("up", 0.45);
			return;
		}
		if (this.activeModal?.isTableZoomActive()) {
			this.activeModal.stepTableZoomRow("up");
			return;
		}
		if (this.activeModal?.isMediaZoomActive()) {
			return;
		}
		this.activeModal?.stepReadingFocus("up");
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

	private async handleInternalLinkClick(linkpath: string, allowAncestorJump: boolean = false) {
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

			if (!allowAncestorJump && this.isLinkAlreadyOpenInStack(targetFile.path, decodedLink)) {
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
				this.finalizeCommentValidatedNode(this.currentNode);
				this.documentStack.push({
					filePath: this.activeSourcePath,
					fileTitle: activeFileBasename,
					currentNode: this.currentNode,
					flatNodes: this.flatNodes,
					rootNode: this.rootNode,
					diffContext: this.activeDiffContext,
					diffEnabled: this.diffEnabled,
					readingFocusActive: this.activeModal?.isReadingFocusActive() ?? false,
					readingFocusIndex: this.activeModal?.getReadingFocusIndex() ?? -1,
					focusedLinkIndex: this.activeModal?.getFocusedLinkIndex() ?? -1,
					zoomIndex: this.activeModal?.isMediaZoomActive()
						? this.activeModal.getActiveZoomIndex()
						: -1,
					zoomTableRowIndex: this.activeModal?.isTableZoomActive()
						? this.activeModal.getZoomTableRowIndex()
						: -1,
				});
			}

			await this.baselinesStore.reload().catch(() => undefined);

			const markdownText = await this.readFreshMarkdownForFile(targetFile);
			this.activeLoadedMarkdown = markdownText;
			const parsed = parseMarkdownSections(markdownText);

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

			const hasPreamble =
				this.flatNodes.length > 1 &&
				hasSubstantivePreamble(markdownText, this.flatNodes[1].lineStart);
			this.currentNode =
				initialNode ||
				(this.flatNodes.length > 1 && !hasPreamble ? this.flatNodes[1] : this.rootNode);

			const diffInit = await this.computeDiffForLoadedNote(targetFile.path, markdownText, this.flatNodes);
			this.activeDiffContext = diffInit.ctx;
			this.diffEnabled = diffInit.autoEnable;
			this.currentNode = this.resolveNavigableTarget(this.currentNode);

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
		await this.baselinesStore.reload().catch(() => undefined);

		const parentFile = this.app.vault.getAbstractFileByPath(parentFrame.filePath);
		if (parentFile instanceof TFile) {
			// Always re-read parent note fresh from disk on pop (e.g. `🎯 Projets.md` updated while reviewing a project!)
			const freshMarkdown = await this.readFreshMarkdownForFile(parentFile);
			this.activeLoadedMarkdown = freshMarkdown;
			const parsed = parseMarkdownSections(freshMarkdown);
			this.rootNode = parsed.root;
			this.flatNodes = parsed.flatNodes;

			const diffInit = await this.computeDiffForLoadedNote(
				parentFile.path,
				freshMarkdown,
				this.flatNodes
			);
			this.activeDiffContext = diffInit.ctx;
			this.diffEnabled = diffInit.ctx
				? parentFrame.diffEnabled || diffInit.autoEnable
				: false;
			const matched = this.findMatchingNodeAfterReload(
				this.flatNodes,
				parentFrame.currentNode
			);
			this.currentNode = this.resolveNavigableTarget(matched) || matched || this.rootNode;
		} else {
			this.flatNodes = parentFrame.flatNodes;
			this.rootNode = parentFrame.rootNode;
			this.currentNode = parentFrame.currentNode;
			this.activeDiffContext = parentFrame.diffContext;
			this.diffEnabled = parentFrame.diffEnabled;
			this.reconcileActiveDiffWithBaselines();
		}

		if (this.activeModal && this.currentNode) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
			await this.activeModal.updateSlide(
				this.currentNode,
				this.activeSourcePath,
				'zoom-out',
				'start',
				this.buildSlideRenderDecoration(this.currentNode),
				parentFrame.readingFocusActive !== undefined
					? {
							active: parentFrame.readingFocusActive,
							index: Math.max(0, parentFrame.readingFocusIndex ?? 0),
							scrollIntoView: true,
							focusedLinkIndex:
								typeof parentFrame.focusedLinkIndex === "number" && parentFrame.focusedLinkIndex >= 0
									? parentFrame.focusedLinkIndex
									: undefined,
					  }
					: undefined,
				typeof parentFrame.zoomIndex === "number" && parentFrame.zoomIndex >= 0
					? {
							zoomIndex: parentFrame.zoomIndex,
							tableRowIndex:
								typeof parentFrame.zoomTableRowIndex === "number" && parentFrame.zoomTableRowIndex >= 0
									? parentFrame.zoomTableRowIndex
									: undefined,
					  }
					: undefined
			);
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
		const prevNode = this.currentNode;
		const direction = overrideDirection ?? computeDirection(prevNode, node);
		if (prevNode && prevNode.id !== node.id) {
			this.finalizeCommentValidatedNode(prevNode);
		}
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
		const nav = this.getNavigableNodes();
		const idx = nav.findIndex(n => n.id === this.currentNode?.id);
		if (idx === -1) {
			// Current slide became skipped after its deleted-body diff was validated/commented:
			// always advance strictly forward in document order and NEVER fall back to `0. Full document`.
			const currFlatIdx =
				this.currentNode.flatIndex ??
				this.flatNodes.findIndex((n) => n.id === this.currentNode?.id);
			const nextForward = nav.find(
				(n) => (nav.length === 1 || n.level > 0) && (n.flatIndex ?? 0) > currFlatIdx
			);
			if (nextForward) {
				void this.goToNode(nextForward, 'next', 'start');
			} else {
				new Notice("End of presentation reached.");
			}
			return;
		}
		if (idx >= 0 && idx < nav.length - 1) {
			void this.goToNode(nav[idx + 1], undefined, 'start');
		} else if (idx === nav.length - 1) {
			new Notice("End of presentation reached.");
		}
	}

	private prevSlide(enterFrom: 'start' | 'end' = 'end') {
		if (!this.currentNode) return;
		const nav = this.getNavigableNodes();
		const idx = nav.findIndex(n => n.id === this.currentNode?.id);
		if (idx === -1) {
			const currFlatIdx =
				this.currentNode.flatIndex ??
				this.flatNodes.findIndex((n) => n.id === this.currentNode?.id);
			let prevBackward: SectionNode | null = null;
			for (let i = nav.length - 1; i >= 0; i--) {
				const candidate = nav[i];
				if ((nav.length === 1 || candidate.level > 0) && (candidate.flatIndex ?? 0) < currFlatIdx) {
					prevBackward = candidate;
					break;
				}
			}
			if (prevBackward) {
				void this.goToNode(prevBackward, 'prev', enterFrom);
			} else if (this.documentStack.length > 0) {
				void this.popDocumentStack();
			} else {
				new Notice("Beginning of presentation reached.");
			}
			return;
		}
		if (idx > 0) {
			void this.goToNode(nav[idx - 1], undefined, enterFrom);
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
		if (this.slideCommentsRail) {
			this.slideCommentsRail.destroy();
			this.slideCommentsRail = null;
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
		this.detachLiveVaultWatcher();
		if (this.keyboardNav) {
			this.keyboardNav.detach();
			this.keyboardNav = null;
		}
		if (this.tocComp) {
			this.tocComp.destroy();
			this.tocComp = null;
		}
		this.voiceService?.scheduleIdleShutdown(120000);
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
				"Terminal command with {{COMMENTS}} marking where the XML /one-shot payload is injected. For `agy`, SlideFlow routes directly through the running Antigravity Desktop Hub (native project & single Remote Control, honoring `--model` and `/one-shot`), falling back to `agy` CLI (`--project <id>`, `--output-format stream-json`, `--log-file`) only when Antigravity Desktop is closed."
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

		new Setting(containerEl)
			.setName("AGY Project (name or ID)")
			.setDesc(
				"Antigravity project required for all SlideFlow `agy` runs and the AGY sidebar (resolved by ID, name, or vault folder across PCs; default: Obsidian). Fail-Fast: refuses to launch if this project cannot be resolved."
			)
			.addText(text =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.agyProjectName)
					.onChange(async (val) => {
						this.plugin.settings.agyProjectName = val.trim() || "Obsidian";
						await this.plugin.saveSettings();
						this.plugin.onAgyServerConfigChanged();
					})
			);

		new Setting(containerEl)
			.setName("Auto-start AGY Remote Control server with Obsidian")
			.setDesc(
				"Automatically attaches to the running Antigravity Desktop Hub (unified Remote Control) when open, and falls back to an auto-reconnecting `agy remote-control serve` daemon only when Antigravity Desktop is closed."
			)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.agyServerAutoStart)
					.onChange(async (val) => {
						this.plugin.settings.agyServerAutoStart = val;
						await this.plugin.saveSettings();
						this.plugin.applyAgyServerAutoStartToggle(val);
					})
			);

		new Setting(containerEl)
			.setName("AGY Remote Control server name")
			.setDesc(
				`Instance name displayed on antigravity.google.com (leave empty for automatic \`${getDefaultAgyServerName()}\`; restart server from the sidebar after changing).`
			)
			.addText(text =>
				text
					.setPlaceholder(getDefaultAgyServerName())
					.setValue(this.plugin.settings.agyServerName)
					.onChange(async (val) => {
						this.plugin.settings.agyServerName = val.trim();
						await this.plugin.saveSettings();
						this.plugin.onAgyServerConfigChanged();
					})
			);

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
