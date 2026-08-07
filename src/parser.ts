export interface SectionNode {
	id: string;
	title: string;
	level: number;
	lineStart: number;
	lineEnd: number;
	parent: SectionNode | null;
	children: SectionNode[];
	contentMarkdown: string;
	flatIndex?: number;
}

export function parseMarkdownSections(
	markdown: string,
	headings: any[] | undefined
): { root: SectionNode; flatNodes: SectionNode[]; error?: string } {
	const lines = markdown.split("\n");

	if (!headings || headings.length === 0) {
		const rootNode: SectionNode = {
			id: "node-root",
			title: "0. Document complet",
			level: 0,
			lineStart: 0,
			lineEnd: Math.max(0, lines.length - 1),
			parent: null,
			children: [],
			contentMarkdown: markdown,
			flatIndex: 0
		};
		return {
			root: rootNode,
			flatNodes: [rootNode],
			error: "no_headings"
		};
	}

	const rootNode: SectionNode = {
		id: "node-root",
		title: "0. Document complet",
		level: 0,
		lineStart: 0,
		lineEnd: lines.length - 1,
		parent: null,
		children: [],
		contentMarkdown: markdown
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
			contentMarkdown: ""
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

	for (const node of headingNodes) {
		if (node.children.length > 0) {
			const intro = lines.slice(node.lineStart, node.children[0].lineStart).join("\n");
			const childHeadings = node.children
				.map((c) => `<div class="dynamic-slides-child-heading level-${c.level}">${c.title}</div>`)
				.join("\n");
			node.contentMarkdown = `${intro}\n${childHeadings}`;
		} else {
			node.contentMarkdown = lines.slice(node.lineStart, node.lineEnd + 1).join("\n");
		}
	}

	const flatNodes: SectionNode[] = [rootNode, ...headingNodes];
	flatNodes.forEach((n, idx) => {
		n.flatIndex = idx;
	});

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
