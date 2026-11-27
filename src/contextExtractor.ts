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
import { captureSelectionAnchorSnippet } from "./commentHighlighter";

export type CommentScopeType = "selection" | "zoom" | "viewport" | "general";

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
	selectionQuote?: string;
	selectionPrefix?: string;
	selectionSuffix?: string;
	excerpt: string;
	hadDiff: boolean;
	oldExcerpt?: string | null;
	anchorRect?: AnchorRect | null;
}

const SKIP_CLASS_LIST = [
	"dynamic-slides-child-heading",
	"copy-code-button",
	"slideflow-details-copy-btn",
	"slideflow-details-chevron",
	"slideflow-deleted-sections-title",
	"callout-icon",
	"callout-fold",
	"svg-icon",
	"slideflow-selection-toolbar",
	"slideflow-link-dirty-badge",
	"slideflow-comments-rail",
	"slideflow-table-selector-bar",
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

	if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "summary" || tag === "details") {
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
	sectionHeading: string,
	containerEl?: HTMLElement | null
): ExtractedCommentContext | null {
	if (range.collapsed) return null;

	const rect = range.getBoundingClientRect();
	const anchorRect: AnchorRect = {
		left: rect.left,
		top: rect.top,
		right: rect.right,
		bottom: rect.bottom,
	};

	const anchorSnippet = containerEl
		? captureSelectionAnchorSnippet(range, containerEl)
		: { selectionQuote: range.toString().trim(), selectionPrefix: "", selectionSuffix: "" };

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
		selectionQuote: anchorSnippet.selectionQuote || undefined,
		selectionPrefix: anchorSnippet.selectionPrefix || undefined,
		selectionSuffix: anchorSnippet.selectionSuffix || undefined,
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
	const pdfZoomEl = zoomContentEl.querySelector(".dynamic-slides-zoom-pdf") as HTMLElement | null;
	const pluginZoomEl = zoomContentEl.querySelector(".dynamic-slides-zoom-plugin") as HTMLElement | null;

	let scopeLabel = "Zoom";
	let currentText = "";
	let oldText: string | null = null;
	let hadDiff = false;

	if (pdfZoomEl) {
		scopeLabel = "Zoom · PDF";
		const pdfRef = pdfZoomEl.getAttribute("data-pdf-source") || "[PDF document]";
		currentText = pdfRef;
	} else if (pluginZoomEl) {
		const pluginLang = (pluginZoomEl.getAttribute("data-plugin-lang") || "").trim();
		scopeLabel = pluginLang ? `Zoom · ${pluginLang}` : "Zoom · Widget";
		currentText = cleanExtractedText(serializeNode(pluginZoomEl, "current", false));
	} else if (isTable) {
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
 * 2b. Portée LIGNE DE TABLEAU ZOOMÉ : extrait uniquement la ligne sélectionnée (avec l'en-tête
 * du tableau pour un contexte Markdown parfaitement lisible) sans embarquer les 40+ autres lignes.
 */
export function extractTableRowContext(
	rowEl: HTMLTableRowElement,
	tableEl: HTMLTableElement,
	notePath: string,
	sectionHeading: string,
	activeZoomIndex: number,
	rowIndex: number
): ExtractedCommentContext {
	const serializeRowCells = (tr: HTMLTableRowElement, mode: "current" | "old"): string[] => {
		const cells = Array.from(tr.children).filter(
			(c) => c.tagName.toLowerCase() === "th" || c.tagName.toLowerCase() === "td"
		) as HTMLElement[];
		return cells.map((cell) =>
			serializeNode(cell, mode, false)
				.replace(/\s*\n\s*/g, " ")
				.replace(/\|/g, "\\|")
				.trim()
		);
	};

	const headerRow = tableEl.querySelector("thead tr") as HTMLTableRowElement | null;
	const buildTableMd = (mode: "current" | "old"): string => {
		const dataCells = serializeRowCells(rowEl, mode);
		if (dataCells.length === 0) return "";
		const headerCells = headerRow ? serializeRowCells(headerRow, mode) : [];
		const colCount = Math.max(dataCells.length, headerCells.length);
		const pad = (r: string[]) => {
			const out = [...r];
			while (out.length < colCount) out.push("");
			return `| ${out.join(" | ")} |`;
		};
		if (headerCells.length > 0) {
			return [
				pad(headerCells),
				`| ${Array(colCount).fill("---").join(" | ")} |`,
				pad(dataCells),
			].join("\n");
		}
		return pad(dataCells);
	};

	const currentText = cleanExtractedText(buildTableMd("current")) || cleanExtractedText(rowEl.textContent || "[Table row]");
	let oldText: string | null = null;
	let hadDiff = false;
	if (rowEl.querySelector("ins.dv-ins, del.dv-del")) {
		oldText = cleanExtractedText(buildTableMd("old"));
		hadDiff = oldText !== currentText;
	}

	const rect = rowEl.getBoundingClientRect();
	return {
		scopeType: "zoom",
		scopeLabel: `Zoom · Table Row ${rowIndex + 1}`,
		contextKey: `zoom-row:${notePath}::${sectionHeading}::${activeZoomIndex}::${rowIndex}::${hashText(currentText)}`,
		excerpt: currentText,
		hadDiff,
		oldExcerpt: hadDiff ? oldText : undefined,
		anchorRect: {
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
		},
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

const HOVER_EXCLUDED_SELECTOR = [
	".dynamic-slides-child-heading",
	".slideflow-deleted-sections-title",
	".copy-code-button",
	".slideflow-details-copy-btn",
	".slideflow-selection-toolbar",
	".slideflow-comments-rail",
	".slideflow-hover-add-btn",
].join(", ");

const HOVER_DIRECT_MEDIA_SELECTOR =
	"img:not(.emoji):not(.svg-icon), .mermaid, svg.mermaid, .block-language-mermaid, .pdf-embed, .internal-embed, iframe";

function isVisibleHoverCandidate(el: HTMLElement): boolean {
	if (!el.isConnected) return false;
	const style = window.getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden") return false;
	const rect = el.getBoundingClientRect();
	if (rect.width < 4 || rect.height < 4) return false;
	const hasMedia = Boolean(el.matches(HOVER_DIRECT_MEDIA_SELECTOR) || el.querySelector(HOVER_DIRECT_MEDIA_SELECTOR));
	const hasText = Boolean((el.textContent || "").trim().length > 0);
	return hasMedia || hasText;
}

/**
 * Resolves the specific Markdown block element currently hovered inside `.dynamic-slides-content`
 * (paragraph, callout, list item, blockquote, code block, table, heading, or media/embed).
 * Returns null if the cursor is outside the slide card or on non-commentable chrome.
 */
export function findHoverableMarkdownBlock(
	target: EventTarget | null,
	contentEl: HTMLElement
): HTMLElement | null {
	if (!(target instanceof Node) || !contentEl.contains(target)) {
		return null;
	}
	const startEl =
		target.nodeType === Node.ELEMENT_NODE
			? (target as HTMLElement)
			: target.parentElement;
	if (!startEl || startEl === contentEl) return null;
	if (startEl.closest(HOVER_EXCLUDED_SELECTOR)) return null;

	// If inside a callout, target the entire callout block cleanly
	const calloutEl = startEl.closest(".callout") as HTMLElement | null;
	if (calloutEl && contentEl.contains(calloutEl) && isVisibleHoverCandidate(calloutEl)) {
		return calloutEl;
	}

	// If inside a collapsible `<details>` block, target it cleanly
	const detailsEl = startEl.closest("details") as HTMLElement | null;
	if (detailsEl && contentEl.contains(detailsEl) && isVisibleHoverCandidate(detailsEl)) {
		return detailsEl;
	}

	// If inside a live third-party plugin code block (e.g. chess-pgn, dataview), target the outer widget atomically
	const pluginBlockEl = startEl.closest(
		"[class*='block-language-']:not(.callout):not(.block-language-mermaid)"
	) as HTMLElement | null;
	if (pluginBlockEl && contentEl.contains(pluginBlockEl) && isVisibleHoverCandidate(pluginBlockEl)) {
		return pluginBlockEl;
	}

	// Walk up from the hovered node to the nearest specific Markdown block
	let curr: HTMLElement | null = startEl;
	while (curr && curr !== contentEl) {
		if (curr.matches(HOVER_EXCLUDED_SELECTOR)) {
			return null;
		}
		const tag = curr.tagName.toLowerCase();

		if (
			tag === "pre" ||
			tag === "table" ||
			tag === "blockquote" ||
			tag === "li" ||
			tag === "p" ||
			/^h[1-6]$/.test(tag) ||
			curr.matches(HOVER_DIRECT_MEDIA_SELECTOR)
		) {
			// Prefer enclosing <li> when hovering a loose <p> directly inside an <li>
			if (tag === "p" && curr.parentElement?.tagName.toLowerCase() === "li") {
				const parentLi = curr.parentElement;
				if (contentEl.contains(parentLi) && !parentLi.querySelector(":scope > ul, :scope > ol")) {
					if (isVisibleHoverCandidate(parentLi)) return parentLi;
				}
			}
			// Prefer enclosing <pre>/<table>/<blockquote> when hovering inside them
			const enclosingTable = curr.closest("table") as HTMLElement | null;
			if (enclosingTable && contentEl.contains(enclosingTable) && isVisibleHoverCandidate(enclosingTable)) {
				return enclosingTable;
			}
			const enclosingPre = curr.closest("pre") as HTMLElement | null;
			if (enclosingPre && contentEl.contains(enclosingPre) && isVisibleHoverCandidate(enclosingPre)) {
				return enclosingPre;
			}
			const enclosingQuote = curr.closest("blockquote") as HTMLElement | null;
			if (enclosingQuote && contentEl.contains(enclosingQuote) && isVisibleHoverCandidate(enclosingQuote)) {
				return enclosingQuote;
			}
			if (isVisibleHoverCandidate(curr)) {
				return curr;
			}
		}

		if (
			(curr.classList.contains("dv-block-ins") || curr.classList.contains("dv-block-del")) &&
			isVisibleHoverCandidate(curr)
		) {
			return curr;
		}

		curr = curr.parentElement;
	}

	return null;
}

export function getMarkdownBlockLabel(el: HTMLElement): string {
	if (el.classList.contains("callout")) return "Callout";
	const tag = el.tagName.toLowerCase();
	if (tag === "details") return "Collapsible";
	if (tag === "p") return "Paragraph";
	if (tag === "li") return "List item";
	if (tag === "blockquote") return "Quote";
	if (tag === "pre") return "Code";
	if (tag === "table") return "Table";
	if (/^h[1-6]$/.test(tag)) return "Heading";
	if (el.matches(".mermaid, svg.mermaid, .block-language-mermaid")) return "Diagram";
	if (el.matches("[class*='block-language-']:not(.callout)")) {
		const langCls = Array.from(el.classList).find((c) => c.startsWith("block-language-"));
		return langCls ? langCls.replace(/^block-language-/, "") : "Widget";
	}
	if (el.matches(".pdf-embed, .internal-embed, iframe")) return "Embed";
	if (tag === "img" || el.querySelector("img:not(.emoji):not(.svg-icon)")) return "Image";
	return "Element";
}

/**
 * 1b. Portée ÉLÉMENT SURVOLÉ : cible automatiquement le bloc Markdown précis sous le curseur
 * (paragraphe, callout, item de liste, citation, tableau, bloc de code, titre, image…)
 * afin que `C`/`V` surlignent et commentent cet élément sans sélection manuelle.
 */
export function extractBlockContext(
	blockEl: HTMLElement,
	notePath: string,
	sectionHeading: string,
	containerEl: HTMLElement
): { context: ExtractedCommentContext; range: Range | null } | null {
	if (!blockEl.isConnected || !containerEl.contains(blockEl)) return null;

	const blockLabel = getMarkdownBlockLabel(blockEl);
	const rect = blockEl.getBoundingClientRect();
	const blockRect: AnchorRect = {
		left: rect.left,
		top: rect.top,
		right: rect.right,
		bottom: rect.bottom,
	};

	const range = document.createRange();
	range.selectNodeContents(blockEl);
	const selCtx = extractSelectionContext(range, notePath, sectionHeading, containerEl);

	if (selCtx) {
		return {
			context: {
				...selCtx,
				scopeLabel: blockLabel,
				anchorRect: blockRect,
			},
			range,
		};
	}

	// Media-only block (e.g. image/embed/mermaid with no plain text nodes)
	const enclosure = getDiffEnclosureKind(blockEl);
	let currentText = "";
	let oldText: string | null = null;
	let hadDiff = false;
	if (enclosure === "ins") {
		currentText = cleanExtractedText(serializeNode(blockEl, "current", false));
		oldText = "";
		hadDiff = true;
	} else if (enclosure === "del") {
		oldText = cleanExtractedText(serializeNode(blockEl, "old", false));
		currentText = "";
		hadDiff = true;
	} else {
		currentText = cleanExtractedText(serializeNode(blockEl, "current", false));
	}

	const fallbackExcerpt = currentText || oldText || `[${blockLabel}]`;
	return {
		context: {
			scopeType: "selection",
			scopeLabel: blockLabel,
			contextKey: `blk:${notePath}::${sectionHeading}::${hashText(fallbackExcerpt + "|" + (oldText ?? ""))}`,
			excerpt: currentText || "(Texte supprimé dans le diff)",
			hadDiff,
			oldExcerpt: hadDiff ? oldText : undefined,
			anchorRect: blockRect,
		},
		range: null,
	};
}

const READING_FOCUS_SKIP_SELECTOR = [
	".copy-code-button",
	".slideflow-details-copy-btn",
	".slideflow-selection-toolbar",
	".slideflow-comments-rail",
	".slideflow-hover-add-btn",
	".slideflow-deleted-sections-title",
].join(", ");

function isVisibleReadableBlock(el: HTMLElement): boolean {
	if (!el.isConnected) return false;
	const style = window.getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) {
		return false;
	}
	const rect = el.getBoundingClientRect();
	if (rect.width < 4 || rect.height < 4) return false;
	const hasMedia = Boolean(
		el.matches(HOVER_DIRECT_MEDIA_SELECTOR) || el.querySelector(HOVER_DIRECT_MEDIA_SELECTOR)
	);
	const hasText = Boolean((el.textContent || "").trim().length > 0);
	return hasMedia || hasText;
}

/**
 * Collects all visible semantic reading blocks inside `.dynamic-slides-content` in top-to-bottom
 * reading order for keyboard reading-focus navigation (`ArrowDown` / `ArrowUp`):
 * - Headings (`h1..h6`), paragraphs (`p`), individual list items (`li`), callouts (`.callout`),
 *   blockquotes (`blockquote`), code blocks (`pre`), tables (`table`), child heading cards,
 *   and standalone media/images/embeds/diagrams (unwrapping image-only `<p>` so the image itself is framed).
 */
export function collectReadableBlocks(contentEl: HTMLElement): HTMLElement[] {
	const results: HTMLElement[] = [];
	const seen = new Set<HTMLElement>();

	const pushUnique = (el: HTMLElement) => {
		if (!seen.has(el) && isVisibleReadableBlock(el)) {
			seen.add(el);
			results.push(el);
		}
	};

	const visit = (parent: HTMLElement) => {
		for (const child of Array.from(parent.children) as HTMLElement[]) {
			if (child.matches(READING_FOCUS_SKIP_SELECTOR)) continue;
			const style = window.getComputedStyle(child);
			if (style.display === "none" || style.visibility === "hidden") continue;

			const tag = child.tagName.toLowerCase();
			if (tag === "hr" || tag === "br" || tag === "style" || tag === "script") continue;

			if (child.classList.contains("callout")) {
				pushUnique(child);
				continue;
			}

			if (tag === "details") {
				pushUnique(child);
				continue;
			}

			if (child.matches("[class*='block-language-']:not(.callout):not(.block-language-mermaid)")) {
				pushUnique(child);
				continue;
			}

			if (child.classList.contains("dynamic-slides-child-heading")) {
				pushUnique(child);
				continue;
			}

			if (tag === "table" || tag === "pre" || tag === "blockquote") {
				pushUnique(child);
				continue;
			}

			if (child.matches(HOVER_DIRECT_MEDIA_SELECTOR)) {
				pushUnique(child);
				continue;
			}

			if (/^h[1-6]$/.test(tag)) {
				pushUnique(child);
				continue;
			}

			if (tag === "p") {
				const directMedia = child.querySelector<HTMLElement>(HOVER_DIRECT_MEDIA_SELECTOR);
				if (directMedia) {
					const clone = child.cloneNode(true) as HTMLElement;
					clone.querySelectorAll(HOVER_DIRECT_MEDIA_SELECTOR).forEach((m) => m.remove());
					const remainingText = (clone.textContent || "").trim();
					if (remainingText.length === 0 && isVisibleReadableBlock(directMedia)) {
						pushUnique(directMedia);
						continue;
					}
				}
				pushUnique(child);
				continue;
			}

			if (tag === "li") {
				const nestedLists = Array.from(child.children).filter((c) => {
					const t = c.tagName.toLowerCase();
					return t === "ul" || t === "ol";
				}) as HTMLElement[];

				if (nestedLists.length === 0) {
					pushUnique(child);
				} else {
					// Keep the parent list item itself focusable if it has own text/media before sublists,
					// then also allow stepping down into its nested list items cleanly.
					const directP = Array.from(child.children).find(
						(c) => c.tagName.toLowerCase() === "p"
					) as HTMLElement | undefined;
					if (directP && isVisibleReadableBlock(directP)) {
						pushUnique(directP);
					} else {
						pushUnique(child);
					}
					for (const nl of nestedLists) {
						visit(nl);
					}
				}
				continue;
			}

			if (
				tag === "ul" ||
				tag === "ol" ||
				tag === "div" ||
				tag === "section" ||
				tag === "article"
			) {
				const before = results.length;
				visit(child);
				if (results.length === before && isVisibleReadableBlock(child)) {
					pushUnique(child);
				}
				continue;
			}

			if (isVisibleReadableBlock(child)) {
				pushUnique(child);
			}
		}
	};

	visit(contentEl);
	return results;
}

export const FOCUSED_BLOCK_LINK_SELECTOR = [
	"a.internal-link",
	".slideflow-child-heading-linked-title[data-link-href]",
	"a[href]:not(.tag):not(.footnote-link):not(.footnote-backref)",
].join(", ");

/**
 * Returns true if the given link element currently displays SlideFlow's green unread-diff dot
 * (`.slideflow-link-has-diff` class and/or `.slideflow-link-dirty-badge` dot element).
 */
export function hasUnreadLinkDot(linkEl: HTMLElement): boolean {
	return (
		linkEl.classList.contains("slideflow-link-has-diff") ||
		linkEl.querySelector(".slideflow-link-dirty-badge") !== null ||
		Boolean(linkEl.nextElementSibling?.classList.contains("slideflow-link-dirty-badge"))
	);
}

function isActionableLinkCandidate(
	linkEl: HTMLElement,
	blockEl: HTMLElement,
	contentEl?: HTMLElement | null
): boolean {
	if (!linkEl.isConnected) return false;
	if (
		linkEl.classList.contains("slideflow-link-already-open") ||
		linkEl.getAttribute("aria-disabled") === "true"
	) {
		return false;
	}
	if (linkEl.closest(".copy-code-button, .slideflow-selection-toolbar, .slideflow-comments-rail")) {
		return false;
	}

	let curr: HTMLElement | null = linkEl;
	while (curr) {
		const style = window.getComputedStyle(curr);
		if (style.display === "none" || style.visibility === "hidden") {
			return false;
		}
		if (curr === blockEl || (contentEl && curr === contentEl)) break;
		curr = curr.parentElement;
	}

	const rect = linkEl.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) {
		return false;
	}

	if (linkEl.classList.contains("internal-link")) {
		const href = (linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "").trim();
		return href.length > 0;
	}
	if (linkEl.classList.contains("slideflow-child-heading-linked-title")) {
		const href = (linkEl.getAttribute("data-link-href") || "").trim();
		return href.length > 0;
	}
	const href = (linkEl.getAttribute("href") || "").trim();
	return href.length > 0 && href !== "#" && !/^javascript:/i.test(href);
}

/**
 * Collects all visible actionable links inside a reading-focus block in DOM order,
 * preferring live (non-`<del>`) links when inline diff deletions coexist with active links.
 * Reused by both `Enter` preferred-link opening and `Tab` / `Shift+Tab` link cycling.
 */
export function collectActionableLinksInBlock(
	blockEl: HTMLElement,
	contentEl?: HTMLElement | null
): HTMLElement[] {
	if (!blockEl.isConnected) return [];

	const rawCandidates: HTMLElement[] = [];
	if (blockEl.matches(FOCUSED_BLOCK_LINK_SELECTOR)) {
		rawCandidates.push(blockEl);
	}
	rawCandidates.push(
		...Array.from(blockEl.querySelectorAll<HTMLElement>(FOCUSED_BLOCK_LINK_SELECTOR))
	);

	// Support standalone linked media (e.g. `[![alt](img.png)](url)`) where the focused block is the <img>
	if (rawCandidates.length === 0) {
		const enclosingLink = blockEl.closest<HTMLElement>(FOCUSED_BLOCK_LINK_SELECTOR);
		if (enclosingLink && (!contentEl || contentEl.contains(enclosingLink))) {
			rawCandidates.push(enclosingLink);
		}
	}

	const validLinks = rawCandidates.filter((el) =>
		isActionableLinkCandidate(el, blockEl, contentEl)
	);
	if (validLinks.length === 0) return [];

	const liveLinks = validLinks.filter((el) => !el.closest("del, .dv-del"));
	return liveLinks.length > 0 ? liveLinks : validLinks;
}

/**
 * Resolves the link to open when pressing `Enter` on a reading-focus block (without explicit Tab selection):
 * 1. First visible actionable link in the block that still carries a green unread-diff dot.
 * 2. Otherwise, the first visible actionable link present inside the block.
 */
export function findPreferredLinkInBlock(
	blockEl: HTMLElement,
	contentEl?: HTMLElement | null
): HTMLElement | null {
	const pool = collectActionableLinksInBlock(blockEl, contentEl);
	if (pool.length === 0) return null;
	return pool.find((el) => hasUnreadLinkDot(el)) ?? pool[0] ?? null;
}
