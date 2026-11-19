export interface SectionNode {
	id: string;
	title: string;
	level: number;
	lineStart: number;
	lineEnd: number;
	parent: SectionNode | null;
	children: SectionNode[];
	contentMarkdown: string;
	rawOwnMarkdown: string;
	childHeadingsHtml: string;
	flatIndex?: number;
}

export function stripFrontmatterWithOffset(markdown: string): { text: string; strippedLines: number } {
	const normalized = markdown.replace(/\r\n/g, "\n");
	const m = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
	if (!m) return { text: normalized, strippedLines: 0 };
	const strippedLines = m[0].split("\n").length - 1;
	return { text: normalized.slice(m[0].length), strippedLines };
}

export function parseMarkdownSections(
	markdown: string,
	headings: any[] | undefined
): { root: SectionNode; flatNodes: SectionNode[]; error?: string } {
	const normalizedMd = markdown.replace(/\r\n/g, "\n");
	const lines = normalizedMd.split("\n");

	if (!headings || headings.length === 0) {
		const { text: cleanBody } = stripFrontmatterWithOffset(normalizedMd);
		const rootNode: SectionNode = {
			id: "node-root",
			title: "0. Full document",
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

	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		const nextH = i < headings.length - 1 ? headings[i + 1] : null;

		let lineEnd = lines.length - 1;
		if (nextH) {
			let endIdx = nextH.position.start.line - 1;
			for (let j = i + 1; j < headings.length; j++) {
				if (headings[j].level <= h.level) {
					endIdx = headings[j].position.start.line - 1;
					break;
				}
			}
			lineEnd = Math.max(h.position.start.line, endIdx);
		}

		const lineStart = h.position.start.line;

		const node: SectionNode = {
			id: `section-${i}-${h.position.start.line}`,
			title: h.heading,
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
		if (node.children.length > 0) {
			const intro = lines.slice(node.lineStart, node.children[0].lineStart).join("\n");
			const childHeadings = node.children
				.map((c) => `<div class="dynamic-slides-child-heading level-${c.level}" data-node-id="${c.id}" data-flat-index="${c.flatIndex}">${c.title}</div>`)
				.join("\n");
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

export function findCurrentSectionNode(flatNodes: SectionNode[], cursorLine: number): SectionNode {
	let bestMatch: SectionNode | null = null;
	for (const node of flatNodes) {
		if (cursorLine >= node.lineStart && cursorLine <= node.lineEnd) {
			if (!bestMatch || node.level >= bestMatch.level) {
				bestMatch = node;
			}
		}
	}
	return bestMatch || flatNodes[0];
}
