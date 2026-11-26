import { renderChildHeadingInnerHtml, stripHeadingLinksToPlainText } from "./headingUtils";

export interface SectionNode {
	id: string;
	title: string;
	displayTitle: string;
	level: number;
	lineStart: number;
	lineEnd: number;
	parent: SectionNode | null;
	children: SectionNode[];
	contentMarkdown: string;
	rawOwnMarkdown: string;
	childHeadingsHtml: string;
	isEmptyHeadingLeaf?: boolean;
	isPureLinkLeaf?: boolean;
	isVirtualDeleted?: boolean;
	flatIndex?: number;
}

/**
 * Returns true when a leaf section contains ONLY its heading (no body content, no child headings)
 * and already appears inside its parent slide's child-headings list (`parent.level > 0`).
 * Such empty heading-only slides must never be displayed as standalone empty slides.
 */
export function isHeadingOnlySkippedSlide(node: SectionNode | null | undefined): boolean {
	if (!node) return false;
	return Boolean(
		node.isEmptyHeadingLeaf &&
			!node.isVirtualDeleted &&
			node.children.length === 0 &&
			node.parent &&
			node.parent.level > 0
	);
}

export function buildChildHeadingsHtml(
	children: SectionNode[],
	includeVirtualDeleted: boolean = false
): string {
	const visibleChildren = includeVirtualDeleted
		? children
		: children.filter((c) => !c.isVirtualDeleted);

	return visibleChildren
		.map((c) => {
			if (c.isVirtualDeleted) {
				const inner = renderChildHeadingInnerHtml(c.title, false);
				return `<div class="dynamic-slides-child-heading level-${c.level} is-deleted-child-heading" data-node-id="${c.id}" data-flat-index="${c.flatIndex ?? 0}" title="Deleted subsection — click or press → to inspect and validate"><del class="dv-del">${inner}</del></div>`;
			}
			const inner = renderChildHeadingInnerHtml(c.title, Boolean(c.isPureLinkLeaf));
			const emptyLeafCls =
				c.isEmptyHeadingLeaf && !c.isPureLinkLeaf ? " is-empty-heading-leaf" : "";
			return `<div class="dynamic-slides-child-heading level-${c.level}${emptyLeafCls}" data-node-id="${c.id}" data-flat-index="${c.flatIndex ?? 0}">${inner}</div>`;
		})
		.join("\n");
}

export function buildInlineDeletedHeadingHtml(item: { id?: string; title: string; level: number }): string {
	const inner = renderChildHeadingInnerHtml(item.title, false);
	const idAttr = item.id ? ` data-deleted-id="${item.id}"` : "";
	return `<div class="dynamic-slides-child-heading level-${item.level} is-deleted-child-heading is-inline-deleted-heading"${idAttr} title="Deleted title-only subsection — press Ctrl+Enter to validate"><del class="dv-del">${inner}</del></div>`;
}

export function stripFrontmatterWithOffset(markdown: string): { text: string; strippedLines: number } {
	const normalized = markdown.replace(/\r\n/g, "\n");
	const m = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
	if (!m) return { text: normalized, strippedLines: 0 };
	const strippedLines = m[0].split("\n").length - 1;
	return { text: normalized.slice(m[0].length), strippedLines };
}

export interface ParsedHeadingEntry {
	heading: string;
	level: number;
	position: {
		start: { line: number };
	};
}

/**
 * Synchronously extracts ATX headings directly from raw Markdown text, skipping YAML frontmatter
 * and fenced code blocks (``` or ~~~). Guarantees line offsets always match the exact file bytes
 * even when Obsidian's metadataCache lags behind external disk writes or Reading Mode buffers.
 */
export function extractHeadingsFromMarkdown(markdown: string): ParsedHeadingEntry[] {
	const normalized = markdown.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const headings: ParsedHeadingEntry[] = [];

	let i = 0;
	// Skip leading YAML frontmatter block
	if (lines.length > 0 && /^---\s*$/.test(lines[0])) {
		let endFm = -1;
		for (let j = 1; j < lines.length; j++) {
			if (/^(?:---|\.\.\.)\s*$/.test(lines[j])) {
				endFm = j;
				break;
			}
		}
		if (endFm !== -1) {
			i = endFm + 1;
		}
	}

	let openFenceChar: string | null = null;
	let openFenceLen = 0;

	for (; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const ch = marker[0];
			if (!openFenceChar) {
				openFenceChar = ch;
				openFenceLen = marker.length;
				continue;
			} else if (ch === openFenceChar && marker.length >= openFenceLen && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
				openFenceChar = null;
				openFenceLen = 0;
				continue;
			}
		}
		if (openFenceChar) continue;

		const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (hMatch) {
			const level = hMatch[1].length;
			// Strip optional CommonMark closing hashes (e.g. `## Title ##`)
			const headingText = hMatch[2].replace(/\s+#+\s*$/, "").trim();
			if (headingText.length > 0) {
				headings.push({
					heading: headingText,
					level,
					position: { start: { line: i } },
				});
			}
		}
	}

	return headings;
}

export function parseMarkdownSections(
	markdown: string,
	headings?: any[]
): { root: SectionNode; flatNodes: SectionNode[]; error?: string } {
	const normalizedMd = markdown.replace(/\r\n/g, "\n");
	const lines = normalizedMd.split("\n");
	const resolvedHeadings =
		headings && headings.length > 0 ? headings : extractHeadingsFromMarkdown(normalizedMd);

	if (!resolvedHeadings || resolvedHeadings.length === 0) {
		const { text: cleanBody } = stripFrontmatterWithOffset(normalizedMd);
		const rootNode: SectionNode = {
			id: "node-root",
			title: "0. Full document",
			displayTitle: "0. Full document",
			level: 0,
			lineStart: 0,
			lineEnd: Math.max(0, lines.length - 1),
			parent: null,
			children: [],
			contentMarkdown: cleanBody,
			rawOwnMarkdown: cleanBody,
			childHeadingsHtml: "",
			flatIndex: 0
		};
		return {
			root: rootNode,
			flatNodes: [rootNode],
			error: "no_headings"
		};
	}

	const { text: cleanFullBody } = stripFrontmatterWithOffset(normalizedMd);
	const rootNode: SectionNode = {
		id: "node-root",
		title: "0. Full document",
		displayTitle: "0. Full document",
		level: 0,
		lineStart: 0,
		lineEnd: lines.length - 1,
		parent: null,
		children: [],
		contentMarkdown: cleanFullBody,
		rawOwnMarkdown: cleanFullBody,
		childHeadingsHtml: ""
	};

	const headingNodes: SectionNode[] = [];
	const stack: SectionNode[] = [rootNode];

	for (let i = 0; i < resolvedHeadings.length; i++) {
		const h = resolvedHeadings[i];
		const nextH = i < resolvedHeadings.length - 1 ? resolvedHeadings[i + 1] : null;

		let lineEnd = lines.length - 1;
		if (nextH) {
			let endIdx = nextH.position.start.line - 1;
			for (let j = i + 1; j < resolvedHeadings.length; j++) {
				if (resolvedHeadings[j].level <= h.level) {
					endIdx = resolvedHeadings[j].position.start.line - 1;
					break;
				}
			}
			lineEnd = Math.max(h.position.start.line, endIdx);
		}

		const lineStart = h.position.start.line;
		const rawTitle: string = h.heading || "";

		const node: SectionNode = {
			id: `section-${i}-${h.position.start.line}`,
			title: rawTitle,
			displayTitle: stripHeadingLinksToPlainText(rawTitle) || rawTitle,
			level: h.level,
			lineStart,
			lineEnd,
			parent: null,
			children: [],
			contentMarkdown: "",
			rawOwnMarkdown: "",
			childHeadingsHtml: ""
		};

		while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		node.parent = parent;
		parent.children.push(node);
		stack.push(node);

		headingNodes.push(node);
	}

	const flatNodes: SectionNode[] = [rootNode, ...headingNodes];
	flatNodes.forEach((n, idx) => {
		n.flatIndex = idx;
	});

	for (const node of headingNodes) {
		if (node.children.length === 0) {
			const bodyOnly = lines
				.slice(node.lineStart + 1, node.lineEnd + 1)
				.join("\n")
				.replace(/^[\s\-*_]+$/gm, "")
				.trim();
			const trimmedTitle = node.title.trim();
			node.isEmptyHeadingLeaf = bodyOnly.length === 0;
			node.isPureLinkLeaf =
				node.isEmptyHeadingLeaf &&
				(/^\[\[[^\]]+\]\]$/.test(trimmedTitle) || /^\[[^\]\n]+\]\([^)\n]+\)$/.test(trimmedTitle));
		} else {
			node.isEmptyHeadingLeaf = false;
			node.isPureLinkLeaf = false;
		}
	}

	for (const node of headingNodes) {
		if (node.children.length > 0) {
			const intro = lines.slice(node.lineStart, node.children[0].lineStart).join("\n");
			const childHeadings = buildChildHeadingsHtml(node.children, false);
			node.rawOwnMarkdown = intro;
			node.childHeadingsHtml = childHeadings;
			node.contentMarkdown = `${intro}\n${childHeadings}`;
		} else {
			const leafMd = lines.slice(node.lineStart, node.lineEnd + 1).join("\n");
			node.rawOwnMarkdown = leafMd;
			node.childHeadingsHtml = "";
			node.contentMarkdown = leafMd;
		}
	}

	return {
		root: rootNode,
		flatNodes
	};
}

export function hasSubstantivePreamble(markdown: string, firstHeadingLine: number): boolean {
	if (firstHeadingLine <= 0) return false;
	const normalized = markdown.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	let startIdx = 0;
	if (lines.length > 0 && /^---\s*$/.test(lines[0])) {
		for (let j = 1; j < lines.length; j++) {
			if (/^(?:---|\.\.\.)\s*$/.test(lines[j])) {
				startIdx = j + 1;
				break;
			}
		}
	}
	if (startIdx >= firstHeadingLine) return false;
	const preamble = lines
		.slice(startIdx, firstHeadingLine)
		.join("\n")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^[\s\-*_]+$/gm, "")
		.trim();
	return preamble.length > 0;
}

export function findCurrentSectionNode(flatNodes: SectionNode[], cursorLine: number): SectionNode {
	let bestMatch: SectionNode | null = null;
	for (const node of flatNodes) {
		if (node.isVirtualDeleted) continue;
		if (cursorLine >= node.lineStart && cursorLine <= node.lineEnd) {
			if (!bestMatch || node.level >= bestMatch.level) {
				bestMatch = node;
			}
		}
	}
	return bestMatch || flatNodes[0];
}
