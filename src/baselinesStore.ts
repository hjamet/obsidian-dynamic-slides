/**
 * BaselinesStore — Solution B (« Dirty-Only » Single File: `_agents/unread_baselines.json`).
 *
 * - 0 byte stored for any clean/read note or sub-note.
 * - Tracks per-slide read state (`seenSlides`) when a slide is consulted > 1 second,
 *   so diffs disappear on the NEXT opening while staying visible in the current session.
 * - Automatically purges the entire note entry (0 byte) once all dirty slides of that note
 *   have been viewed > 1 second.
 */

import { App } from "obsidian";
import { hashText, SeenSlideRecord } from "./diffEngine";

export const UNREAD_BASELINES_PATH = "_agents/unread_baselines.json";

export interface UnreadBaselineEntry {
	baseline: string;
	updatedAt: string;
	updatedBy?: string;
	summary?: string;
	seenSlides?: Record<string, SeenSlideRecord>;
}

export interface UnreadBaselinesPayload {
	version: number;
	notes: Record<string, UnreadBaselineEntry>;
}

export function normalizeVaultPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export class BaselinesStore {
	private app: App;
	private cache: UnreadBaselinesPayload = { version: 1, notes: {} };
	private writeChain: Promise<void> = Promise.resolve();

	constructor(app: App) {
		this.app = app;
	}

	public async reload(): Promise<UnreadBaselinesPayload> {
		const adapter = this.app.vault.adapter;
		const exists = await adapter.exists(UNREAD_BASELINES_PATH);
		if (!exists) {
			this.cache = { version: 1, notes: {} };
			return this.cache;
		}
		const raw = await adapter.read(UNREAD_BASELINES_PATH);
		const parsed = JSON.parse(raw) as UnreadBaselinesPayload;
		if (!parsed || typeof parsed !== "object" || typeof parsed.notes !== "object") {
			throw new Error(`Format invalide dans ${UNREAD_BASELINES_PATH}: objet { notes } attendu.`);
		}
		this.cache = {
			version: parsed.version || 1,
			notes: parsed.notes || {},
		};
		return this.cache;
	}

	public hasUnreadBaseline(notePath: string): boolean {
		const norm = normalizeVaultPath(notePath);
		return Object.prototype.hasOwnProperty.call(this.cache.notes, norm);
	}

	public getNoteEntry(notePath: string): UnreadBaselineEntry | null {
		const norm = normalizeVaultPath(notePath);
		const entry = this.cache.notes[norm];
		if (!entry) return null;
		return {
			...entry,
			seenSlides: { ...(entry.seenSlides || {}) },
		};
	}

	public getUnreadPaths(): string[] {
		return Object.keys(this.cache.notes);
	}

	private async saveLocked(payload: UnreadBaselinesPayload): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parentDir = UNREAD_BASELINES_PATH.split("/").slice(0, -1).join("/");
		if (parentDir && !(await adapter.exists(parentDir))) {
			await adapter.mkdir(parentDir);
		}
		await adapter.write(UNREAD_BASELINES_PATH, JSON.stringify(payload, null, 2));
		this.cache = payload;
	}

	/**
	 * Marks one slide as seen (> 1s consultation) for future openings.
	 * If ALL dirty slides of this note have now been seen at their current hashes,
	 * purges the entire note entry from `_agents/unread_baselines.json` (0 byte).
	 */
	public markSlideSeen(
		notePath: string,
		slideKey: string,
		slideOwnMarkdown: string,
		allDirtySlideKeys: string[],
		currentHashesByKey: Record<string, string>,
		deletedSectionsHash?: string | null
	): Promise<{ purgedNote: boolean }> {
		const norm = normalizeVaultPath(notePath);
		const run = async (): Promise<{ purgedNote: boolean }> => {
			const data = await this.reload();
			const entry = data.notes[norm];
			if (!entry) {
				return { purgedNote: true };
			}
			if (!entry.seenSlides) {
				entry.seenSlides = {};
			}

			const currentHash = currentHashesByKey[slideKey] || hashText(slideOwnMarkdown);
			entry.seenSlides[slideKey] = {
				hash: currentHash,
				text: slideOwnMarkdown,
				seenAt: new Date().toISOString(),
			};

			if (deletedSectionsHash) {
				entry.seenSlides["__deleted__"] = {
					hash: deletedSectionsHash,
					text: "",
					seenAt: new Date().toISOString(),
				};
			}

			// Check if every dirty slide of this note has now been seen with matching hash
			const allSeen = allDirtySlideKeys.every((k) => {
				const rec = entry.seenSlides?.[k];
				return Boolean(rec && rec.hash === currentHashesByKey[k]);
			});

			let purgedNote = false;
			if (allSeen) {
				delete data.notes[norm];
				purgedNote = true;
			}

			await this.saveLocked(data);
			return { purgedNote };
		};

		const chained = this.writeChain.then(run, run);
		this.writeChain = chained.then(() => undefined, () => undefined);
		return chained;
	}

	public markEntireNoteRead(notePath: string): Promise<boolean> {
		const norm = normalizeVaultPath(notePath);
		const run = async (): Promise<boolean> => {
			const data = await this.reload();
			if (!data.notes[norm]) {
				return false;
			}
			delete data.notes[norm];
			await this.saveLocked(data);
			return true;
		};
		const chained = this.writeChain.then(run, run);
		this.writeChain = chained.then(() => undefined, () => undefined);
		return chained;
	}
}
