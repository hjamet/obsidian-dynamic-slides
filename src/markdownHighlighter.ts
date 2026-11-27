/**
 * markdownHighlighter.ts — Clean, syntax-safe persistent Obsidian highlighting (`==...==`)
 * for SlideFlow (`H` shortcut).
 *
 * Handles:
 * - Inline selections inside a single line (expanding cleanly past inline syntax tokens like
 *   `**bold**`, `` `code` ``, `$math$`, `[[wikilink]]`, `[text](url)` so Markdown is never broken)
 * - Multi-line selections spanning paragraphs, bullets, numbered lists, tasks, or blockquotes
 *   (applied per-line AFTER each line's Markdown structural prefix)
 * - Focused semantic blocks (paragraph, list item, heading, blockquote, callout)
 * - Markdown tables (entire body OR a single selected `<tr>` row in Table Zoom), applied
 *   cell-by-cell while preserving `|`, escaped `\|`, and wikilink pipes `[[path|alias]]`
 * - Clean toggle behavior (highlights when unhighlighted, removes `==...==` when already highlighted)
 * - Preserves original line endings (CRLF vs LF) and refuses to corrupt fenced code blocks
 */

export interface HighlightToggleResult {
	changed: boolean;
	action: "added" | "removed" | "unsupported" | "not_found";
	reason?: string;
	updatedMarkdown: string;
	affectedLineStart?: number;
	affectedLineEnd?: number;
}

export interface BlockHighlightTarget {
	kind: "selection" | "block" | "table_row" | "table";
	plainText: string;
	prefixText?: string;
	suffixText?: string;
	tagName?: string;
	/** 0-based index of the table within the active section (for table / table_row) */
	tableIndex?: number;
	/** 0-based index of the body row inside that table (for table_row; skips header + separator) */
	rowIndex?: number;
}

const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CALLOUT_HEADER_RE = /^(\s*(?:>\s*)+)\[![^\]]+\][+-]?\s*(.*)$/;

/**
 * Splits a Markdown table row into cell segments while respecting escaped pipes `\|`,
 * Obsidian wikilink pipes `[[target|alias]]`, and inline code spans `` `...` ``.
 */
export function splitMarkdownTableRow(line: string): {
	leadingPipe: boolean;
	trailingPipe: boolean;
	leadingIndent: string;
	cells: string[];
} | null {
	const indentMatch = line.match(/^(\s*)/);
	const leadingIndent = indentMatch ? indentMatch[1] : "";
	const trimmed = line.trim();
	if (!trimmed || !trimmed.includes("|")) return null;

	const pipePositions: number[] = [];
	let inCode = false;
	let wikiDepth = 0;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && i + 1 < trimmed.length) {
			i++;
			continue;
		}
		if (ch === "`") {
			inCode = !inCode;
			continue;
		}
		if (inCode) continue;
		if (ch === "[" && trimmed[i + 1] === "[") {
			wikiDepth++;
			i++;
			continue;
		}
		if (ch === "]" && trimmed[i + 1] === "]" && wikiDepth > 0) {
			wikiDepth--;
			i++;
			continue;
		}
		if (ch === "|" && wikiDepth === 0) {
			pipePositions.push(i);
		}
	}

	if (pipePositions.length === 0) return null;

	const leadingPipe = pipePositions[0] === 0;
	const trailingPipe = pipePositions[pipePositions.length - 1] === trimmed.length - 1;
	const innerStarts: number[] = [];
	const innerEnds: number[] = [];

	if (leadingPipe) {
		for (let k = 0; k < pipePositions.length - 1; k++) {
			innerStarts.push(pipePositions[k] + 1);
			innerEnds.push(pipePositions[k + 1]);
		}
		if (!trailingPipe) {
			innerStarts.push(pipePositions[pipePositions.length - 1] + 1);
			innerEnds.push(trimmed.length);
		}
	} else {
		innerStarts.push(0);
		innerEnds.push(pipePositions[0]);
		for (let k = 0; k < pipePositions.length - 1; k++) {
			innerStarts.push(pipePositions[k] + 1);
			innerEnds.push(pipePositions[k + 1]);
		}
		if (!trailingPipe) {
			innerStarts.push(pipePositions[pipePositions.length - 1] + 1);
			innerEnds.push(trimmed.length);
		}
	}

	const cells: string[] = [];
	for (let k = 0; k < innerStarts.length; k++) {
		cells.push(trimmed.slice(innerStarts[k], innerEnds[k]));
	}
	if (cells.length === 0) return null;

	return { leadingPipe, trailingPipe, leadingIndent, cells };
}

export function isMarkdownTableSeparator(line: string): boolean {
	return TABLE_SEP_RE.test(line);
}

export function isMarkdownTableRow(line: string): boolean {
	if (!line.includes("|") || isMarkdownTableSeparator(line)) return false;
	const parsed = splitMarkdownTableRow(line);
	return Boolean(parsed && parsed.cells.length >= 2);
}

/**
 * Checks whether a trimmed Markdown text segment is already fully highlighted with `==...==`.
 */
export function isSegmentFullyHighlighted(raw: string): boolean {
	const trimmed = raw.trim();
	if (trimmed.length < 5) return false;
	if (!trimmed.startsWith("==") || !trimmed.endsWith("==")) return false;
	// Verify that no earlier closing `==` leaves unhighlighted text in the middle
	const inner = trimmed.slice(2, -2);
	if (!inner.includes("==")) return true;
	// Allow multiple contiguous `==a== ==b==` if no unhighlighted non-whitespace lies outside
	const withoutMarks = trimmed.replace(/==[^=\n](?:[\s\S]*?[^=\n])?==/g, "");
	return withoutMarks.trim().length === 0;
}

/**
 * Wraps or unwraps an inline text segment cleanly with Obsidian `==...==`, preserving outer whitespace.
 */
export function applyInlineMark(
	raw: string,
	action: "add" | "remove"
): { text: string; changed: boolean } {
	const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
	if (!m) return { text: raw, changed: false };
	const [, lead, core, trail] = m;
	if (!core) return { text: raw, changed: false };

	if (action === "remove") {
		const stripped = core.replace(/==([\s\S]*?)==/g, "$1");
		const next = `${lead}${stripped}${trail}`;
		return { text: next, changed: next !== raw };
	}

	if (isSegmentFullyHighlighted(core)) {
		return { text: raw, changed: false };
	}
	// Strip any partial inner `==` markers so highlighting the whole segment stays clean and balanced
	const cleanCore = core.replace(/==([\s\S]*?)==/g, "$1");
	const next = `${lead}==${cleanCore}==${trail}`;
	return { text: next, changed: next !== raw };
}

/**
 * Splits a non-table Markdown line into its structural prefix (blockquote `> `, heading `## `,
 * list/task marker `- [ ] `, `1. `) and its highlightable content.
 */
function splitLinePrefixAndContent(line: string): {
	prefix: string;
	content: string;
	skip: boolean;
} {
	const trimmed = line.trim();
	if (!trimmed) return { prefix: line, content: "", skip: true };
	if (/^[-*_]{3,}\s*$/.test(trimmed)) return { prefix: line, content: "", skip: true };
	if (/^<!--[\s\S]*-->$/.test(trimmed)) return { prefix: line, content: "", skip: true };
	if (FENCE_RE.test(line)) return { prefix: line, content: "", skip: true };

	// Callout header line: `> [!note] Optional title` -> skip during multi-line block highlight
	if (CALLOUT_HEADER_RE.test(line)) {
		return { prefix: line, content: "", skip: true };
	}

	let rest = line;
	let prefix = "";

	// 1. Optional leading blockquote markers (`> `, `> > `)
	const bqMatch = rest.match(/^(\s*(?:>\s*)+)/);
	if (bqMatch) {
		prefix += bqMatch[1];
		rest = rest.slice(bqMatch[1].length);
	}

	// 2. Heading marker (`## `)
	const headMatch = rest.match(/^(\s*#{1,6}\s+)/);
	if (headMatch) {
		prefix += headMatch[1];
		rest = rest.slice(headMatch[1].length);
		return { prefix, content: rest, skip: rest.trim().length === 0 };
	}

	// 3. List or task marker (`- `, `* `, `+ `, `- [ ] `, `1. `, `2) `)
	const listMatch = rest.match(/^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+))/);
	if (listMatch) {
		prefix += listMatch[1];
		rest = rest.slice(listMatch[1].length);
		return { prefix, content: rest, skip: rest.trim().length === 0 };
	}

	// 4. Plain paragraph line (preserve leading indentation)
	const indentMatch = rest.match(/^(\s*)/);
	if (indentMatch) {
		prefix += indentMatch[1];
		rest = rest.slice(indentMatch[1].length);
	}

	return { prefix, content: rest, skip: rest.trim().length === 0 };
}

/**
 * Checks whether a single Markdown table row has all non-empty cells already highlighted.
 */
function isTableRowFullyHighlighted(line: string): boolean {
	const parsed = splitMarkdownTableRow(line);
	if (!parsed) return false;
	const nonEmpty = parsed.cells.filter((c) => c.trim().length > 0);
	if (nonEmpty.length === 0) return false;
	return nonEmpty.every((c) => isSegmentFullyHighlighted(c));
}

/**
 * Applies highlight add/remove cell-by-cell to a single Markdown table row.
 */
function applyTableRowHighlight(line: string, action: "add" | "remove"): { line: string; changed: boolean } {
	const parsed = splitMarkdownTableRow(line);
	if (!parsed) return { line, changed: false };
	let anyChanged = false;
	const newCells = parsed.cells.map((cell) => {
		if (!cell.trim()) return cell;
		const res = applyInlineMark(cell, action);
		if (res.changed) anyChanged = true;
		return res.text;
	});
	if (!anyChanged) return { line, changed: false };
	const joined =
		parsed.leadingIndent +
		(parsed.leadingPipe ? "|" : "") +
		newCells.join("|") +
		(parsed.trailingPipe ? "|" : "");
	return { line: joined, changed: joined !== line };
}

/**
 * Applies highlight add/remove to a range of lines (auto-deciding toggle direction across the range
 * so multi-line blocks toggle uniformly all-ON or all-OFF).
 */
function toggleLinesRange(
	lines: string[],
	startLine: number,
	endLine: number
): { action: "added" | "removed"; changed: boolean; updatedLines: string[] } {
	const next = [...lines];

	// Determine whether every highlightable line/row in the range is already highlighted
	let highlightableCount = 0;
	let alreadyHighlightedCount = 0;

	let inFenceChar: string | null = null;
	let inFenceLen = 0;
	for (let i = startLine; i <= endLine; i++) {
		const line = lines[i];
		const fm = line.match(FENCE_RE);
		if (fm) {
			const ch = fm[1][0];
			if (!inFenceChar) {
				inFenceChar = ch;
				inFenceLen = fm[1].length;
			} else if (ch === inFenceChar && fm[1].length >= inFenceLen && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
				inFenceChar = null;
				inFenceLen = 0;
			}
			continue;
		}
		if (inFenceChar) continue;
		if (isMarkdownTableSeparator(line)) continue;

		if (isMarkdownTableRow(line)) {
			highlightableCount++;
			if (isTableRowFullyHighlighted(line)) alreadyHighlightedCount++;
			continue;
		}

		const split = splitLinePrefixAndContent(line);
		if (split.skip) continue;
		highlightableCount++;
		if (isSegmentFullyHighlighted(split.content)) {
			alreadyHighlightedCount++;
		}
	}

	const action: "add" | "remove" =
		highlightableCount > 0 && alreadyHighlightedCount === highlightableCount ? "remove" : "add";

	let anyChanged = false;
	inFenceChar = null;
	inFenceLen = 0;

	for (let i = startLine; i <= endLine; i++) {
		const line = lines[i];
		const fm = line.match(FENCE_RE);
		if (fm) {
			const ch = fm[1][0];
			if (!inFenceChar) {
				inFenceChar = ch;
				inFenceLen = fm[1].length;
			} else if (ch === inFenceChar && fm[1].length >= inFenceLen && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
				inFenceChar = null;
				inFenceLen = 0;
			}
			continue;
		}
		if (inFenceChar) continue;
		if (isMarkdownTableSeparator(line)) continue;

		if (isMarkdownTableRow(line)) {
			const res = applyTableRowHighlight(line, action);
			if (res.changed) {
				next[i] = res.line;
				anyChanged = true;
			}
			continue;
		}

		const split = splitLinePrefixAndContent(line);
		if (split.skip) continue;
		const res = applyInlineMark(split.content, action);
		if (res.changed) {
			next[i] = `${split.prefix}${res.text}`;
			anyChanged = true;
		}
	}

	return {
		action: action === "add" ? "added" : "removed",
		changed: anyChanged,
		updatedLines: next,
	};
}

/**
 * Strips common Markdown inline formatting (and math delimiters) to plain searchable text.
 */
function stripMarkdownToSearchText(md: string): string {
	return md
		.replace(/^(\s*(?:>\s*)+)/gm, "")
		.replace(/^\s*#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
		.replace(/!\[\[([^\]]+)\]\]/g, "")
		.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/==([\s\S]*?)==/g, "$1")
		.replace(/\*\*([\s\S]*?)\*\*/g, "$1")
		.replace(/__([\s\S]*?)__/g, "$1")
		.replace(/~~([\s\S]*?)~~/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/_([^_\n]+)_/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\$\$([\s\S]*?)\$\$/g, "$1")
		.replace(/\$([^$\n]+)\$/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/\\([|\\*_[\]()`])/g, "$1");
}

function extractMatchTokens(text: string): string[] {
	// Normalize Unicode math italics/accents and extract lowercase alphanumeric words (>= 2 chars)
	const normalized = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	const matches = normalized.match(/[a-z0-9]{2,}/g);
	return matches || [];
}

function tokenOverlapScore(queryTokens: string[], candidateTokens: string[]): number {
	if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
	const candCounts = new Map<string, number>();
	for (const t of candidateTokens) {
		candCounts.set(t, (candCounts.get(t) || 0) + 1);
	}
	let matched = 0;
	for (const t of queryTokens) {
		const cnt = candCounts.get(t) || 0;
		if (cnt > 0) {
			matched++;
			candCounts.set(t, cnt - 1);
		}
	}
	const recall = matched / queryTokens.length;
	const precision = matched / candidateTokens.length;
	if (recall === 0 || precision === 0) return 0;
	return (2 * recall * precision) / (recall + precision);
}

interface MarkdownTableSpan {
	headerLine: number;
	sepLine: number;
	bodyLines: number[];
}

function findTablesInRange(lines: string[], startLine: number, endLine: number): MarkdownTableSpan[] {
	const tables: MarkdownTableSpan[] = [];
	let inFenceChar: string | null = null;
	let inFenceLen = 0;

	let i = startLine;
	while (i <= endLine) {
		const line = lines[i];
		const fm = line.match(FENCE_RE);
		if (fm) {
			const ch = fm[1][0];
			if (!inFenceChar) {
				inFenceChar = ch;
				inFenceLen = fm[1].length;
			} else if (ch === inFenceChar && fm[1].length >= inFenceLen && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
				inFenceChar = null;
				inFenceLen = 0;
			}
			i++;
			continue;
		}
		if (inFenceChar) {
			i++;
			continue;
		}

		if (
			i + 1 <= endLine &&
			line.includes("|") &&
			isMarkdownTableSeparator(lines[i + 1])
		) {
			const headerLine = i;
			const sepLine = i + 1;
			const bodyLines: number[] = [];
			let j = i + 2;
			while (j <= endLine && lines[j].trim().length > 0 && lines[j].includes("|") && !isMarkdownTableSeparator(lines[j])) {
				bodyLines.push(j);
				j++;
			}
			tables.push({ headerLine, sepLine, bodyLines });
			i = j;
			continue;
		}
		i++;
	}

	return tables;
}

interface MarkdownBlockSpan {
	startLine: number;
	endLine: number;
	kind: "heading" | "list_item" | "blockquote" | "callout" | "paragraph" | "table" | "code";
}

function collectBlocksInRange(lines: string[], startLine: number, endLine: number): MarkdownBlockSpan[] {
	const blocks: MarkdownBlockSpan[] = [];
	let i = startLine;

	while (i <= endLine) {
		const line = lines[i];
		if (!line.trim() || /^[-*_]{3,}\s*$/.test(line.trim())) {
			i++;
			continue;
		}

		const fm = line.match(FENCE_RE);
		if (fm) {
			const ch = fm[1][0];
			const len = fm[1].length;
			const start = i;
			i++;
			while (i <= endLine) {
				const close = lines[i].match(FENCE_RE);
				if (close && close[1][0] === ch && close[1].length >= len && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(lines[i])) {
					i++;
					break;
				}
				i++;
			}
			blocks.push({ startLine: start, endLine: i - 1, kind: "code" });
			continue;
		}

		if (/^#{1,6}\s+/.test(line)) {
			blocks.push({ startLine: i, endLine: i, kind: "heading" });
			i++;
			continue;
		}

		if (i + 1 <= endLine && line.includes("|") && isMarkdownTableSeparator(lines[i + 1])) {
			const start = i;
			i += 2;
			while (i <= endLine && lines[i].trim().length > 0 && lines[i].includes("|")) {
				i++;
			}
			blocks.push({ startLine: start, endLine: i - 1, kind: "table" });
			continue;
		}

		if (/^\s*>/.test(line)) {
			const isCallout = CALLOUT_HEADER_RE.test(line);
			const start = i;
			i++;
			while (i <= endLine && /^\s*>/.test(lines[i])) {
				i++;
			}
			blocks.push({ startLine: start, endLine: i - 1, kind: isCallout ? "callout" : "blockquote" });
			continue;
		}

		if (/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(line)) {
			const start = i;
			const baseIndent = (line.match(/^(\s*)/)?.[1] || "").length;
			i++;
			// Continuation lines indented further without starting a new list item
			while (
				i <= endLine &&
				lines[i].trim().length > 0 &&
				!/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(lines[i]) &&
				!/^#{1,6}\s+/.test(lines[i]) &&
				!FENCE_RE.test(lines[i]) &&
				(lines[i].match(/^(\s*)/)?.[1] || "").length > baseIndent
			) {
				i++;
			}
			blocks.push({ startLine: start, endLine: i - 1, kind: "list_item" });
			continue;
		}

		// Plain paragraph
		const start = i;
		i++;
		while (
			i <= endLine &&
			lines[i].trim().length > 0 &&
			!/^#{1,6}\s+/.test(lines[i]) &&
			!/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(lines[i]) &&
			!/^\s*>/.test(lines[i]) &&
			!FENCE_RE.test(lines[i]) &&
			!(i + 1 <= endLine && lines[i].includes("|") && isMarkdownTableSeparator(lines[i + 1]))
		) {
			i++;
		}
		blocks.push({ startLine: start, endLine: i - 1, kind: "paragraph" });
	}

	return blocks;
}

/**
 * Builds a mapping from stripped plain characters inside a single Markdown line back to raw offsets,
 * plus protected atomic token ranges (wikilinks, markdown links, inline code, inline math) that
 * must never be split in the middle by `==`.
 */
interface ProtectedSpan {
	start: number;
	end: number;
}

function findProtectedSpansInLine(raw: string): ProtectedSpan[] {
	const spans: ProtectedSpan[] = [];
	const patterns = [
		/!?\[\[[^\]]+\]\]/g,
		/!?\[[^\]\n]+\]\([^)\n]+\)/g,
		/`[^`\n]+`/g,
		/\$\$[^$\n]+\$\$/g,
		/(?<!\$)\$(?!\$)[^$\n]+(?<!\$)\$(?!\$)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(raw)) !== null) {
			spans.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	return spans;
}

function expandSpanPastProtectedTokens(
	raw: string,
	start: number,
	end: number
): { start: number; end: number } {
	let s = start;
	let e = end;
	const spans = findProtectedSpansInLine(raw);
	let changed = true;
	while (changed) {
		changed = false;
		for (const sp of spans) {
			if (s > sp.start && s < sp.end) {
				s = sp.start;
				changed = true;
			}
			if (e > sp.start && e < sp.end) {
				e = sp.end;
				changed = true;
			}
		}
	}
	// Avoid splitting right inside `**`, `__`, `~~`, `==` delimiters
	while (s > 0 && (raw[s - 1] === "*" || raw[s - 1] === "_" || raw[s - 1] === "~") && raw[s] === raw[s - 1]) {
		s--;
	}
	while (e < raw.length && (raw[e] === "*" || raw[e] === "_" || raw[e] === "~") && raw[e - 1] === raw[e]) {
		e++;
	}
	return { start: s, end: e };
}

/**
 * Attempts to locate and toggle `==...==` around an inline substring selection within a single line.
 * Returns null if the selection cannot be mapped safely to a sub-span (caller can fall back to line-level).
 */
function tryToggleInlineSelectionInLine(
	rawLine: string,
	selectionPlain: string,
	prefixPlain: string = "",
	suffixPlain: string = ""
): { updatedLine: string; action: "added" | "removed" } | null {
	const split = splitLinePrefixAndContent(rawLine);
	if (split.skip) return null;

	const contentStartOffset = split.prefix.length;
	const content = split.content;

	// Build plain-text projection with raw offset map for `content`
	const plainChars: string[] = [];
	const plainToRawStart: number[] = [];
	const plainToRawEnd: number[] = [];

	let idx = 0;
	while (idx < content.length) {
		// Wikilink `[[target|alias]]` or `[[target]]`
		if (content[idx] === "[" && content[idx + 1] === "[") {
			const close = content.indexOf("]]", idx + 2);
			if (close !== -1) {
				const inner = content.slice(idx + 2, close);
				const pipe = inner.lastIndexOf("|");
				const visible = pipe !== -1 ? inner.slice(pipe + 1) : inner;
				const visStart = pipe !== -1 ? idx + 2 + pipe + 1 : idx + 2;
				for (let k = 0; k < visible.length; k++) {
					plainChars.push(visible[k]);
					plainToRawStart.push(visStart + k);
					plainToRawEnd.push(visStart + k + 1);
				}
				idx = close + 2;
				continue;
			}
		}

		// Markdown link `[label](url)`
		if (content[idx] === "[") {
			const mLink = content.slice(idx).match(/^\[([^\]\n]+)\]\([^)\n]+\)/);
			if (mLink) {
				const label = mLink[1];
				for (let k = 0; k < label.length; k++) {
					plainChars.push(label[k]);
					plainToRawStart.push(idx + 1 + k);
					plainToRawEnd.push(idx + 1 + k + 1);
				}
				idx += mLink[0].length;
				continue;
			}
		}

		// Skip formatting delimiter pairs (`==`, `**`, `__`, `~~`, `$$`, `*`, `_`, `` ` ``, `$`)
		const two = content.slice(idx, idx + 2);
		if (two === "==" || two === "**" || two === "__" || two === "~~" || two === "$$") {
			idx += 2;
			continue;
		}
		const ch = content[idx];
		if (ch === "*" || ch === "_" || ch === "`" || ch === "$") {
			idx++;
			continue;
		}

		plainChars.push(ch);
		plainToRawStart.push(idx);
		plainToRawEnd.push(idx + 1);
		idx++;
	}

	// Collapse whitespace in projected plain text while tracking raw offset maps
	const normChars: string[] = [];
	const normToRawStart: number[] = [];
	const normToRawEnd: number[] = [];
	let prevSpace = true;

	for (let k = 0; k < plainChars.length; k++) {
		const ch = plainChars[k];
		if (/\s/.test(ch)) {
			if (!prevSpace) {
				normChars.push(" ");
				normToRawStart.push(plainToRawStart[k]);
				normToRawEnd.push(plainToRawEnd[k]);
				prevSpace = true;
			}
		} else {
			normChars.push(ch);
			normToRawStart.push(plainToRawStart[k]);
			normToRawEnd.push(plainToRawEnd[k]);
			prevSpace = false;
		}
	}
	if (normChars.length > 0 && normChars[normChars.length - 1] === " ") {
		normChars.pop();
		normToRawStart.pop();
		normToRawEnd.pop();
	}

	const haystack = normChars.join("");
	const needle = selectionPlain.replace(/\s+/g, " ").trim();
	if (needle.length < 2) return null;

	const hits: number[] = [];
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const pos = haystack.indexOf(needle, from);
		if (pos === -1) break;
		hits.push(pos);
		from = pos + 1;
		if (hits.length > 20) break;
	}
	if (hits.length === 0) return null;

	let bestPos = hits[0];
	if (hits.length > 1) {
		const pref = prefixPlain.replace(/\s+/g, " ").trim();
		const suff = suffixPlain.replace(/\s+/g, " ").trim();
		let bestScore = -1;
		for (const pos of hits) {
			let score = 0;
			if (pref) {
				const before = haystack.slice(Math.max(0, pos - pref.length - 4), pos);
				for (let k = 1; k <= Math.min(pref.length, before.length); k++) {
					if (before.endsWith(pref.slice(-k))) score = Math.max(score, k);
				}
			}
			if (suff) {
				const after = haystack.slice(pos + needle.length, pos + needle.length + suff.length + 4);
				for (let k = 1; k <= Math.min(suff.length, after.length); k++) {
					if (after.startsWith(suff.slice(0, k))) score += k;
				}
			}
			if (score > bestScore) {
				bestScore = score;
				bestPos = pos;
			}
		}
	}

	const rawSpanStart = normToRawStart[bestPos];
	const rawSpanEnd = normToRawEnd[bestPos + needle.length - 1];
	if (rawSpanStart === undefined || rawSpanEnd === undefined) return null;

	const expanded = expandSpanPastProtectedTokens(content, rawSpanStart, rawSpanEnd);

	// Check if selection sits directly inside an existing `==...==` pair -> toggle OFF cleanly
	const before2 = content.slice(Math.max(0, expanded.start - 2), expanded.start);
	const after2 = content.slice(expanded.end, expanded.end + 2);
	if (before2 === "==" && after2 === "==") {
		const inner = content.slice(expanded.start, expanded.end);
		const nextContent = content.slice(0, expanded.start - 2) + inner + content.slice(expanded.end + 2);
		return {
			updatedLine: rawLine.slice(0, contentStartOffset) + nextContent,
			action: "removed",
		};
	}

	const selectedSlice = content.slice(expanded.start, expanded.end);
	// If inside a Markdown table row, refuse to cross unescaped cell pipe boundaries!
	if (isMarkdownTableRow(rawLine) && /(?<!\\)\|/.test(selectedSlice.replace(/\[\[[^\]]+\]\]/g, ""))) {
		return null;
	}

	if (isSegmentFullyHighlighted(selectedSlice)) {
		const res = applyInlineMark(selectedSlice, "remove");
		const nextContent = content.slice(0, expanded.start) + res.text + content.slice(expanded.end);
		return {
			updatedLine: rawLine.slice(0, contentStartOffset) + nextContent,
			action: "removed",
		};
	}

	// Check if the selection lies strictly inside a wider `== ... ==` on the same line -> unwrap that enclosing `==...==`
	const prevOpen = content.lastIndexOf("==", expanded.start);
	const nextClose = content.indexOf("==", expanded.end);
	if (prevOpen !== -1 && nextClose !== -1) {
		const countBefore = (content.slice(0, expanded.start).match(/==/g) || []).length;
		if (countBefore % 2 === 1) {
			const nextContent =
				content.slice(0, prevOpen) +
				content.slice(prevOpen + 2, nextClose) +
				content.slice(nextClose + 2);
			return {
				updatedLine: rawLine.slice(0, contentStartOffset) + nextContent,
				action: "removed",
			};
		}
	}

	const res = applyInlineMark(selectedSlice, "add");
	const nextContent = content.slice(0, expanded.start) + res.text + content.slice(expanded.end);
	return {
		updatedLine: rawLine.slice(0, contentStartOffset) + nextContent,
		action: "added",
	};
}

/**
 * Main entry point: toggles persistent Obsidian `==...==` highlight on the given target
 * strictly within `[sectionLineStart, sectionLineEnd]` of `fullMarkdown`.
 */
export function toggleMarkdownHighlightInSection(
	fullMarkdown: string,
	sectionLineStart: number,
	sectionLineEnd: number,
	target: BlockHighlightTarget
): HighlightToggleResult {
	const hasCrlf = fullMarkdown.includes("\r\n");
	const eol = hasCrlf ? "\r\n" : "\n";
	const lines = fullMarkdown.replace(/\r\n/g, "\n").split("\n");

	const start = Math.max(0, Math.min(sectionLineStart, lines.length - 1));
	const end = Math.max(start, Math.min(sectionLineEnd, lines.length - 1));

	// 1. Table row highlight (Table Zoom row selector + H)
	if (target.kind === "table_row") {
		const tables = findTablesInRange(lines, start, end);
		if (tables.length === 0) {
			return { changed: false, action: "not_found", reason: "No Markdown table found in section.", updatedMarkdown: fullMarkdown };
		}

		let matchedLineIdx = -1;
		const tIdx = typeof target.tableIndex === "number" && target.tableIndex >= 0 ? target.tableIndex : 0;
		const preferredTable = tables[Math.min(tIdx, tables.length - 1)];

		if (
			preferredTable &&
			typeof target.rowIndex === "number" &&
			target.rowIndex >= 0 &&
			target.rowIndex < preferredTable.bodyLines.length
		) {
			matchedLineIdx = preferredTable.bodyLines[target.rowIndex];
		}

		// Verify or fall back via token overlap if tableIndex/rowIndex didn't match (e.g. diff rows shifted indices)
		const queryTokens = extractMatchTokens(target.plainText);
		if (queryTokens.length > 0) {
			const directScore =
				matchedLineIdx >= 0
					? tokenOverlapScore(queryTokens, extractMatchTokens(stripMarkdownToSearchText(lines[matchedLineIdx])))
					: 0;
			if (directScore < 0.45) {
				let bestLine = matchedLineIdx;
				let bestScore = directScore;
				for (const tbl of tables) {
					for (const lineIdx of tbl.bodyLines) {
						const sc = tokenOverlapScore(
							queryTokens,
							extractMatchTokens(stripMarkdownToSearchText(lines[lineIdx]))
						);
						if (sc > bestScore) {
							bestScore = sc;
							bestLine = lineIdx;
						}
					}
				}
				if (bestScore >= 0.35) {
					matchedLineIdx = bestLine;
				}
			}
		}

		if (matchedLineIdx < 0) {
			return { changed: false, action: "not_found", reason: "Could not locate table row in Markdown.", updatedMarkdown: fullMarkdown };
		}

		const toggled = toggleLinesRange(lines, matchedLineIdx, matchedLineIdx);
		return {
			changed: toggled.changed,
			action: toggled.action,
			updatedMarkdown: toggled.updatedLines.join(eol),
			affectedLineStart: matchedLineIdx,
			affectedLineEnd: matchedLineIdx,
		};
	}

	// 2. Full table highlight (whole table focused or zoomed with no single row selected -> highlights all body rows cell-by-cell)
	if (target.kind === "table") {
		const tables = findTablesInRange(lines, start, end);
		if (tables.length === 0) {
			return { changed: false, action: "not_found", reason: "No Markdown table found in section.", updatedMarkdown: fullMarkdown };
		}
		let chosen = tables[0];
		if (tables.length > 1) {
			if (typeof target.tableIndex === "number" && target.tableIndex >= 0 && target.tableIndex < tables.length) {
				chosen = tables[target.tableIndex];
			} else {
				const qTokens = extractMatchTokens(target.plainText);
				let bestScore = -1;
				for (const tbl of tables) {
					const tblText = tbl.bodyLines.map((idx) => stripMarkdownToSearchText(lines[idx])).join(" ");
					const sc = tokenOverlapScore(qTokens, extractMatchTokens(tblText));
					if (sc > bestScore) {
						bestScore = sc;
						chosen = tbl;
					}
				}
			}
		}
		if (chosen.bodyLines.length === 0) {
			return { changed: false, action: "unsupported", reason: "Table has no body rows to highlight.", updatedMarkdown: fullMarkdown };
		}
		const firstBody = chosen.bodyLines[0];
		const lastBody = chosen.bodyLines[chosen.bodyLines.length - 1];
		const toggled = toggleLinesRange(lines, firstBody, lastBody);
		return {
			changed: toggled.changed,
			action: toggled.action,
			updatedMarkdown: toggled.updatedLines.join(eol),
			affectedLineStart: firstBody,
			affectedLineEnd: lastBody,
		};
	}

	// Reject explicit code/media block tags cleanly
	const lowerTag = (target.tagName || "").toLowerCase();
	if (lowerTag === "pre" || lowerTag === "img" || lowerTag === "iframe" || lowerTag === "svg") {
		return {
			changed: false,
			action: "unsupported",
			reason: "Markdown ==highlight== is not supported on code blocks or media.",
			updatedMarkdown: fullMarkdown,
		};
	}

	const blocks = collectBlocksInRange(lines, start, end);
	const nonCodeBlocks = blocks.filter((b) => b.kind !== "code");
	if (nonCodeBlocks.length === 0) {
		return {
			changed: false,
			action: "unsupported",
			reason: "No highlightable text block found in this section.",
			updatedMarkdown: fullMarkdown,
		};
	}

	const queryTokens = extractMatchTokens(target.plainText);
	if (queryTokens.length === 0) {
		return { changed: false, action: "not_found", reason: "Empty highlight target.", updatedMarkdown: fullMarkdown };
	}

	// 3. Inline or multi-line user text selection
	if (target.kind === "selection") {
		const rawSelLines = target.plainText
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		// 3a. Single-line selection -> try exact inline highlight inside the best-matching single line first!
		if (rawSelLines.length <= 1) {
			let bestLineIdx = -1;
			let bestLineScore = -1;
			const needleNorm = target.plainText.replace(/\s+/g, " ").trim().toLowerCase();

			for (const blk of nonCodeBlocks) {
				if (blk.kind === "table") {
					// Search individual table body lines
					for (let li = blk.startLine + 2; li <= blk.endLine; li++) {
						const stripped = stripMarkdownToSearchText(lines[li]).replace(/\s+/g, " ").trim();
						if (stripped.toLowerCase().includes(needleNorm)) {
							const inlineTry = tryToggleInlineSelectionInLine(
								lines[li],
								target.plainText,
								target.prefixText,
								target.suffixText
							);
							if (inlineTry) {
								const nextLines = [...lines];
								nextLines[li] = inlineTry.updatedLine;
								return {
									changed: inlineTry.updatedLine !== lines[li],
									action: inlineTry.action,
									updatedMarkdown: nextLines.join(eol),
									affectedLineStart: li,
									affectedLineEnd: li,
								};
							}
						}
					}
					continue;
				}
				for (let li = blk.startLine; li <= blk.endLine; li++) {
					const stripped = stripMarkdownToSearchText(lines[li]).replace(/\s+/g, " ").trim();
					if (!stripped) continue;
					if (stripped.toLowerCase().includes(needleNorm)) {
						// Direct exact substring match: verify inline toggle works cleanly
						const inlineTry = tryToggleInlineSelectionInLine(
							lines[li],
							target.plainText,
							target.prefixText,
							target.suffixText
						);
						if (inlineTry) {
							const nextLines = [...lines];
							nextLines[li] = inlineTry.updatedLine;
							return {
								changed: inlineTry.updatedLine !== lines[li],
								action: inlineTry.action,
								updatedMarkdown: nextLines.join(eol),
								affectedLineStart: li,
								affectedLineEnd: li,
							};
						}
					}
					const sc = tokenOverlapScore(queryTokens, extractMatchTokens(stripped));
					if (sc > bestLineScore) {
						bestLineScore = sc;
						bestLineIdx = li;
					}
				}
			}

			// Fallback when KaTeX/inline formatting prevented literal substring match on a single-line selection
			if (bestLineIdx >= 0 && bestLineScore >= 0.45) {
				const inlineTry = tryToggleInlineSelectionInLine(
					lines[bestLineIdx],
					target.plainText,
					target.prefixText,
					target.suffixText
				);
				if (inlineTry) {
					const nextLines = [...lines];
					nextLines[bestLineIdx] = inlineTry.updatedLine;
					return {
						changed: inlineTry.updatedLine !== lines[bestLineIdx],
						action: inlineTry.action,
						updatedMarkdown: nextLines.join(eol),
						affectedLineStart: bestLineIdx,
						affectedLineEnd: bestLineIdx,
					};
				}
				if (bestLineScore >= 0.55) {
					const toggled = toggleLinesRange(lines, bestLineIdx, bestLineIdx);
					return {
						changed: toggled.changed,
						action: toggled.action,
						updatedMarkdown: toggled.updatedLines.join(eol),
						affectedLineStart: bestLineIdx,
						affectedLineEnd: bestLineIdx,
					};
				}
			}
		}

		// 3b. Multi-line selection (e.g., bullet + numbered sub-items + trailing note):
		// Find the minimal contiguous range of non-code blocks covering the selection!
		const firstLineTokens = extractMatchTokens(rawSelLines[0] || target.plainText);
		const lastLineTokens = extractMatchTokens(rawSelLines[rawSelLines.length - 1] || target.plainText);

		let bestStartBlock = -1;
		let bestEndBlock = -1;
		let bestSpanScore = 0;

		for (let a = 0; a < nonCodeBlocks.length; a++) {
			const aText = lines
				.slice(nonCodeBlocks[a].startLine, nonCodeBlocks[a].endLine + 1)
				.map(stripMarkdownToSearchText)
				.join(" ");
			const startOverlap = tokenOverlapScore(firstLineTokens, extractMatchTokens(aText));
			if (startOverlap < 0.25 && rawSelLines.length > 1) continue;

			const maxEnd = Math.min(nonCodeBlocks.length - 1, a + Math.max(12, rawSelLines.length + 4));
			for (let b = a; b <= maxEnd; b++) {
				const spanText = lines
					.slice(nonCodeBlocks[a].startLine, nonCodeBlocks[b].endLine + 1)
					.map(stripMarkdownToSearchText)
					.join(" ");
				let sc = tokenOverlapScore(queryTokens, extractMatchTokens(spanText));
				if (rawSelLines.length > 1) {
					const bText = lines
						.slice(nonCodeBlocks[b].startLine, nonCodeBlocks[b].endLine + 1)
						.map(stripMarkdownToSearchText)
						.join(" ");
					const endOverlap = tokenOverlapScore(lastLineTokens, extractMatchTokens(bText));
					sc = sc * 0.7 + startOverlap * 0.15 + endOverlap * 0.15;
				}
				if (sc > bestSpanScore) {
					bestSpanScore = sc;
					bestStartBlock = a;
					bestEndBlock = b;
				}
			}
		}

		if (bestStartBlock >= 0 && bestEndBlock >= bestStartBlock && bestSpanScore >= 0.45) {
			const sLine = nonCodeBlocks[bestStartBlock].startLine;
			const eLine = nonCodeBlocks[bestEndBlock].endLine;
			const toggled = toggleLinesRange(lines, sLine, eLine);
			return {
				changed: toggled.changed,
				action: toggled.action,
				updatedMarkdown: toggled.updatedLines.join(eol),
				affectedLineStart: sLine,
				affectedLineEnd: eLine,
			};
		}

		return {
			changed: false,
			action: "not_found",
			reason: "Could not reliably locate the selected text in Markdown.",
			updatedMarkdown: fullMarkdown,
		};
	}

	// 4. Focused semantic block (paragraph, list item, heading, blockquote, callout)
	let bestBlock: MarkdownBlockSpan | null = null;
	let bestScore = 0;

	const expectedKind =
		lowerTag === "li"
			? "list_item"
			: /^h[1-6]$/.test(lowerTag)
				? "heading"
				: lowerTag === "blockquote"
					? "blockquote"
					: lowerTag === "p"
						? "paragraph"
						: null;

	for (const blk of nonCodeBlocks) {
		if (blk.kind === "table") continue;
		const blkText = lines
			.slice(blk.startLine, blk.endLine + 1)
			.map(stripMarkdownToSearchText)
			.join(" ");
		let sc = tokenOverlapScore(queryTokens, extractMatchTokens(blkText));
		if (expectedKind && blk.kind === expectedKind) {
			sc += 0.04;
		}
		if (sc > bestScore) {
			bestScore = sc;
			bestBlock = blk;
		}
	}

	// Also allow matching a parent `<li>` whose rendered block included nested `<ul>`/`<ol>` items
	let bestStartLine = bestBlock ? bestBlock.startLine : -1;
	let bestEndLine = bestBlock ? bestBlock.endLine : -1;

	if (lowerTag === "li" && bestBlock) {
		const idx = nonCodeBlocks.indexOf(bestBlock);
		if (idx >= 0) {
			const baseIndent = (lines[bestBlock.startLine].match(/^(\s*)/)?.[1] || "").length;
			let expandedEnd = bestBlock.endLine;
			for (let k = idx + 1; k < nonCodeBlocks.length; k++) {
				const nextBlk = nonCodeBlocks[k];
				if (nextBlk.kind !== "list_item") break;
				const ind = (lines[nextBlk.startLine].match(/^(\s*)/)?.[1] || "").length;
				if (ind <= baseIndent) break;
				const candidateText = lines
					.slice(bestBlock.startLine, nextBlk.endLine + 1)
					.map(stripMarkdownToSearchText)
					.join(" ");
				const candScore = tokenOverlapScore(queryTokens, extractMatchTokens(candidateText)) + 0.04;
				if (candScore > bestScore + 0.02) {
					bestScore = candScore;
					expandedEnd = nextBlk.endLine;
				}
			}
			bestEndLine = expandedEnd;
		}
	}

	if (bestStartLine < 0 || bestScore < 0.4) {
		return {
			changed: false,
			action: "not_found",
			reason: "Could not reliably locate the focused block in Markdown.",
			updatedMarkdown: fullMarkdown,
		};
	}

	const toggled = toggleLinesRange(lines, bestStartLine, bestEndLine);
	return {
		changed: toggled.changed,
		action: toggled.action,
		updatedMarkdown: toggled.updatedLines.join(eol),
		affectedLineStart: bestStartLine,
		affectedLineEnd: bestEndLine,
	};
}
