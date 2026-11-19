/**
 * contextExtractor.ts — Extraction chirurgicale du contexte visible pour les commentaires SlideFlow.
 *
 * Gère les 4 portées distinctes sans jamais inclure de contenu hors écran ou masqué :
 * 1. `selection` : uniquement le passage surligné par l'utilisateur (avec ancien/nouveau si diff inclus).
 * 2. `zoom`      : uniquement l'élément zoomé actif (tableau, bloc de code, mermaid, image, iframe), sans le reste de la slide.
 * 3. `viewport`  : uniquement les blocs texte actuellement visibles dans le viewport de défilement de la slide
 *                  (exclut automatiquement les tableaux/images/codes masqués avant zoom et les paragraphes hors écran).
 */

import { hashText, SlideDiffInfo } from "./diffEngine";

export type CommentScopeType = "selection" | "zoom" | "viewport";

export interface AnchorRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface ExtractedCommentContext {
	scopeType: CommentScopeType;
	scopeLabel: string;
	contextKey: string;
	excerpt: string;
	hadDiff: boolean;
	oldExcerpt?: string | null;
	anchorRect?: AnchorRect | null;
}

const SKIP_CLASS_LIST = [
	"dynamic-slides-child-heading",
	"copy-code-button",
	"slideflow-deleted-sections-title",
	"callout-icon",
	"callout-fold",
	"svg-icon",
	"slideflow-selection-toolbar",
];

function shouldSkipElement(el: HTMLElement, mode: "current" | "old", checkLiveVisibility: boolean): boolean {
	for (const cls of SKIP_CLASS_LIST) {
		if (el.classList.contains(cls)) return true;
	}
	if (el.tagName.toLowerCase() === "button" && el.classList.contains("copy-code-button")) {
		return true;
	}
	if (mode === "current") {
		if (
			el.tagName.toLowerCase() === "del" ||
			el.classList.contains("dv-del") ||
			el.classList.contains("dv-block-del") ||
			el.classList.contains("dv-pre-del") ||
			el.classList.contains("slideflow-deleted-sections")
		) {
			return true;
		}
	} else {
		if (
			el.tagName.toLowerCase() === "ins" ||
			el.classList.contains("dv-ins") ||
			el.classList.contains("dv-block-ins") ||
			el.classList.contains("dv-pre-ins")
		) {
			return true;
		}
	}
	if (checkLiveVisibility && el.isConnected) {
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden") {
			return true;
		}
	}
	return false;
}

function serializeTableToMarkdown(tableEl: HTMLTableElement, mode: "current" | "old", checkLiveVisibility: boolean): string {
	const rows: string[][] = [];
	const trList = Array.from(tableEl.querySelectorAll("tr"));
	for (const tr of trList) {
		if (shouldSkipElement(tr, mode, checkLiveVisibility)) continue;
		const cells = Array.from(tr.children).filter(
			(c) => c.tagName.toLowerCase() === "th" || c.tagName.toLowerCase() === "td"
		) as HTMLElement[];
		if (cells.length === 0) continue;
		const rowText = cells.map((cell) =>
			serializeNode(cell, mode, checkLiveVisibility)
				.replace(/\s*\n\s*/g, " ")
				.replace(/\|/g, "\\|")
				.trim()
		);
		rows.push(rowText);
	}
	if (rows.length === 0) return "";
	const colCount = Math.max(...rows.map((r) => r.length));
	const padRow = (r: string[]) => {
		const padded = [...r];
		while (padded.length < colCount) padded.push("");
		return `| ${padded.join(" | ")} |`;
	};
	const lines: string[] = [padRow(rows[0]), `| ${Array(colCount).fill("---").join(" | ")} |`];
	for (let i = 1; i < rows.length; i++) {
		lines.push(padRow(rows[i]));
	}
	return lines.join("\n");
}

function serializePreToMarkdown(preEl: HTMLElement): string {
	const codeEl = preEl.querySelector("code");
	const rawCode = (codeEl ? codeEl.textContent : preEl.textContent) || "";
	const langClass = Array.from((codeEl || preEl).classList).find((c) => c.startsWith("language-"));
	const lang = langClass ? langClass.replace(/^language-/, "") : "";
	return `\`\`\`${lang}\n${rawCode.replace(/\n+$/, "")}\n\`\`\``;
}

function serializeNode(node: Node, mode: "current" | "old", checkLiveVisibility: boolean): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent || "";
	}
	if (node.nodeType !== Node.ELEMENT_NODE) {
		return "";
	}

	const el = node as HTMLElement;
	if (shouldSkipElement(el, mode, checkLiveVisibility)) {
		return "";
	}

	const tag = el.tagName.toLowerCase();

	if (tag === "br") return "\n";
	if (tag === "hr") return "\n---\n";

	if (tag === "img") {
		const alt = el.getAttribute("alt") || "image";
		const src = el.getAttribute("src") || "";
		return `![${alt}](${src})`;
	}

	if (tag === "iframe") {
		const src = el.getAttribute("src") || "";
		return `<iframe src="${src}"></iframe>`;
	}

	if (tag === "table") {
		return serializeTableToMarkdown(el as HTMLTableElement, mode, checkLiveVisibility);
	}

	if (tag === "pre") {
		return serializePreToMarkdown(el);
	}

	if (tag === "code" && !el.closest("pre")) {
		const inner = (el.textContent || "").trim();
		return inner ? `\`${inner}\`` : "";
	}

	const childrenText = Array.from(el.childNodes)
		.map((child) => serializeNode(child, mode, checkLiveVisibility))
		.join("");

	if (/^h[1-6]$/.test(tag)) {
		const level = parseInt(tag[1], 10);
		const clean = childrenText.trim();
		return clean ? `${"#".repeat(level)} ${clean}\n\n` : "";
	}

	if (tag === "li") {
		const clean = childrenText.trim();
		if (!clean) return "";
		const isOrdered = el.parentElement?.tagName.toLowerCase() === "ol";
		const prefix = isOrdered ? "1. " : "- ";
		return `${prefix}${clean}\n`;
	}

	if (tag === "ul" || tag === "ol") {
		const clean = childrenText.trim();
		return clean ? `${clean}\n\n` : "";
	}

	if (tag === "blockquote") {
		const clean = childrenText.trim();
		if (!clean) return "";
		return (
			clean
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n") + "\n\n"
		);
	}

	if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
		const clean = childrenText.trim();
		return clean ? `${clean}\n\n` : "";
	}

	return childrenText;
}

function cleanExtractedText(raw: string): string {
	return raw
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function getDiffEnclosureKind(node: Node | null): "ins" | "del" | null {
	let curr: Node | null = node;
	while (curr) {
		if (curr.nodeType === Node.ELEMENT_NODE) {
			const el = curr as HTMLElement;
			const tag = el.tagName.toLowerCase();
			if (tag === "del" || el.classList.contains("dv-del") || el.classList.contains("dv-block-del") || el.classList.contains("dv-pre-del") || el.classList.contains("slideflow-deleted-sections")) {
				return "del";
			}
			if (tag === "ins" || el.classList.contains("dv-ins") || el.classList.contains("dv-block-ins") || el.classList.contains("dv-pre-ins")) {
				return "ins";
			}
		}
		curr = curr.parentNode;
	}
	return null;
}

/**
 * 1. Portée SÉLECTION : extrait uniquement le texte surligné par l'utilisateur.
 */
export function extractSelectionContext(
	range: Range,
	notePath: string,
	sectionHeading: string
): ExtractedCommentContext | null {
	if (range.collapsed) return null;

	const rect = range.getBoundingClientRect();
	const anchorRect: AnchorRect = {
		left: rect.left,
		top: rect.top,
		right: rect.right,
		bottom: rect.bottom,
	};

	const frag = range.cloneContents();
	const wrapper = document.createElement("div");
	wrapper.appendChild(frag);

	const enclosure = getDiffEnclosureKind(range.commonAncestorContainer);
	let currentText = "";
	let oldText: string | null = null;
	let hadDiff = false;

	if (enclosure === "ins") {
		currentText = cleanExtractedText(serializeNode(wrapper, "current", false));
		oldText = "";
		hadDiff = true;
	} else if (enclosure === "del") {
		oldText = cleanExtractedText(serializeNode(wrapper, "old", false));
		currentText = "";
		hadDiff = true;
	} else {
		const hasInnerDiff = Boolean(
			wrapper.querySelector("ins.dv-ins, del.dv-del, .dv-block-ins, .dv-block-del, .dv-pre-ins, .dv-pre-del")
		);
		currentText = cleanExtractedText(serializeNode(wrapper, "current", false));
		if (hasInnerDiff) {
			oldText = cleanExtractedText(serializeNode(wrapper, "old", false));
			hadDiff = oldText !== currentText;
		}
	}

	const displayOrFallback = currentText || oldText || cleanExtractedText(range.toString());
	if (!displayOrFallback) return null;

	return {
		scopeType: "selection",
		scopeLabel: "Selection",
		contextKey: `sel:${notePath}::${sectionHeading}::${hashText(currentText + "|" + (oldText ?? ""))}`,
		excerpt: currentText || "(Texte supprimé dans le diff)",
		hadDiff,
		oldExcerpt: hadDiff ? oldText : undefined,
		anchorRect,
	};
}

/**
 * Extrait le n-ième bloc mermaid brut depuis le Markdown de la slide si un diagramme Mermaid est zoomé.
 */
function extractMermaidSourceFromMarkdown(rawMarkdown: string, indexHint: number): string | null {
	const matches: string[] = [];
	const re = /```mermaid[^\n]*\n[\s\S]*?```/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rawMarkdown)) !== null) {
		matches.push(m[0].trim());
	}
	if (matches.length === 0) return null;
	return matches[Math.min(indexHint, matches.length - 1)] || matches[0];
}

/**
 * 2. Portée ZOOM : extrait uniquement le tableau / bloc de code / mermaid / image / iframe actuellement zoomé.
 */
export function extractZoomContext(
	zoomContentEl: HTMLElement,
	notePath: string,
	sectionHeading: string,
	activeZoomIndex: number,
	rawOwnMarkdown: string
): ExtractedCommentContext {
	const isTable = Boolean(zoomContentEl.querySelector(".dynamic-slides-zoom-table"));
	const isCode = Boolean(zoomContentEl.querySelector(".dynamic-slides-zoom-code"));
	const isMermaid = Boolean(zoomContentEl.querySelector(".dynamic-slides-zoom-mermaid"));
	const isImage = Boolean(zoomContentEl.querySelector(".dynamic-slides-zoom-image"));
	const isIframe = Boolean(zoomContentEl.querySelector(".dynamic-slides-zoom-iframe"));

	let scopeLabel = "Zoom";
	let currentText = "";
	let oldText: string | null = null;
	let hadDiff = false;

	if (isTable) {
		scopeLabel = "Zoom · Table";
		const tableEl = zoomContentEl.querySelector("table") as HTMLTableElement | null;
		if (tableEl) {
			currentText = cleanExtractedText(serializeTableToMarkdown(tableEl, "current", false));
			const hasInnerDiff = Boolean(zoomContentEl.querySelector("ins.dv-ins, del.dv-del"));
			if (hasInnerDiff) {
				oldText = cleanExtractedText(serializeTableToMarkdown(tableEl, "old", false));
				hadDiff = oldText !== currentText;
			}
		}
	} else if (isCode) {
		scopeLabel = "Zoom · Code";
		const preEl = zoomContentEl.querySelector("pre") as HTMLElement | null;
		if (preEl) {
			const clone = preEl.cloneNode(true) as HTMLElement;
			clone.querySelectorAll(".copy-code-button").forEach((b) => b.remove());
			currentText = cleanExtractedText(serializePreToMarkdown(clone));
		}
	} else if (isMermaid) {
		scopeLabel = "Zoom · Diagram";
		const rawMermaid = extractMermaidSourceFromMarkdown(rawOwnMarkdown, Math.max(0, activeZoomIndex));
		currentText = rawMermaid || "[Mermaid diagram]";
	} else if (isImage) {
		scopeLabel = "Zoom · Image";
		const imgEl = zoomContentEl.querySelector("img");
		const alt = imgEl?.getAttribute("alt") || "image";
		const src = imgEl?.getAttribute("src") || "";
		currentText = `![${alt}](${src})`;
	} else if (isIframe) {
		scopeLabel = "Zoom · Embed";
		const iframeEl = zoomContentEl.querySelector("iframe");
		const src = iframeEl?.getAttribute("src") || "";
		currentText = `<iframe src="${src}"></iframe>`;
	} else {
		currentText = cleanExtractedText(serializeNode(zoomContentEl, "current", false));
	}

	if (!currentText) {
		currentText = cleanExtractedText(zoomContentEl.textContent || "[Zoomed element]");
	}

	return {
		scopeType: "zoom",
		scopeLabel,
		contextKey: `zoom:${notePath}::${sectionHeading}::${activeZoomIndex}::${hashText(currentText)}`,
		excerpt: currentText,
		hadDiff,
		oldExcerpt: hadDiff ? oldText : undefined,
		anchorRect: null,
	};
}

/**
 * Collecte les éléments blocs feuilles visibles dans le viewport de défilement de `contentEl`.
 * Exclut automatiquement tous les éléments `display: none` (ex. tableaux/images/code masqués avant zoom).
 */
function collectVisibleBlocks(containerEl: HTMLElement, viewTop: number, viewBottom: number): HTMLElement[] {
	const results: HTMLElement[] = [];

	const visit = (parent: HTMLElement) => {
		for (const child of Array.from(parent.children) as HTMLElement[]) {
			if (SKIP_CLASS_LIST.some((c) => child.classList.contains(c))) continue;
			const style = window.getComputedStyle(child);
			if (style.display === "none" || style.visibility === "hidden") continue;

			const rect = child.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) continue;

			// Hors viewport vertical ? Ignorer immédiatement
			if (rect.bottom < viewTop + 2 || rect.top > viewBottom - 2) continue;

			const tag = child.tagName.toLowerCase();
			// Descendre dans les conteneurs de liste / blocs diff pour filtrer finement chaque item visible
			if (
				tag === "ul" ||
				tag === "ol" ||
				child.classList.contains("dv-block-ins") ||
				child.classList.contains("dv-block-del") ||
				child.classList.contains("slideflow-deleted-sections")
			) {
				// Si le conteneur est entièrement dans le viewport, on peut garder l'élément entier,
				// sinon on descend item par item pour ne prendre que ce qui est réellement affiché !
				if (rect.top >= viewTop - 4 && rect.bottom <= viewBottom + 4) {
					results.push(child);
				} else {
					visit(child);
				}
			} else {
				results.push(child);
			}
		}
	};

	visit(containerEl);
	return results;
}

/**
 * 3. Portée VIEWPORT / SLIDE : extrait uniquement le texte actuellement affiché à l'écran
 * (sans les tableaux/images/blocs de code masqués avant zoom, et limité à la fenêtre visible en cas de scroll).
 */
export function extractVisibleSlideContext(
	contentEl: HTMLElement,
	notePath: string,
	sectionHeading: string,
	slideDiff: SlideDiffInfo | undefined,
	diffEnabled: boolean
): ExtractedCommentContext {
	const containerRect = contentEl.getBoundingClientRect();
	const isScrollable = contentEl.scrollHeight > contentEl.clientHeight + 20;
	const visibleBlocks = collectVisibleBlocks(contentEl, containerRect.top, containerRect.bottom);

	const currentParts: string[] = [];
	const oldParts: string[] = [];

	for (const block of visibleBlocks) {
		const enclosure = getDiffEnclosureKind(block);
		if (enclosure === "del") {
			const txt = cleanExtractedText(serializeNode(block, "old", true));
			if (txt) oldParts.push(txt);
		} else if (enclosure === "ins") {
			const txt = cleanExtractedText(serializeNode(block, "current", true));
			if (txt) currentParts.push(txt);
		} else {
			const curr = cleanExtractedText(serializeNode(block, "current", true));
			const old = cleanExtractedText(serializeNode(block, "old", true));
			if (curr) currentParts.push(curr);
			if (old) oldParts.push(old);
		}
	}

	const currentText = cleanExtractedText(currentParts.join("\n\n"));
	let oldText: string | null = cleanExtractedText(oldParts.join("\n\n"));
	let hadDiff = false;

	if (diffEnabled) {
		hadDiff = oldText !== currentText && (Boolean(slideDiff?.hasChanges) || oldText.length > 0);
	} else if (slideDiff?.hasChanges) {
		// Si l'utilisateur a masqué le diff temporairement avec D mais que la slide a un diff,
		// inclure l'ancien texte connu (si slide non tronquée par scroll)
		hadDiff = true;
		oldText = slideDiff.rawOldMarkdown ?? "";
	}

	const scopeLabel = isScrollable ? "Visible viewport" : "Slide";
	const finalExcerpt = currentText || "(Contenu visible vide)";

	return {
		scopeType: "viewport",
		scopeLabel,
		contextKey: `vp:${notePath}::${sectionHeading}::${hashText(finalExcerpt + "|" + (hadDiff ? oldText ?? "" : ""))}`,
		excerpt: finalExcerpt,
		hadDiff,
		oldExcerpt: hadDiff ? oldText : undefined,
		anchorRect: null,
	};
}

/**
 * Applique ou efface un surlignage vert non-destructif sur le Range sélectionné via CSS Custom Highlight API.
 */
export function setGreenSelectionHighlight(range: Range | null): void {
	const cssAny = (window as any).CSS;
	const HighlightCtor = (window as any).Highlight;
	if (!cssAny?.highlights || !HighlightCtor) return;
	if (!range || range.collapsed) {
		cssAny.highlights.delete("slideflow-selection");
		return;
	}
	try {
		const hl = new HighlightCtor(range.cloneRange());
		cssAny.highlights.set("slideflow-selection", hl);
	} catch {
		cssAny.highlights.delete("slideflow-selection");
	}
}
