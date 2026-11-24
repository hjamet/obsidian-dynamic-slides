/**
 * agySidebarView.ts — Dedicated Obsidian Sidebar View (`ItemView`) for SlideFlow AGY:
 *
 * - Persistent Obsidian-lifecycle AGY Remote Control server card (live status, project badge,
 *   one-click "Ouvrir AGY Web", restart / start / stop).
 * - Running `agy` jobs with live step progress (`stream-json`), direct "Ouvrir Live" button
 *   (ephemeral live tunnel while running), and copyable CLI resume command.
 * - Interrupted / failed comment batches with individual per-batch "Retry" button, direct link
 *   to inspect the partial conversation on the persistent server, copyable CLI command, and
 *   two-click safe discard.
 * - Optional pending new comments banner with one-click "Envoyer".
 * - Recent finished jobs (24h, capped at 5) with direct "Ouvrir" button pointing to the
 *   persistent Obsidian server (never dies while Obsidian is open) and copyable CLI command.
 */

import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { AgyServerSnapshot } from "./agyServerManager";
import { formatJobNotesLabel, SlideFlowCliJob } from "./activeJobsTracker";
import { QuotaEntry, QuotaSnapshot } from "./quotaTracker";
import { CliSessionBatch, ReviewComment } from "./reviewStore";

export const SLIDEFLOW_AGY_VIEW_TYPE = "slideflow-agy-sidebar";

export interface AgySidebarCallbacks {
	getServerSnapshot: () => AgyServerSnapshot;
	getServerHomeUrl: () => string | null;
	getConversationUrl: (
		conversationId: string | null | undefined,
		projectId?: string | null,
		overrideInstanceId?: string | null
	) => string | null;
	getQuotaSnapshot: () => QuotaSnapshot;
	getJobs: () => SlideFlowCliJob[];
	getFailedBatches: () => CliSessionBatch[];
	getNewPendingComments: () => ReviewComment[];
	getVaultBasePath: () => string;
	onStartServer: () => void;
	onStopServer: () => void;
	onRestartServer: () => Promise<void>;
	onRefreshAll: () => Promise<void>;
	onRefreshQuotas: () => Promise<void>;
	onRetryFailedBatch: (groupKey: string) => Promise<void>;
	onDiscardFailedBatch: (groupKey: string) => Promise<void>;
	onSendNewPending: () => Promise<void>;
	onRemoveHistoryJob: (jobId: string) => Promise<void>;
	subscribeServer: (listener: () => void) => () => void;
	subscribeJobs: (listener: () => void) => () => void;
	subscribeQuotas: (listener: () => void) => () => void;
}

function formatHHMM(iso: string | null | undefined): string {
	if (!iso) return "--:--";
	const d = new Date(iso);
	if (isNaN(d.getTime())) return "--:--";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatShortModel(model: string): string {
	if (!model) return "";
	return model.replace(/\s*\([^)]*\)\s*$/, "").trim() || model;
}

function buildCliResumeCommand(vaultPath: string, conversationId: string): string {
	const safeVault = (vaultPath || "").replace(/"/g, '\\"');
	if (safeVault) {
		return `cd "${safeVault}"; agy --conversation ${conversationId}`;
	}
	return `agy --conversation ${conversationId}`;
}

function openExternalUrl(url: string): void {
	window.open(url, "_blank", "noopener,noreferrer");
}

function getBatchNotesLabel(batch: CliSessionBatch): string {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const c of batch.comments) {
		const title = (c.noteTitle || c.notePath || "").trim();
		if (!title || title === "__general__") continue;
		const low = title.toLowerCase();
		if (!seen.has(low)) {
			seen.add(low);
			unique.push(title);
		}
	}
	return formatJobNotesLabel(unique);
}

export class AgySidebarView extends ItemView {
	private callbacks: AgySidebarCallbacks;
	private unsubServer: (() => void) | null = null;
	private unsubJobs: (() => void) | null = null;
	private unsubQuotas: (() => void) | null = null;
	private pendingDiscardConfirmKey: string | null = null;
	private discardConfirmTimer: number | null = null;
	private busyRetryKeys: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, callbacks: AgySidebarCallbacks) {
		super(leaf);
		this.callbacks = callbacks;
	}

	public getViewType(): string {
		return SLIDEFLOW_AGY_VIEW_TYPE;
	}

	public getDisplayText(): string {
		return "SlideFlow AGY";
	}

	public getIcon(): string {
		return "bot";
	}

	public async onOpen(): Promise<void> {
		this.unsubServer = this.callbacks.subscribeServer(() => this.render());
		this.unsubJobs = this.callbacks.subscribeJobs(() => this.render());
		this.unsubQuotas = this.callbacks.subscribeQuotas(() => this.render());
		this.render();
	}

	public async onClose(): Promise<void> {
		if (this.unsubServer) {
			this.unsubServer();
			this.unsubServer = null;
		}
		if (this.unsubJobs) {
			this.unsubJobs();
			this.unsubJobs = null;
		}
		if (this.unsubQuotas) {
			this.unsubQuotas();
			this.unsubQuotas = null;
		}
		if (this.discardConfirmTimer !== null) {
			window.clearTimeout(this.discardConfirmTimer);
			this.discardConfirmTimer = null;
		}
	}

	public render(): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;
		container.empty();
		container.addClass("slideflow-agy-sidebar");

		const serverSnap = this.callbacks.getServerSnapshot();
		const quotaSnap = this.callbacks.getQuotaSnapshot();
		const jobs = this.callbacks.getJobs();
		const failedBatches = this.callbacks.getFailedBatches();
		const newPending = this.callbacks.getNewPendingComments();
		const vaultPath = this.callbacks.getVaultBasePath();

		const runningJobs = jobs.filter((j) => j.status === "running");
		const jobsById = new Map<string, SlideFlowCliJob>();
		for (const j of jobs) {
			jobsById.set(j.id, j);
		}
		const retryBatchIds = new Set<string>();
		for (const b of failedBatches) {
			const bid = b.comments[0]?.failedBatchId;
			if (bid) retryBatchIds.add(bid);
		}
		const historyJobs = jobs.filter(
			(j) => j.status !== "running" && !(j.status === "error" && retryBatchIds.has(j.id))
		);

		this.renderServerCard(container, serverSnap);
		this.renderQuotasCard(container, quotaSnap);

		if (runningJobs.length > 0) {
			this.renderRunningSection(container, runningJobs, serverSnap, vaultPath);
		}

		if (failedBatches.length > 0) {
			this.renderFailedSection(container, failedBatches, jobsById, serverSnap, vaultPath);
		}

		if (newPending.length > 0) {
			this.renderPendingNewBanner(container, newPending);
		}

		this.renderHistorySection(container, historyJobs, serverSnap, vaultPath);
	}

	private formatResetShort(iso: string | null): string {
		if (!iso) return "";
		const d = new Date(iso);
		if (isNaN(d.getTime())) return "";
		const day = String(d.getDate()).padStart(2, "0");
		const mon = String(d.getMonth() + 1).padStart(2, "0");
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		return `${day}/${mon} ${hh}:${mm}`;
	}

	private renderQuotasCard(container: HTMLElement, snap: QuotaSnapshot): void {
		const card = container.createDiv({ cls: "sf-agy-card sf-agy-quota-card" });

		const topRow = card.createDiv({ cls: "sf-agy-quota-header" });
		const titleWrap = topRow.createDiv({ cls: "sf-agy-quota-title-wrap" });
		titleWrap.createSpan({ cls: "sf-agy-quota-title", text: "Quotas IA" });
		if (snap.updatedAt) {
			titleWrap.createSpan({
				cls: "sf-agy-meta-muted",
				text: formatHHMM(snap.updatedAt),
			});
		}

		const refreshBtn = topRow.createEl("button", {
			cls: `sf-agy-icon-btn${snap.loading ? " is-spinning" : ""}`,
			attr: {
				title: "Actualiser les quotas IA (Gemini, Antigravity Claude, Claude Code)",
				"aria-label": "Actualiser les quotas IA",
			},
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.disabled = snap.loading;
		refreshBtn.addEventListener("click", () => {
			void this.callbacks.onRefreshQuotas();
		});

		if (snap.entries.length === 0) {
			card.createDiv({
				cls: "sf-agy-empty",
				text: snap.loading ? "Chargement des quotas en temps réel…" : "Aucun quota chargé.",
			});
			return;
		}

		const list = card.createDiv({ cls: "sf-agy-quota-list" });
		for (const entry of snap.entries) {
			this.renderQuotaRow(list, entry);
		}
	}

	private renderQuotaRow(listEl: HTMLElement, entry: QuotaEntry): void {
		const row = listEl.createDiv({ cls: `sf-agy-quota-row is-${entry.verdict}` });

		const tooltipParts: string[] = [entry.label];
		if (entry.remaining7dPct !== null && entry.targetRemaining7dPct !== null) {
			tooltipParts.push(
				`7j : ${Math.round(entry.remaining7dPct)}% restant (cible linéaire ${Math.round(entry.targetRemaining7dPct)}%)`
			);
		}
		if (entry.remaining5hPct !== null) {
			tooltipParts.push(`Fenêtre 5h : ${Math.round(entry.remaining5hPct)}% restant`);
		}
		const r7 = this.formatResetShort(entry.reset7dIso);
		if (r7) {
			tooltipParts.push(`Reset 7j : ${r7}`);
		}
		if (entry.error) {
			tooltipParts.push(`Erreur : ${entry.error}`);
		}
		row.setAttr("title", tooltipParts.join("\n"));

		const top = row.createDiv({ cls: "sf-agy-quota-row-top" });
		top.createSpan({ cls: "sf-agy-quota-label", text: entry.label });
		top.createSpan({
			cls: `sf-agy-quota-badge is-${entry.verdict}`,
			text: entry.verdictBadge,
		});

		if (entry.remaining7dPct !== null && entry.targetRemaining7dPct !== null) {
			const rem = Math.max(0, Math.min(100, entry.remaining7dPct));
			const target = Math.max(0, Math.min(100, entry.targetRemaining7dPct));

			const nums = row.createDiv({ cls: "sf-agy-quota-nums" });
			nums.createSpan({
				cls: "sf-agy-quota-rem",
				text: `${Math.round(rem)}% rest.`,
			});
			nums.createSpan({
				cls: "sf-agy-meta-muted",
				text: `cible ${Math.round(target)}%${entry.remaining5hPct !== null ? ` · 5h ${Math.round(entry.remaining5hPct)}%` : ""}`,
			});

			const bar = row.createDiv({ cls: "sf-agy-quota-bar" });
			const fill = bar.createDiv({ cls: `sf-agy-quota-bar-fill is-${entry.verdict}` });
			fill.style.width = `${rem.toFixed(1)}%`;

			const marker = bar.createDiv({ cls: "sf-agy-quota-bar-target" });
			marker.style.left = `${target.toFixed(1)}%`;
		} else if (entry.error) {
			row.createDiv({
				cls: "sf-agy-quota-err",
				text: entry.error.length > 72 ? `${entry.error.slice(0, 72)}…` : entry.error,
			});
		}
	}

	private renderServerCard(container: HTMLElement, snap: AgyServerSnapshot): void {
		const card = container.createDiv({ cls: "sf-agy-card sf-agy-server-card" });

		const topRow = card.createDiv({ cls: "sf-agy-server-top" });
		const statusWrap = topRow.createDiv({ cls: "sf-agy-server-status" });
		const dot = statusWrap.createSpan({ cls: `sf-agy-dot is-${snap.status}` });
		dot.setAttr("aria-hidden", "true");

		let statusText = "Arrêté";
		if (snap.status === "connected") statusText = "Serveur AGY en ligne";
		else if (snap.status === "starting") statusText = snap.statusDetail || "Connexion AGY…";
		else if (snap.status === "error") statusText = "Erreur serveur AGY";
		statusWrap.createSpan({ cls: "sf-agy-server-title", text: statusText });

		const controls = topRow.createDiv({ cls: "sf-agy-icon-group" });

		const refreshBtn = controls.createEl("button", {
			cls: "sf-agy-icon-btn",
			attr: { title: "Actualiser les jobs", "aria-label": "Actualiser" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			void this.callbacks.onRefreshAll();
		});

		const restartBtn = controls.createEl("button", {
			cls: "sf-agy-icon-btn",
			attr: { title: "Redémarrer le serveur AGY", "aria-label": "Redémarrer" },
		});
		setIcon(restartBtn, "rotate-cw");
		restartBtn.addEventListener("click", () => {
			void this.callbacks.onRestartServer();
		});

		const toggleBtn = controls.createEl("button", {
			cls: "sf-agy-icon-btn",
			attr: {
				title:
					snap.status === "stopped" || snap.status === "error"
						? "Démarrer le serveur AGY"
						: "Arrêter le serveur AGY",
				"aria-label":
					snap.status === "stopped" || snap.status === "error" ? "Démarrer" : "Arrêter",
			},
		});
		setIcon(toggleBtn, snap.status === "stopped" || snap.status === "error" ? "play" : "square");
		toggleBtn.addEventListener("click", () => {
			if (snap.status === "stopped" || snap.status === "error") {
				this.callbacks.onStartServer();
			} else {
				this.callbacks.onStopServer();
			}
		});

		const metaRow = card.createDiv({ cls: "sf-agy-meta-row" });
		metaRow.createSpan({ cls: "sf-agy-pill", text: snap.hostname });
		if (snap.projectName) {
			metaRow.createSpan({ cls: "sf-agy-pill is-project", text: `Projet : ${snap.projectName}` });
		}
		if (snap.pid) {
			metaRow.createSpan({ cls: "sf-agy-meta-muted", text: `PID ${snap.pid}` });
		}

		if (snap.lastError) {
			card.createDiv({ cls: "sf-agy-error-note", text: snap.lastError });
		}

		const homeUrl = this.callbacks.getServerHomeUrl();
		const openBtn = card.createEl("button", {
			cls: "sf-agy-btn is-primary sf-agy-btn-full",
			text: "Ouvrir AGY Web",
		});
		const btnIcon = openBtn.createSpan({ cls: "sf-agy-btn-icon" });
		openBtn.prepend(btnIcon);
		setIcon(btnIcon, "globe");

		if (snap.status !== "connected" || !homeUrl) {
			openBtn.disabled = true;
			if (snap.status === "starting") {
				openBtn.setAttr("title", snap.statusDetail || "Connexion du serveur AGY en cours…");
			} else if (snap.status === "error") {
				openBtn.setAttr("title", "Serveur AGY en erreur — démarrez ou redémarrez le serveur.");
			} else if (snap.status === "stopped") {
				openBtn.setAttr("title", "Démarrez le serveur AGY pour ouvrir l'interface web.");
			} else {
				openBtn.setAttr("title", "En attente de l'identifiant d'instance du serveur…");
			}
		} else {
			openBtn.setAttr("title", homeUrl);
			openBtn.addEventListener("click", () => openExternalUrl(homeUrl));
		}
	}

	private renderRunningSection(
		container: HTMLElement,
		running: SlideFlowCliJob[],
		serverSnap: AgyServerSnapshot,
		vaultPath: string
	): void {
		const sec = container.createDiv({ cls: "sf-agy-section" });
		const header = sec.createDiv({ cls: "sf-agy-section-header" });
		header.createSpan({ text: `En cours (${running.length})` });

		for (const job of running) {
			const card = sec.createDiv({ cls: "sf-agy-card sf-agy-job-card is-running" });

			const titleRow = card.createDiv({ cls: "sf-agy-job-title-row" });
			titleRow.createSpan({ cls: "sf-agy-job-badge is-running", text: "⏳" });
			titleRow.createSpan({
				cls: "sf-agy-job-title",
				text: formatJobNotesLabel(job.notes),
			});

			const meta = card.createDiv({ cls: "sf-agy-meta-row" });
			meta.createSpan({
				cls: "sf-agy-pill",
				text: `${job.commentCount} comm.`,
			});
			if (job.model) {
				meta.createSpan({ cls: "sf-agy-pill", text: formatShortModel(job.model) });
			}
			meta.createSpan({ cls: "sf-agy-meta-muted", text: formatHHMM(job.startedAt) });
			if (job.pid) {
				meta.createSpan({ cls: "sf-agy-meta-muted", text: `PID ${job.pid}` });
			}

			const stepLine = card.createDiv({ cls: "sf-agy-live-step" });
			stepLine.setText(job.liveStep || "⏳ Initialisation de la conversation…");

			const actions = card.createDiv({ cls: "sf-agy-actions-row" });

			// Adaptive 3A: while running, prefer live ephemeral tunnel if available, else persistent server (only when connected)
			const liveInstance =
				job.liveInstanceId || (serverSnap.status === "connected" ? serverSnap.instanceId : null);
			const liveUrl = this.callbacks.getConversationUrl(
				job.conversationId,
				job.projectId,
				liveInstance
			);
			const openBtn = actions.createEl("button", {
				cls: "sf-agy-btn is-accent",
				text: job.liveInstanceId ? "Ouvrir Live" : "Ouvrir Web",
			});
			const webIcon = openBtn.createSpan({ cls: "sf-agy-btn-icon" });
			openBtn.prepend(webIcon);
			setIcon(webIcon, "external-link");

			if (!liveUrl) {
				openBtn.disabled = true;
				openBtn.setAttr(
					"title",
					!job.conversationId
						? "ID de conversation en cours d'attribution (~2s)…"
						: "En attente de la connexion du serveur AGY…"
				);
			} else {
				openBtn.setAttr("title", liveUrl);
				openBtn.addEventListener("click", () => openExternalUrl(liveUrl));
			}

			this.appendCopyCliButton(actions, job.conversationId, vaultPath);
		}
	}

	private renderFailedSection(
		container: HTMLElement,
		failedBatches: CliSessionBatch[],
		jobsById: Map<string, SlideFlowCliJob>,
		serverSnap: AgyServerSnapshot,
		vaultPath: string
	): void {
		const sec = container.createDiv({ cls: "sf-agy-section" });
		const header = sec.createDiv({ cls: "sf-agy-section-header is-error" });
		header.createSpan({ text: `Interrompus · Retry (${failedBatches.length})` });

		for (const batch of failedBatches) {
			const first = batch.comments[0];
			const batchJobId = first?.failedBatchId || null;
			const linkedJob = batchJobId ? jobsById.get(batchJobId) : undefined;
			const isRetrying = this.busyRetryKeys.has(batch.groupKey);

			const card = sec.createDiv({ cls: "sf-agy-card sf-agy-job-card is-error" });

			const titleRow = card.createDiv({ cls: "sf-agy-job-title-row" });
			titleRow.createSpan({ cls: "sf-agy-job-badge is-error", text: "!" });
			titleRow.createSpan({
				cls: "sf-agy-job-title",
				text: linkedJob ? formatJobNotesLabel(linkedJob.notes) : getBatchNotesLabel(batch),
			});

			const meta = card.createDiv({ cls: "sf-agy-meta-row" });
			meta.createSpan({
				cls: "sf-agy-pill is-error",
				text: `${batch.comments.length} comm.`,
			});
			if (linkedJob?.finishedAt || first?.failedAt) {
				meta.createSpan({
					cls: "sf-agy-meta-muted",
					text: formatHHMM(linkedJob?.finishedAt || first?.failedAt),
				});
			}

			const reason = (linkedJob?.errorSummary || first?.failedReason || "").trim();
			if (reason) {
				card.createDiv({
					cls: "sf-agy-error-note",
					text: reason.length > 140 ? `${reason.slice(0, 140)}…` : reason,
				});
			}

			const firstText = (first?.commentText || "").trim();
			if (firstText) {
				card.createDiv({
					cls: "sf-agy-comment-preview",
					text: firstText.length > 100 ? `« ${firstText.slice(0, 100)}… »` : `« ${firstText} »`,
				});
			}

			const actions = card.createDiv({ cls: "sf-agy-actions-row" });

			const retryBtn = actions.createEl("button", {
				cls: "sf-agy-btn is-retry",
				text: isRetrying ? "Relance…" : "Retry",
			});
			const retryIcon = retryBtn.createSpan({ cls: "sf-agy-btn-icon" });
			retryBtn.prepend(retryIcon);
			setIcon(retryIcon, "rotate-ccw");
			retryBtn.disabled = isRetrying;
			retryBtn.addEventListener("click", () => {
				if (this.busyRetryKeys.has(batch.groupKey)) return;
				this.busyRetryKeys.add(batch.groupKey);
				this.render();
				void this.callbacks
					.onRetryFailedBatch(batch.groupKey)
					.finally(() => {
						this.busyRetryKeys.delete(batch.groupKey);
						this.render();
					});
			});

			// Open partial conversation on the persistent server if a conversationId was created
			const convId = linkedJob?.conversationId || null;
			const isServerReady = serverSnap.status === "connected";
			const openUrl = this.callbacks.getConversationUrl(
				convId,
				linkedJob?.projectId,
				serverSnap.instanceId
			);
			if (convId) {
				const openBtn = actions.createEl("button", {
					cls: "sf-agy-btn",
					text: "Ouvrir",
				});
				const webIcon = openBtn.createSpan({ cls: "sf-agy-btn-icon" });
				openBtn.prepend(webIcon);
				setIcon(webIcon, "external-link");
				if (!isServerReady || !openUrl) {
					openBtn.disabled = true;
					openBtn.setAttr(
						"title",
						"Démarrez le serveur AGY pour ouvrir cette conversation dans le navigateur."
					);
				} else {
					openBtn.setAttr("title", openUrl);
					openBtn.addEventListener("click", () => openExternalUrl(openUrl));
				}
			}

			if (convId) {
				this.appendCopyCliButton(actions, convId, vaultPath);
			}

			const isConfirming = this.pendingDiscardConfirmKey === batch.groupKey;
			const discardBtn = actions.createEl("button", {
				cls: `sf-agy-btn is-ghost${isConfirming ? " is-danger-confirm" : ""}`,
				text: isConfirming ? "Suppr. ?" : "",
				attr: {
					title: isConfirming
						? "Cliquer encore pour supprimer définitivement ce lot échoué"
						: "Supprimer ce lot échoué",
				},
			});
			if (!isConfirming) {
				setIcon(discardBtn, "trash-2");
			}
			discardBtn.addEventListener("click", () => {
				if (this.pendingDiscardConfirmKey !== batch.groupKey) {
					this.pendingDiscardConfirmKey = batch.groupKey;
					if (this.discardConfirmTimer !== null) {
						window.clearTimeout(this.discardConfirmTimer);
					}
					this.discardConfirmTimer = window.setTimeout(() => {
						this.pendingDiscardConfirmKey = null;
						this.discardConfirmTimer = null;
						this.render();
					}, 3500);
					this.render();
					return;
				}
				this.pendingDiscardConfirmKey = null;
				if (this.discardConfirmTimer !== null) {
					window.clearTimeout(this.discardConfirmTimer);
					this.discardConfirmTimer = null;
				}
				void this.callbacks.onDiscardFailedBatch(batch.groupKey);
			});
		}
	}

	private renderPendingNewBanner(container: HTMLElement, newPending: ReviewComment[]): void {
		const card = container.createDiv({ cls: "sf-agy-card sf-agy-pending-banner" });
		card.createSpan({
			cls: "sf-agy-pending-text",
			text: `${newPending.length} commentaire${newPending.length > 1 ? "s" : ""} en attente`,
		});
		const sendBtn = card.createEl("button", {
			cls: "sf-agy-btn is-primary",
			text: "Envoyer",
		});
		const icon = sendBtn.createSpan({ cls: "sf-agy-btn-icon" });
		sendBtn.prepend(icon);
		setIcon(icon, "send");
		sendBtn.addEventListener("click", () => {
			void this.callbacks.onSendNewPending();
		});
	}

	private renderHistorySection(
		container: HTMLElement,
		history: SlideFlowCliJob[],
		serverSnap: AgyServerSnapshot,
		vaultPath: string
	): void {
		const sec = container.createDiv({ cls: "sf-agy-section" });
		const header = sec.createDiv({ cls: "sf-agy-section-header" });
		header.createSpan({ text: `Récents · 24h (${history.length})` });

		if (history.length === 0) {
			sec.createDiv({
				cls: "sf-agy-empty",
				text: "Aucune exécution récente sur les dernières 24h.",
			});
			return;
		}

		for (const job of history) {
			const isDone = job.status === "done";
			const card = sec.createDiv({
				cls: `sf-agy-card sf-agy-job-card ${isDone ? "is-done" : "is-error"}`,
			});

			const titleRow = card.createDiv({ cls: "sf-agy-job-title-row" });
			titleRow.createSpan({
				cls: `sf-agy-job-badge ${isDone ? "is-done" : "is-error"}`,
				text: isDone ? "✓" : "✕",
			});
			titleRow.createSpan({
				cls: "sf-agy-job-title",
				text: formatJobNotesLabel(job.notes),
			});

			const meta = card.createDiv({ cls: "sf-agy-meta-row" });
			meta.createSpan({
				cls: "sf-agy-pill",
				text: `${job.commentCount} comm.`,
			});
			if (job.model) {
				meta.createSpan({ cls: "sf-agy-pill", text: formatShortModel(job.model) });
			}
			meta.createSpan({
				cls: "sf-agy-meta-muted",
				text: formatHHMM(job.finishedAt || job.startedAt),
			});

			if (!isDone && job.errorSummary) {
				card.createDiv({
					cls: "sf-agy-error-note",
					text:
						job.errorSummary.length > 120
							? `${job.errorSummary.slice(0, 120)}…`
							: job.errorSummary,
				});
			}

			const actions = card.createDiv({ cls: "sf-agy-actions-row" });

			// Always open finished/errored conversations on the persistent Obsidian server!
			const isServerReady = serverSnap.status === "connected";
			const permanentUrl = this.callbacks.getConversationUrl(
				job.conversationId,
				job.projectId,
				serverSnap.instanceId
			);
			const openBtn = actions.createEl("button", {
				cls: "sf-agy-btn",
				text: "Ouvrir",
			});
			const webIcon = openBtn.createSpan({ cls: "sf-agy-btn-icon" });
			openBtn.prepend(webIcon);
			setIcon(webIcon, "external-link");

			if (!job.conversationId) {
				openBtn.disabled = true;
				openBtn.setAttr("title", "ID de conversation non disponible pour cette exécution.");
			} else if (!isServerReady || !permanentUrl) {
				openBtn.disabled = true;
				openBtn.setAttr(
					"title",
					"Démarrez le serveur AGY pour ouvrir cette conversation dans le navigateur."
				);
			} else {
				openBtn.setAttr("title", permanentUrl);
				openBtn.addEventListener("click", () => openExternalUrl(permanentUrl));
			}

			this.appendCopyCliButton(actions, job.conversationId, vaultPath);

			const dismissBtn = actions.createEl("button", {
				cls: "sf-agy-btn is-ghost",
				attr: { title: "Masquer de l'historique", "aria-label": "Masquer" },
			});
			setIcon(dismissBtn, "x");
			dismissBtn.addEventListener("click", () => {
				void this.callbacks.onRemoveHistoryJob(job.id);
			});
		}
	}

	private appendCopyCliButton(
		actionsEl: HTMLElement,
		conversationId: string | null | undefined,
		vaultPath: string
	): void {
		const copyBtn = actionsEl.createEl("button", {
			cls: "sf-agy-btn",
			text: "CLI",
		});
		const icon = copyBtn.createSpan({ cls: "sf-agy-btn-icon" });
		copyBtn.prepend(icon);
		setIcon(icon, "terminal");

		if (!conversationId) {
			copyBtn.disabled = true;
			copyBtn.setAttr("title", "ID de conversation indisponible");
			return;
		}

		const cmd = buildCliResumeCommand(vaultPath, conversationId);
		copyBtn.setAttr("title", cmd);
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(cmd).then(() => {
				new Notice(`Commande copiée : agy --conversation ${conversationId.slice(0, 8)}…`);
			});
		});
	}
}
