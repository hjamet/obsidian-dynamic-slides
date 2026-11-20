/**
 * SlideFlow AST & Word-Level Surgical Diff Engine.
 * Ported from obsidian-comment-share/diffEngine.ts & doc_version_mcp/diff_engine.py,
 * tailored for per-slide rendering in Obsidian MarkdownRenderer:
 * - Protects KaTeX ($...$, $$...$$) and inline code
 * - Switches to full red/green paragraph block diff above threshold (default 25%)
 * - Splits consecutive list items line-by-line for crisp bullet/roadmap diffs
 * - Computes per-slide diff maps with per-slide read tracking (`seenSlides`)
 */

import { SectionNode } from "./parser";
import { stripHeadingLinksToPlainText } from "./headingUtils";

export interface SeenSlideRecord {
	hash: string;
	text: string;
	seenAt: string;
}

export interface SlideDiffInfo {
	slideKey: string;
	hasChanges: boolean;
	validatedByComment?: boolean;
	diffMarkdown: string;
	rawNewMarkdown: string;
	rawOldMarkdown: string | null;
	addedCount: number;
	removedCount: number;
	currentHash: string;
}

export interface DeletedSectionItem {
	id: string;
	slideKey: string;
	title: string;
	displayTitle: string;
	level: number;
	parentNormTitle: string | null;
	prevSiblingNormTitle: string | null;
	isTitleOnly: boolean;
	diffMarkdown: string;
	rawOldMarkdown: string;
	hash: string;
}

export interface NoteDiffContext {
	notePath: string;
	baselineMarkdown: string;
	slideDiffs: Map<string, SlideDiffInfo>; // keyed by SectionNode.id
	dirtySlideKeys: string[];
	currentHashesByKey: Record<string, string>;
	descendantDirtyNodeIds: Set<string>;
	deletedSections: DeletedSectionItem[];
	inlineDeletedByParentId: Map<string, DeletedSectionItem[]>;
	totalDirtySlides: number;
}

interface FlatSectionSlice {
	heading: string;
	level: number;
	title: string;
	normTitle: string;
	parentNormTitle: string | null;
	prevSiblingNormTitle: string | null;
	ownLines: string[];
	ownMarkdown: string;
}

export const DEFAULT_BLOCK_DIFF_THRESHOLD = 0.25;

export function stripFrontmatter(md: string): string {
	return md.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n*/, "");
}

export function normalizeTitle(title: string): string {
	return stripHeadingLinksToPlainText(title)
		.toLowerCase()
		.replace(/^[0-9.\s\-:#]+/, "")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeTextForHash(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Fast deterministic 64-bit hex hash (FNV-1a pair) without Node crypto dependency.
 */
export function hashText(text: string): string {
	const s = normalizeTextForHash(text);
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b9;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 ^= c;
		h1 = Math.imul(h1, 0x01000193);
		h2 ^= c + i;
		h2 = Math.imul(h2, 0x85ebca6b);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function parseFencedBlock(block: string): { lang: string; inner: string; isTextProse: boolean } | null {
	const m = block.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n {0,3}\1[ \t]*$/);
	if (!m) return null;
	const lang = m[2].trim().split(/\s+/)[0]?.toLowerCase() || "";
	const isTextProse = lang === "text" || lang === "plain" || lang === "txt";
	return { lang, inner: m[3], isTextProse };
}

function splitMarkdownIntoFlatOwnSections(markdown: string): FlatSectionSlice[] {
	const clean = stripFrontmatter(markdown);
	const lines = clean.split("\n");
	const sections: FlatSectionSlice[] = [];
	const headingStack: Array<{ level: number; normTitle: string; lastChildNormTitle: string | null }> = [];
	let topLevelLastNormTitle: string | null = null;

	let currHeading = "";
	let currLevel = 0;
	let currTitle = "Preamble";
	let currParentNormTitle: string | null = null;
	let currPrevSiblingNormTitle: string | null = null;
	let currLines: string[] = [];
	let inFenceChar = "";
	let inFenceLen = 0;

	const pushCurrent = () => {
		if (currHeading || currLines.some((l) => l.trim().length > 0)) {
			const ownMarkdown = currHeading
				? [currHeading, ...currLines].join("\n").trim()
				: currLines.join("\n").trim();
			sections.push({
				heading: currHeading,
				level: currLevel,
				title: currTitle,
				normTitle: normalizeTitle(currTitle),
				parentNormTitle: currParentNormTitle,
				prevSiblingNormTitle: currPrevSiblingNormTitle,
				ownLines: currLines,
				ownMarkdown,
			});
		}
	};

	for (const line of lines) {
		if (!inFenceChar) {
			const mFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
			if (mFence && !(mFence[1][0] === "`" && mFence[2].includes("`"))) {
				inFenceChar = mFence[1][0];
				inFenceLen = mFence[1].length;
				currLines.push(line);
				continue;
			}
		} else {
			const closeRe = new RegExp(`^ {0,3}${inFenceChar}{${inFenceLen},}[ \\t]*$`);
			if (closeRe.test(line)) {
				inFenceChar = "";
				inFenceLen = 0;
			}
			currLines.push(line);
			continue;
		}

		const mHead = line.match(/^(#{1,6})\s+(.+)$/);
		if (mHead) {
			pushCurrent();
			currLevel = mHead[1].length;
			currTitle = mHead[2].trim();
			const currNormTitle = normalizeTitle(currTitle);
			currHeading = `${mHead[1]} ${currTitle}`;
			while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= currLevel) {
				headingStack.pop();
			}
			const parentFrame = headingStack.length > 0 ? headingStack[headingStack.length - 1] : null;
			currParentNormTitle = parentFrame ? parentFrame.normTitle : null;
			currPrevSiblingNormTitle = parentFrame ? parentFrame.lastChildNormTitle : topLevelLastNormTitle;
			if (parentFrame) {
				parentFrame.lastChildNormTitle = currNormTitle;
			} else {
				topLevelLastNormTitle = currNormTitle;
			}
			headingStack.push({ level: currLevel, normTitle: currNormTitle, lastChildNormTitle: null });
			currLines = [];
		} else {
			currLines.push(line);
		}
	}

	pushCurrent();
	return sections;
}

function isListItemLine(line: string): boolean {
	return /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/.test(line);
}

function splitSectionIntoBlocks(lines: string[]): string[] {
	const blocks: string[] = [];
	let buf: string[] = [];
	let inFenceChar = "";
	let inFenceLen = 0;

	const flush = () => {
		const joined = buf.join("\n").trim();
		if (joined) blocks.push(joined);
		buf = [];
	};

	for (const line of lines) {
		if (!inFenceChar) {
			const mFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
			if (mFence && !(mFence[1][0] === "`" && mFence[2].includes("`"))) {
				flush();
				inFenceChar = mFence[1][0];
				inFenceLen = mFence[1].length;
				buf.push(line);
				continue;
			}
		} else {
			buf.push(line);
			const closeRe = new RegExp(`^ {0,3}${inFenceChar}{${inFenceLen},}[ \\t]*$`);
			if (closeRe.test(line)) {
				inFenceChar = "";
				inFenceLen = 0;
				flush();
			}
			continue;
		}

		if (line.trim() === "") {
			flush();
		} else if (isListItemLine(line)) {
			// Split each bullet/task item cleanly into its own block for surgical list diffs
			flush();
			buf.push(line);
		} else {
			buf.push(line);
		}
	}
	flush();
	return blocks;
}

function tokenizeWordsProtectingMath(text: string): string[] {
	const mathMap = new Map<string, string>();
	let idx = 0;
	let masked = text.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
		const tok = `@@MATHD${idx++}@@`;
		mathMap.set(tok, m);
		return tok;
	});
	masked = masked.replace(/(?<!\$)\$(?!\$)([^\n$]+?)(?<!\$)\$(?!\$)/g, (m) => {
		const tok = `@@MATHI${idx++}@@`;
		mathMap.set(tok, m);
		return tok;
	});
	masked = masked.replace(/`[^`\n]+`/g, (m) => {
		const tok = `@@CODEI${idx++}@@`;
		mathMap.set(tok, m);
		return tok;
	});
	// Protect Obsidian wikilinks & Markdown links as atomic tokens so inline <ins>/<del> never breaks link syntax
	masked = masked.replace(/!?\[\[[^\]]+\]\]/g, (m) => {
		const tok = `@@WIKI${idx++}@@`;
		mathMap.set(tok, m);
		return tok;
	});
	masked = masked.replace(/!?\[[^\]\n]+\]\([^)\n]+\)/g, (m) => {
		const tok = `@@MDLK${idx++}@@`;
		mathMap.set(tok, m);
		return tok;
	});

	const rawTokens = masked.match(/@@(?:MATHD|MATHI|CODEI|WIKI|MDLK)\d+@@|\S+|\s+/g) || [];
	return rawTokens.map((t) =>
		t.replace(/@@(?:MATHD|MATHI|CODEI|WIKI|MDLK)\d+@@/g, (tok) => mathMap.get(tok) ?? tok)
	);
}

type OpTag = "equal" | "delete" | "insert" | "replace";
interface DiffOpcode {
	tag: OpTag;
	i1: number;
	i2: number;
	j1: number;
	j2: number;
}

function computeOpcodes(a: string[], b: string[]): DiffOpcode[] {
	const n = a.length;
	const m = b.length;
	if (n === 0 && m === 0) return [];
	if (n === 0) return [{ tag: "insert", i1: 0, i2: 0, j1: 0, j2: m }];
	if (m === 0) return [{ tag: "delete", i1: 0, i2: n, j1: 0, j2: 0 }];

	if (n * m > 4_000_000) {
		if (a.join("") === b.join("")) {
			return [{ tag: "equal", i1: 0, i2: n, j1: 0, j2: m }];
		}
		return [{ tag: "replace", i1: 0, i2: n, j1: 0, j2: m }];
	}

	const dp = new Uint16Array((n + 1) * (m + 1));
	const width = m + 1;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
			} else {
				const down = dp[(i + 1) * width + j];
				const right = dp[i * width + (j + 1)];
				dp[i * width + j] = down >= right ? down : right;
			}
		}
	}

	const matches: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			matches.push([i, j]);
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
			i++;
		} else {
			j++;
		}
	}

	const ops: DiffOpcode[] = [];
	let ci = 0;
	let cj = 0;
	let k = 0;
	while (k < matches.length) {
		const [mi, mj] = matches[k];
		if (ci < mi || cj < mj) {
			const tag: OpTag = ci < mi && cj < mj ? "replace" : ci < mi ? "delete" : "insert";
			ops.push({ tag, i1: ci, i2: mi, j1: cj, j2: mj });
		}
		let endI = mi + 1;
		let endJ = mj + 1;
		k++;
		while (k < matches.length && matches[k][0] === endI && matches[k][1] === endJ) {
			endI++;
			endJ++;
			k++;
		}
		ops.push({ tag: "equal", i1: mi, i2: endI, j1: mj, j2: endJ });
		ci = endI;
		cj = endJ;
	}
	if (ci < n || cj < m) {
		const tag: OpTag = ci < n && cj < m ? "replace" : ci < n ? "delete" : "insert";
		ops.push({ tag, i1: ci, i2: n, j1: cj, j2: m });
	}
	return ops;
}

function wrapBlockSpan(block: string, isInsert: boolean): string {
	const tag = isInsert ? "ins" : "del";
	const cls = isInsert ? "dv-ins" : "dv-del";
	const parsedFence = parseFencedBlock(block);
	if (parsedFence) {
		if (parsedFence.lang === "mermaid") {
			// Keep mermaid fenced block renderable by Obsidian inside a tinted diff container
			return `<div class="dv-block-${tag}">\n\n${block}\n\n</div>`;
		}
		const langAttr = parsedFence.lang ? ` class="language-${escapeHtml(parsedFence.lang)}"` : "";
		return `<pre class="dv-pre-${tag}"><code${langAttr}>${escapeHtml(parsedFence.inner)}</code></pre>`;
	}
	// Preserve list / task / blockquote prefix outside inline span for single-line items
	const prefixMatch = block.match(/^(\s*(?:>+\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+))([\s\S]*)$/);
	if (prefixMatch && !prefixMatch[2].includes("\n")) {
		return `${prefixMatch[1]}<${tag} class="${cls}">${prefixMatch[2]}</${tag}>`;
	}
	return `<div class="dv-block-${tag}">\n\n${block}\n\n</div>`;
}

function diffTwoBlocks(
	oldB: string,
	newB: string,
	blockDiffThreshold: number
): { out: string; ins: number; del: number } | null {
	if (oldB === newB) return { out: newB, ins: 0, del: 0 };

	if (/^ {0,3}(`{3,}|~{3,})/.test(oldB) || /^ {0,3}(`{3,}|~{3,})/.test(newB)) {
		return null;
	}
	// Tables: compare as full blocks so Markdown table structure never breaks
	if (/^\|.*\|/.test(oldB) || /^\|.*\|/.test(newB)) {
		return null;
	}

	const oldPref = oldB.match(/^(\s*(?:>+\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+))([\s\S]*)$/);
	const newPref = newB.match(/^(\s*(?:>+\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+))([\s\S]*)$/);
	let prefix = "";
	let oldBody = oldB;
	let newBody = newB;

	if (
		oldPref &&
		newPref &&
		oldPref[1].trim() === newPref[1].trim() &&
		!oldPref[2].includes("\n") &&
		!newPref[2].includes("\n")
	) {
		prefix = newPref[1];
		oldBody = oldPref[2];
		newBody = newPref[2];
	} else if (oldB.includes("\n>") || newB.includes("\n>")) {
		const stripQ = (s: string) => s.replace(/^\s*> ?/gm, "");
		const oldStripped = stripQ(oldB);
		const newStripped = stripQ(newB);
		const newCallout = newStripped.match(/^(\[![A-Za-z-]+\][+-]?[ \t]*)/);
		const oldCallout = oldStripped.match(/^(\[![A-Za-z-]+\][+-]?[ \t]*)/);
		if (newCallout) {
			const oRest = oldCallout ? oldStripped.slice(oldCallout[1].length) : oldStripped;
			const nRest = newStripped.slice(newCallout[1].length);
			const sub = diffTwoBlocks(oRest, nRest, blockDiffThreshold);
			if (!sub) return null;
			const reQuoted = `${newCallout[1]}${sub.out}`
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n");
			return { out: reQuoted, ins: sub.ins, del: sub.del };
		}
		const sub = diffTwoBlocks(oldStripped, newStripped, blockDiffThreshold);
		if (!sub) return null;
		const reQuoted = sub.out
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		return { out: reQuoted, ins: sub.ins, del: sub.del };
	}

	const aToks = tokenizeWordsProtectingMath(oldBody);
	const bToks = tokenizeWordsProtectingMath(newBody);
	const ops = computeOpcodes(aToks, bToks);

	let equalChars = 0;
	const totalOldChars = oldBody.length || 1;
	const totalNewChars = newBody.length || 1;
	for (const op of ops) {
		if (op.tag === "equal") {
			equalChars += aToks.slice(op.i1, op.i2).join("").length;
		}
	}
	const similarity = (2 * equalChars) / (totalOldChars + totalNewChars);
	if (1 - similarity >= blockDiffThreshold) {
		return null;
	}

	let out = prefix;
	let ins = 0;
	let del = 0;
	for (const op of ops) {
		if (op.tag === "equal") {
			out += aToks.slice(op.i1, op.i2).join("");
		} else if (op.tag === "delete") {
			const seg = aToks.slice(op.i1, op.i2).join("");
			if (seg.trim()) {
				out += `<del class="dv-del">${seg}</del>`;
				del++;
			} else {
				out += seg;
			}
		} else if (op.tag === "insert") {
			const seg = bToks.slice(op.j1, op.j2).join("");
			if (seg.trim()) {
				out += `<ins class="dv-ins">${seg}</ins>`;
				ins++;
			} else {
				out += seg;
			}
		} else if (op.tag === "replace") {
			const delSeg = aToks.slice(op.i1, op.i2).join("");
			const insSeg = bToks.slice(op.j1, op.j2).join("");
			if (delSeg.trim()) {
				out += `<del class="dv-del">${delSeg}</del>`;
				del++;
			}
			if (delSeg.trim() && insSeg.trim()) {
				out += " ";
			}
			if (insSeg.trim()) {
				out += `<ins class="dv-ins">${insSeg}</ins>`;
				ins++;
			}
		}
	}
	return { out, ins, del };
}

function titleSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
	const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
	if (setA.size === 0 || setB.size === 0) return 0;
	let inter = 0;
	for (const w of setA) {
		if (setB.has(w)) inter++;
	}
	return inter / Math.max(setA.size, setB.size);
}

function diffSingleSlideMarkdown(
	oldSlideMd: string | null,
	newSlideMd: string,
	blockDiffThreshold: number
): { diffMarkdown: string; addedCount: number; removedCount: number; hasChanges: boolean } {
	const cleanNew = newSlideMd.replace(/\r\n/g, "\n").trim();
	if (oldSlideMd === null) {
		// Newly added slide
		const lines = cleanNew.split("\n");
		const firstLine = lines[0] || "";
		const headMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);
		const outParts: string[] = [];
		let addedCount = 0;
		let bodyLines = lines;
		if (headMatch) {
			outParts.push(`${headMatch[1]} <ins class="dv-ins">${headMatch[2].trim()}</ins>`);
			addedCount++;
			bodyLines = lines.slice(1);
		}
		for (const b of splitSectionIntoBlocks(bodyLines)) {
			outParts.push(wrapBlockSpan(b, true));
			addedCount++;
		}
		return {
			diffMarkdown: outParts.join("\n\n"),
			addedCount,
			removedCount: 0,
			hasChanges: addedCount > 0,
		};
	}

	const cleanOld = oldSlideMd.replace(/\r\n/g, "\n").trim();
	if (cleanOld === cleanNew) {
		return {
			diffMarkdown: cleanNew,
			addedCount: 0,
			removedCount: 0,
			hasChanges: false,
		};
	}

	const oldLines = cleanOld.split("\n");
	const newLines = cleanNew.split("\n");

	let oldBodyLines = oldLines;
	let newBodyLines = newLines;
	const outParts: string[] = [];
	let addedCount = 0;
	let removedCount = 0;

	const oldHead = (oldLines[0] || "").match(/^(#{1,6})\s+(.+)$/);
	const newHead = (newLines[0] || "").match(/^(#{1,6})\s+(.+)$/);
	if (oldHead && newHead) {
		oldBodyLines = oldLines.slice(1);
		newBodyLines = newLines.slice(1);
		const oTitle = oldHead[2].trim();
		const nTitle = newHead[2].trim();
		if (oTitle !== nTitle) {
			const hDiff = diffTwoBlocks(oTitle, nTitle, blockDiffThreshold);
			if (hDiff) {
				outParts.push(`${newHead[1]} ${hDiff.out}`);
				addedCount += hDiff.ins;
				removedCount += hDiff.del;
			} else {
				outParts.push(`${newHead[1]} <del class="dv-del">${oTitle}</del> <ins class="dv-ins">${nTitle}</ins>`);
				addedCount++;
				removedCount++;
			}
		} else {
			outParts.push(`${newHead[1]} ${nTitle}`);
		}
	} else if (newHead) {
		newBodyLines = newLines.slice(1);
		outParts.push(`${newHead[1]} <ins class="dv-ins">${newHead[2].trim()}</ins>`);
		addedCount++;
	}

	const oBlocks = splitSectionIntoBlocks(oldBodyLines);
	const nBlocks = splitSectionIntoBlocks(newBodyLines);
	const ops = computeOpcodes(oBlocks, nBlocks);

	for (const op of ops) {
		if (op.tag === "equal") {
			for (let k = op.j1; k < op.j2; k++) {
				outParts.push(nBlocks[k]);
			}
		} else if (op.tag === "delete") {
			for (let k = op.i1; k < op.i2; k++) {
				outParts.push(wrapBlockSpan(oBlocks[k], false));
				removedCount++;
			}
		} else if (op.tag === "insert") {
			for (let k = op.j1; k < op.j2; k++) {
				outParts.push(wrapBlockSpan(nBlocks[k], true));
				addedCount++;
			}
		} else if (op.tag === "replace") {
			const delSlice = oBlocks.slice(op.i1, op.i2);
			const insSlice = nBlocks.slice(op.j1, op.j2);
			const pairCount = Math.min(delSlice.length, insSlice.length);
			for (let p = 0; p < pairCount; p++) {
				const inline = diffTwoBlocks(delSlice[p], insSlice[p], blockDiffThreshold);
				if (inline) {
					outParts.push(inline.out);
					addedCount += inline.ins;
					removedCount += inline.del;
				} else {
					outParts.push(wrapBlockSpan(delSlice[p], false));
					outParts.push(wrapBlockSpan(insSlice[p], true));
					removedCount++;
					addedCount++;
				}
			}
			for (let p = pairCount; p < delSlice.length; p++) {
				outParts.push(wrapBlockSpan(delSlice[p], false));
				removedCount++;
			}
			for (let p = pairCount; p < insSlice.length; p++) {
				outParts.push(wrapBlockSpan(insSlice[p], true));
				addedCount++;
			}
		}
	}

	return {
		diffMarkdown: outParts.join("\n\n"),
		addedCount,
		removedCount,
		hasChanges: addedCount > 0 || removedCount > 0,
	};
}

function extractSignificantWords(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 4);
	return new Set(words);
}

function bodyWordSimilarity(oldBody: string, newBody: string): number {
	const setA = extractSignificantWords(oldBody);
	const setB = extractSignificantWords(newBody);
	if (setA.size === 0 || setB.size === 0) return 0;
	let inter = 0;
	for (const w of setA) {
		if (setB.has(w)) inter++;
	}
	return (2 * inter) / (setA.size + setB.size);
}

function buildDeletedSectionDiffMarkdown(slice: FlatSectionSlice): string {
	const outParts: string[] = [];
	const hashes = "#".repeat(Math.min(6, Math.max(1, slice.level || 2)));
	outParts.push(`${hashes} <del class="dv-del">${slice.title}</del>`);
	outParts.push(`<div class="slideflow-deleted-sections-title">Section removed since last review</div>`);
	for (const b of splitSectionIntoBlocks(slice.ownLines)) {
		outParts.push(wrapBlockSpan(b, false));
	}
	return outParts.join("\n\n");
}

export function buildNoteDiffContext(
	notePath: string,
	baselineMarkdown: string,
	currentMarkdown: string,
	flatNodes: SectionNode[],
	seenSlides: Record<string, SeenSlideRecord> = {},
	blockDiffThreshold: number = DEFAULT_BLOCK_DIFF_THRESHOLD
): NoteDiffContext {
	const oldSlices = splitMarkdownIntoFlatOwnSections(baselineMarkdown);
	const usedOld = new Set<number>();
	const slideDiffs = new Map<string, SlideDiffInfo>();
	const dirtySlideKeys: string[] = [];
	const currentHashesByKey: Record<string, string> = {};
	const descendantDirtyNodeIds = new Set<string>();

	const realFlatNodes = flatNodes.filter((n) => !n.isVirtualDeleted);
	const hasHeadings = realFlatNodes.length > 1;
	const targetNodes = hasHeadings ? realFlatNodes.slice(1) : realFlatNodes;

	// Best-first greedy matching combining heading similarity & body content overlap so
	// renamed/updated subsections match their own predecessor instead of spawning ghost deletions.
	const matchedOldIdxByNodeIdx = new Map<number, number>();
	const candidatePairs: Array<{ nodeIdx: number; oldIdx: number; score: number }> = [];

	for (let nodeIdx = 0; nodeIdx < targetNodes.length; nodeIdx++) {
		const node = targetNodes[nodeIdx];
		if (node.level === 0) continue;
		const normT = normalizeTitle(node.title);
		const currBody = node.rawOwnMarkdown.replace(/\r\n/g, "\n").split("\n").slice(1).join("\n");

		for (let oldIdx = 0; oldIdx < oldSlices.length; oldIdx++) {
			const o = oldSlices[oldIdx];
			if (o.level === 0) continue;

			if (o.normTitle === normT && o.level === node.level) {
				candidatePairs.push({ nodeIdx, oldIdx, score: 1.0 });
				continue;
			}
			if (o.normTitle === normT) {
				candidatePairs.push({ nodeIdx, oldIdx, score: 0.99 });
				continue;
			}

			const tSim = titleSimilarity(o.normTitle, normT);
			const bSim = bodyWordSimilarity(o.ownLines.join("\n"), currBody);

			if (o.level === node.level) {
				const combined = Math.max(tSim, bSim * 0.95, 0.55 * tSim + 0.45 * bSim);
				if (combined >= 0.40 || (tSim >= 0.32 && bSim >= 0.22)) {
					candidatePairs.push({ nodeIdx, oldIdx, score: combined });
				}
			} else if (tSim >= 0.55 || (tSim >= 0.40 && bSim >= 0.45)) {
				candidatePairs.push({ nodeIdx, oldIdx, score: Math.max(tSim, 0.5 * tSim + 0.5 * bSim) * 0.92 });
			}
		}
	}

	candidatePairs.sort((a, b) => b.score - a.score);
	for (const pair of candidatePairs) {
		if (matchedOldIdxByNodeIdx.has(pair.nodeIdx) || usedOld.has(pair.oldIdx)) continue;
		matchedOldIdxByNodeIdx.set(pair.nodeIdx, pair.oldIdx);
		usedOld.add(pair.oldIdx);
	}

	const keyOccurrences = new Map<string, number>();

	for (let nodeIdx = 0; nodeIdx < targetNodes.length; nodeIdx++) {
		const node = targetNodes[nodeIdx];
		const normT = node.level === 0 ? "root" : normalizeTitle(node.title);
		const baseKey = `L${node.level}:${normT}`;
		const occ = (keyOccurrences.get(baseKey) || 0) + 1;
		keyOccurrences.set(baseKey, occ);
		const slideKey = occ === 1 ? baseKey : `${baseKey}#${occ}`;

		const currentOwnMd = node.rawOwnMarkdown.replace(/\r\n/g, "\n").trim();
		const currentHash = hashText(currentOwnMd);

		let matchedIdx = -1;
		if (node.level === 0) {
			matchedIdx = oldSlices.findIndex((s, idx) => !usedOld.has(idx) && s.level === 0);
			if (matchedIdx !== -1) usedOld.add(matchedIdx);
		} else {
			matchedIdx = matchedOldIdxByNodeIdx.get(nodeIdx) ?? -1;
		}

		let baselineOwnMd: string | null = null;
		if (matchedIdx !== -1) {
			baselineOwnMd = oldSlices[matchedIdx].ownMarkdown;
		} else if (node.level === 0) {
			baselineOwnMd = stripFrontmatter(baselineMarkdown).trim();
		}

		// Respect per-slide read tracking (`seenSlides`):
		// If already validated at this exact content hash, no diff!
		// If the slide changed AGAIN since validation, diff against the text last validated!
		const seenRec = seenSlides[slideKey];
		let effectiveOldMd: string | null = baselineOwnMd;
		let alreadySeenUnchanged = false;

		if (seenRec) {
			if (seenRec.hash === currentHash) {
				alreadySeenUnchanged = true;
			} else {
				effectiveOldMd = seenRec.text;
			}
		}

		let info: SlideDiffInfo;
		if (alreadySeenUnchanged) {
			info = {
				slideKey,
				hasChanges: false,
				diffMarkdown: currentOwnMd,
				rawNewMarkdown: currentOwnMd,
				rawOldMarkdown: currentOwnMd,
				addedCount: 0,
				removedCount: 0,
				currentHash,
			};
		} else {
			const res = diffSingleSlideMarkdown(effectiveOldMd, currentOwnMd, blockDiffThreshold);
			info = {
				slideKey,
				hasChanges: res.hasChanges,
				diffMarkdown: res.diffMarkdown,
				rawNewMarkdown: currentOwnMd,
				rawOldMarkdown: effectiveOldMd,
				addedCount: res.addedCount,
				removedCount: res.removedCount,
				currentHash,
			};
		}

		slideDiffs.set(node.id, info);
		currentHashesByKey[slideKey] = currentHash;

		if (info.hasChanges) {
			dirtySlideKeys.push(slideKey);
			let p = node.parent;
			while (p) {
				descendantDirtyNodeIds.add(p.id);
				p = p.parent;
			}
		}
	}

	// Collect any truly deleted baseline sections:
	// - Title-only deleted subsections (no body other than whitespace/horizontal rules and no deleted children)
	//   stay inline on their parent slide and validate immediately with the parent's Ctrl+Enter.
	// - Deleted sections with body content become standalone virtual slides placed in exact DFS tree order
	//   (NEVER dumped inside a parent slide and NEVER stranded at the end of the presentation!).
	const deletedSections: DeletedSectionItem[] = [];
	const delKeyOcc = new Map<string, number>();
	const unseenDeletedCandidates: Array<{
		idx: number;
		slice: FlatSectionSlice;
		delSlideKey: string;
		delHash: string;
	}> = [];

	for (let idx = 0; idx < oldSlices.length; idx++) {
		if (usedOld.has(idx)) continue;
		const o = oldSlices[idx];
		if (!o.ownMarkdown.trim()) continue;
		if (o.level === 0 && hasHeadings) continue;

		const baseDelKey = `__deleted__:L${o.level}:${o.normTitle || "section"}`;
		const occ = (delKeyOcc.get(baseDelKey) || 0) + 1;
		delKeyOcc.set(baseDelKey, occ);
		const delSlideKey = occ === 1 ? baseDelKey : `${baseDelKey}#${occ}`;
		const delHash = hashText(o.ownMarkdown);

		const seenDel = seenSlides[delSlideKey];
		if (seenDel && seenDel.hash === delHash) {
			continue;
		}

		unseenDeletedCandidates.push({ idx, slice: o, delSlideKey, delHash });
	}

	for (const cand of unseenDeletedCandidates) {
		const { idx, slice: o, delSlideKey, delHash } = cand;
		const hasDeletedChild = unseenDeletedCandidates.some(
			(other) =>
				other.idx !== idx &&
				other.slice.parentNormTitle === o.normTitle &&
				other.slice.level > o.level
		);
		const bodyOnly = o.ownLines
			.join("\n")
			.replace(/^[\s\-*_]+$/gm, "")
			.trim();
		const isTitleOnly = bodyOnly.length === 0 && !hasDeletedChild;

		const id = `deleted-section-${idx}`;
		const diffMarkdown = buildDeletedSectionDiffMarkdown(o);
		const displayTitle = stripHeadingLinksToPlainText(o.title) || o.title;

		deletedSections.push({
			id,
			slideKey: delSlideKey,
			title: o.title,
			displayTitle,
			level: o.level || 2,
			parentNormTitle: o.parentNormTitle,
			prevSiblingNormTitle: o.prevSiblingNormTitle,
			isTitleOnly,
			diffMarkdown,
			rawOldMarkdown: o.ownMarkdown,
			hash: delHash,
		});

		if (!isTitleOnly) {
			slideDiffs.set(id, {
				slideKey: delSlideKey,
				hasChanges: true,
				diffMarkdown,
				rawNewMarkdown: "",
				rawOldMarkdown: o.ownMarkdown,
				addedCount: 0,
				removedCount: Math.max(1, splitSectionIntoBlocks(o.ownLines).length),
				currentHash: delHash,
			});
		}
		dirtySlideKeys.push(delSlideKey);
		currentHashesByKey[delSlideKey] = delHash;
	}

	return {
		notePath,
		baselineMarkdown,
		slideDiffs,
		dirtySlideKeys,
		currentHashesByKey,
		descendantDirtyNodeIds,
		deletedSections,
		inlineDeletedByParentId: new Map<string, DeletedSectionItem[]>(),
		totalDirtySlides: dirtySlideKeys.length,
	};
}
