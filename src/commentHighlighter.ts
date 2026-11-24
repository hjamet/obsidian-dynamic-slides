/**
 * commentHighlighter.ts — Persistent visual highlights for selection-scoped SlideFlow comments,
 * with click-to-edit support across slides, diff spans, inline formatting, tables, and code blocks.
 *
 * Uses safe text-node slice wrapping (`<mark class="slideflow-comment-mark">`) rather than
 * `range.surroundContents()`, so highlights never crash or corrupt DOM when crossing `<strong>`,
 * `<code>`, `<a>`, `<ins>`, `<del>`, or multi-cell `<td>` boundaries.
 */

import { ReviewComment } from "./reviewStore";

interface TextSegment {
	node: Text;
	start: number;
	end: number;
}

export interface SelectionAnchorSnippet {
	selectionQuote: string;
	selectionPrefix: string;
	selectionSuffix: string;
}

const IGNORED_ANCESTOR_SELECTOR =
	".dynamic-slides-child-heading, .copy-code-button, .slideflow-selection-toolbar, .slideflow-deleted-sections-title, .slideflow-link-dirty-badge, .callout-icon, .callout-fold, script, style, button";

// Structural HTML containers where inserting an inline <mark> child creates broken anonymous layout boxes (e.g. extra table cells inside <tr>!)
const STRUCTURAL_CONTAINER_TAGS = new Set([
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"colgroup",
	"ul",
	"ol",
	"dl",
	"select",
]);

const BLOCK_BOUNDARY_SELECTOR = "td, th, p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr";

const LINK_ANCHOR_SELECTOR =
	"a[href], a.internal-link, .internal-link, .slideflow-child-heading-linked-title";

function findEnclosingLink(node: Text): HTMLElement | null {
	return (node.parentElement?.closest(LINK_ANCHOR_SELECTOR) as HTMLElement | null) || null;
}

/**
 * Unwraps any previously injected `.slideflow-comment-mark` elements inside `containerEl`
 * and normalizes adjacent text nodes so re-applying highlights is 100% idempotent.
 */
export function clearCommentHighlights(containerEl: HTMLElement): void {
	const marks = Array.from(containerEl.querySelectorAll("mark.slideflow-comment-mark"));
	for (const mark of marks) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) {
			const child = mark.firstChild;
			if (
				child instanceof HTMLElement &&
				child.getAttribute("data-sf-suppress-title") === "1"
			) {
				child.removeAttribute("title");
				child.removeAttribute("data-sf-suppress-title");
			}
			parent.insertBefore(child, mark);
		}
		parent.removeChild(mark);
	}
	containerEl.normalize();
}

function collectTextSegments(containerEl: HTMLElement): { fullText: string; segments: TextSegment[] } {
	const segments: TextSegment[] = [];
	const parts: string[] = [];
	let offset = 0;
	let prevBlockBoundary: Element | null = null;

	const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, {
		acceptNode(node: Node): number {
			if (!node.nodeValue || node.nodeValue.length === 0) {
				return NodeFilter.FILTER_REJECT;
			}
			const parentEl = node.parentElement;
			if (!parentEl) return NodeFilter.FILTER_REJECT;
			if (STRUCTURAL_CONTAINER_TAGS.has(parentEl.tagName.toLowerCase())) {
				return NodeFilter.FILTER_REJECT;
			}
			if (parentEl.closest(IGNORED_ANCESTOR_SELECTOR)) {
				return NodeFilter.FILTER_REJECT;
			}
			// Skip hidden elements (e.g. collapsed tables/code before zoom)
			const style = window.getComputedStyle(parentEl);
			if (style.display === "none" || style.visibility === "hidden") {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	let current = walker.nextNode();
	while (current) {
		const textNode = current as Text;
		const blockBoundary = textNode.parentElement?.closest(BLOCK_BOUNDARY_SELECTOR) || null;
		// Insert a virtual whitespace separator between distinct table cells / blocks so cross-cell
		// matches align with range.toString() WITHOUT wrapping inter-cell DOM text nodes in <tr>!
		if (prevBlockBoundary && blockBoundary && blockBoundary !== prevBlockBoundary) {
			parts.push(" ");
			offset += 1;
		}
		prevBlockBoundary = blockBoundary;

		const len = textNode.data.length;
		segments.push({ node: textNode, start: offset, end: offset + len });
		parts.push(textNode.data);
		offset += len;
		current = walker.nextNode();
	}

	return { fullText: parts.join(""), segments };
}

function buildNormalizedTextMap(raw: string): { norm: string; map: number[] } {
	let norm = "";
	const map: number[] = [];
	let lastWasSpace = true;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (/\s/.test(ch)) {
			if (!lastWasSpace) {
				norm += " ";
				map.push(i);
				lastWasSpace = true;
			}
		} else {
			norm += ch;
			map.push(i);
			lastWasSpace = false;
		}
	}

	if (norm.endsWith(" ")) {
		norm = norm.slice(0, -1);
		map.pop();
	}

	return { norm, map };
}

function normalizeNeedle(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

function stripInlineMarkdownSyntax(raw: string): string {
	return raw
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Captures the exact DOM quote plus surrounding ~32 chars of prefix/suffix inside `containerEl`
 * so repeated short phrases can still be re-highlighted unambiguously.
 */
export function captureSelectionAnchorSnippet(
	range: Range,
	containerEl: HTMLElement
): SelectionAnchorSnippet {
	const selectionQuote = range.toString().trim();
	let selectionPrefix = "";
	let selectionSuffix = "";

	try {
		const preRange = document.createRange();
		preRange.selectNodeContents(containerEl);
		preRange.setEnd(range.startContainer, range.startOffset);
		const preText = preRange.toString().replace(/\s+/g, " ");
		selectionPrefix = preText.slice(-36).trim();

		const postRange = document.createRange();
		postRange.selectNodeContents(containerEl);
		postRange.setStart(range.endContainer, range.endOffset);
		const postText = postRange.toString().replace(/\s+/g, " ");
		selectionSuffix = postText.slice(0, 36).trim();
	} catch {
		// ignore if range spans unexpected boundary
	}

	return { selectionQuote, selectionPrefix, selectionSuffix };
}

function findBestOccurrence(
	haystackNorm: string,
	needleNorm: string,
	prefixNorm: string,
	suffixNorm: string
): { normStart: number; normEnd: number } | null {
	if (!needleNorm || needleNorm.length < 2) return null;

	const hits: number[] = [];
	let searchFrom = 0;
	while (searchFrom <= haystackNorm.length - needleNorm.length) {
		const idx = haystackNorm.indexOf(needleNorm, searchFrom);
		if (idx === -1) break;
		hits.push(idx);
		searchFrom = idx + Math.max(1, needleNorm.length);
		if (hits.length > 50) break;
	}

	if (hits.length === 0) return null;
	if (hits.length === 1) {
		return { normStart: hits[0], normEnd: hits[0] + needleNorm.length };
	}

	let bestIdx = hits[0];
	let bestScore = -1;

	for (const idx of hits) {
		let score = 0;
		if (prefixNorm) {
			const before = haystackNorm.slice(Math.max(0, idx - prefixNorm.length - 4), idx);
			for (let k = 1; k <= Math.min(prefixNorm.length, before.length); k++) {
				if (before.endsWith(prefixNorm.slice(-k))) {
					score = Math.max(score, k);
				}
			}
		}
		if (suffixNorm) {
			const afterStart = idx + needleNorm.length;
			const after = haystackNorm.slice(afterStart, afterStart + suffixNorm.length + 4);
			for (let k = 1; k <= Math.min(suffixNorm.length, after.length); k++) {
				if (after.startsWith(suffixNorm.slice(0, k))) {
					score += k;
					break;
				}
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestIdx = idx;
		}
	}

	return { normStart: bestIdx, normEnd: bestIdx + needleNorm.length };
}

function wrapTextSlice(
	segments: TextSegment[],
	origStart: number,
	origEnd: number,
	comment: ReviewComment
): boolean {
	const intersecting = segments.filter((s) => s.end > origStart && s.start < origEnd);
	if (intersecting.length === 0) return false;

	const preview =
		comment.commentText.length > 140
			? comment.commentText.slice(0, 140) + "…"
			: comment.commentText;
	const isFailed = Boolean(comment.failedAt || comment.failedReason);
	const tooltip = isFailed
		? `[FAILED: ${comment.failedReason || "retry"}] Click to edit: ${preview}`
		: `Click to edit comment: ${preview}`;
	const linkBorderTooltip = isFailed
		? `[FAILED: ${comment.failedReason || "retry"}] Click yellow border to edit: ${preview}`
		: `Click yellow border to edit comment: ${preview}`;

	// Detect clickable links whose entire visible text is covered by this comment range.
	// Wrapping the `<a>` INSIDE `<mark class="slideflow-comment-mark is-link-highlight">`
	// lets clicks on the link text open the link directly while clicks on the outer yellow
	// contour (padding/border of `<mark>`) open the comment editor.
	const touchedAnchors = new Set<HTMLElement>();
	for (const seg of intersecting) {
		const anchor = findEnclosingLink(seg.node);
		if (anchor) touchedAnchors.add(anchor);
	}

	const fullyCoveredAnchors = new Set<HTMLElement>();
	for (const anchor of touchedAnchors) {
		if (anchor.closest("mark.slideflow-comment-mark")) continue;
		if (anchor.querySelector("mark.slideflow-comment-mark")) continue;
		const anchorParent = anchor.parentElement;
		if (!anchorParent || STRUCTURAL_CONTAINER_TAGS.has(anchorParent.tagName.toLowerCase())) {
			continue;
		}
		const anchorSegments = segments.filter(
			(s) => anchor.contains(s.node) && s.node.data.trim().length > 0
		);
		if (anchorSegments.length === 0) continue;
		const allCovered = anchorSegments.every((aSeg) => {
			const firstNonWs = aSeg.node.data.search(/\S/);
			const lastNonWsEnd = aSeg.node.data.trimEnd().length;
			return aSeg.start + firstNonWs >= origStart && aSeg.start + lastNonWsEnd <= origEnd;
		});
		if (allCovered) {
			fullyCoveredAnchors.add(anchor);
		}
	}

	const wrappedAnchors = new Set<HTMLElement>();

	// Wrap in reverse document order so splitText never invalidates earlier segments
	for (let i = intersecting.length - 1; i >= 0; i--) {
		const seg = intersecting[i];
		const localStart = Math.max(0, origStart - seg.start);
		const localEnd = Math.min(seg.node.data.length, origEnd - seg.start);
		if (localEnd <= localStart) continue;
		if (!seg.node.data.slice(localStart, localEnd).trim()) continue;

		// Avoid double-wrapping already marked text from an overlapping comment
		if (seg.node.parentElement?.closest("mark.slideflow-comment-mark")) {
			continue;
		}

		const enclosingLink = findEnclosingLink(seg.node);
		if (enclosingLink && fullyCoveredAnchors.has(enclosingLink)) {
			if (wrappedAnchors.has(enclosingLink)) {
				continue;
			}
			wrappedAnchors.add(enclosingLink);

			const mark = document.createElement("mark");
			mark.className = isFailed
				? "slideflow-comment-mark is-link-highlight is-failed"
				: "slideflow-comment-mark is-link-highlight";
			mark.setAttribute("data-comment-id", comment.id);
			mark.setAttribute("title", linkBorderTooltip);

			// Suppress ancestor `<mark>` comment tooltip when hovering directly over the link text
			if (!enclosingLink.hasAttribute("title")) {
				enclosingLink.setAttribute("title", "");
				enclosingLink.setAttribute("data-sf-suppress-title", "1");
			}

			const parent = enclosingLink.parentNode;
			if (parent) {
				parent.insertBefore(mark, enclosingLink);
				mark.appendChild(enclosingLink);
			}
			continue;
		}

		let targetNode = seg.node;
		if (localEnd < targetNode.data.length) {
			targetNode.splitText(localEnd);
		}
		if (localStart > 0) {
			targetNode = targetNode.splitText(localStart);
		}

		const mark = document.createElement("mark");
		if (enclosingLink) {
			mark.className = isFailed
				? "slideflow-comment-mark is-partial-in-link is-failed"
				: "slideflow-comment-mark is-partial-in-link";
			mark.setAttribute("title", linkBorderTooltip);
		} else {
			mark.className = isFailed ? "slideflow-comment-mark is-failed" : "slideflow-comment-mark";
			mark.setAttribute("title", tooltip);
		}
		mark.setAttribute("data-comment-id", comment.id);

		const parent = targetNode.parentNode;
		if (parent) {
			parent.insertBefore(mark, targetNode);
			mark.appendChild(targetNode);
		}
	}

	return true;
}

/**
 * Re-applies persistent clickable amber highlights for every selection-scoped comment
 * whose text appears inside `containerEl`.
 */
export function applyPersistentCommentHighlights(
	containerEl: HTMLElement,
	comments: ReviewComment[]
): void {
	clearCommentHighlights(containerEl);

	const selectionComments = comments.filter(
		(c) => c.scopeType === "selection" && (c.selectionQuote || c.excerpt)
	);
	if (selectionComments.length === 0) return;

	for (const comment of selectionComments) {
		const { fullText, segments } = collectTextSegments(containerEl);
		if (!fullText || segments.length === 0) return;

		const { norm: haystackNorm, map } = buildNormalizedTextMap(fullText);
		const prefixNorm = normalizeNeedle(comment.selectionPrefix || "");
		const suffixNorm = normalizeNeedle(comment.selectionSuffix || "");

		const candidateNeedles = [
			comment.selectionQuote ? normalizeNeedle(comment.selectionQuote) : "",
			normalizeNeedle(comment.excerpt || ""),
			normalizeNeedle(stripInlineMarkdownSyntax(comment.excerpt || "")),
		].filter((n, idx, arr) => n.length >= 2 && arr.indexOf(n) === idx);

		let match: { normStart: number; normEnd: number } | null = null;
		for (const needle of candidateNeedles) {
			match = findBestOccurrence(haystackNorm, needle, prefixNorm, suffixNorm);
			if (match) break;
		}

		if (!match) continue;
		const origStart = map[match.normStart];
		const origLastChar = map[match.normEnd - 1];
		if (origStart === undefined || origLastChar === undefined) continue;
		const origEnd = origLastChar + 1;

		wrapTextSlice(segments, origStart, origEnd, comment);
	}
}
