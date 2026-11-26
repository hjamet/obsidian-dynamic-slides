import { App, Component, MarkdownRenderer } from "obsidian";

export function enhanceSvgDimensions(svg: SVGSVGElement) {
	if (!svg) return;

	// Do NOT enhance callout icons, UI icons, or emoji
	if (
		svg.closest(".callout-icon") ||
		svg.closest(".callout") ||
		svg.closest(".dynamic-slides-toc-fold-icon") ||
		svg.closest(".dynamic-slides-subnote-banner") ||
		svg.classList.contains("callout-icon") ||
		svg.classList.contains("svg-icon") ||
		svg.classList.contains("emoji")
	) {
		return;
	}

	// Check if viewBox is missing, empty, or zeroed
	let viewBox = svg.getAttribute("viewBox");
	let hasValidViewBox = false;
	if (viewBox && viewBox.trim() !== "") {
		const parts = viewBox.trim().split(/[\s,]+/).map(p => parseFloat(p));
		if (parts.length === 4 && !isNaN(parts[2]) && !isNaN(parts[3]) && parts[2] > 0 && parts[3] > 0) {
			hasValidViewBox = true;
		}
	}

	if (!hasValidViewBox) {
		const widthAttr = svg.getAttribute("width");
		const heightAttr = svg.getAttribute("height");
		let w = widthAttr ? parseFloat(widthAttr) : 0;
		let h = heightAttr ? parseFloat(heightAttr) : 0;

		if (!w || !h || isNaN(w) || isNaN(h)) {
			try {
				const bbox = svg.getBBox();
				if (bbox.width > 0 && bbox.height > 0) {
					w = bbox.width;
					h = bbox.height;
					if (bbox.x !== undefined && bbox.y !== undefined) {
						svg.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
						hasValidViewBox = true;
					}
				}
			} catch (e) {
				const rect = svg.getBoundingClientRect();
				w = rect.width;
				h = rect.height;
			}
		}

		if (!hasValidViewBox && w > 0 && h > 0) {
			svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
			hasValidViewBox = true;
		}
	}

	// Ensure preserveAspectRatio is set for uniform responsive scaling
	svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

	// Remove constraining pixel width/height attributes so viewBox controls scaling
	svg.removeAttribute("width");
	svg.removeAttribute("height");

	// Override constraining inline styles set by Mermaid or Obsidian
	svg.style.setProperty("max-width", "100%", "important");
	svg.style.setProperty("max-height", "100%", "important");
	svg.style.setProperty("width", "100%", "important");
	svg.style.setProperty("height", "100%", "important");
	svg.style.setProperty("display", "block", "important");
	svg.style.setProperty("margin", "auto", "important");

	// Clean up internal <style> tags inside the SVG that restrict max-width or width
	const styleTags = svg.querySelectorAll("style");
	styleTags.forEach((styleTag) => {
		if (styleTag.textContent) {
			styleTag.textContent = styleTag.textContent.replace(
				/max-width\s*:\s*[^;!]+(!important)?;/gi,
				"max-width: 100% !important;"
			);
		}
	});
}

export function enhanceMermaidSvgElements(containerEl: HTMLElement) {
	if (!containerEl) return;

	// Is this a dedicated zoom mermaid container?
	const isZoomMermaid = containerEl.classList.contains("dynamic-slides-zoom-mermaid") ||
		containerEl.closest(".dynamic-slides-zoom-mermaid") !== null;

	if (isZoomMermaid) {
		const wrappers = containerEl.querySelectorAll<HTMLElement>(
			".mermaid, [class*='mermaid'], [class*='language-mermaid'], [class*='block-language-mermaid'], pre, div"
		);
		wrappers.forEach((wrapper) => {
			if (wrapper.closest(".callout")) return;
			wrapper.style.setProperty("width", "100%", "important");
			wrapper.style.setProperty("max-width", "100%", "important");
			wrapper.style.setProperty("height", "100%", "important");
			wrapper.style.setProperty("max-height", "100%", "important");
			wrapper.style.setProperty("display", "flex", "important");
			wrapper.style.setProperty("justify-content", "center", "important");
			wrapper.style.setProperty("align-items", "center", "important");
			wrapper.style.setProperty("margin", "0", "important");
			wrapper.style.setProperty("padding", "0", "important");
			wrapper.style.setProperty("background", "transparent", "important");
		});

		containerEl.querySelectorAll<SVGSVGElement>("svg").forEach((svg) => {
			enhanceSvgDimensions(svg);
		});
		return;
	}

	// Normal slide content: ONLY target mermaid containers!
	const mermaidContainers = containerEl.querySelectorAll<HTMLElement>(
		".mermaid, svg.mermaid, .block-language-mermaid, div[class*='block-language-mermaid'], [class*='language-mermaid']"
	);

	mermaidContainers.forEach((container) => {
		if (container.closest(".callout")) return;
		container.style.setProperty("width", "100%", "important");
		container.style.setProperty("max-width", "100%", "important");

		const svgs = container.tagName.toLowerCase() === "svg"
			? [container as unknown as SVGSVGElement]
			: Array.from(container.querySelectorAll<SVGSVGElement>("svg"));

		svgs.forEach((svg) => {
			enhanceSvgDimensions(svg);
		});
	});
}

export function enhanceIframeElements(containerEl: HTMLElement) {
	const iframes = containerEl.querySelectorAll<HTMLIFrameElement>("iframe");
	iframes.forEach((iframe) => {
		iframe.setAttribute("allowfullscreen", "true");
		if (!iframe.getAttribute("allow")) {
			iframe.setAttribute("allow", "fullscreen; autoplay; encrypted-media; picture-in-picture");
		}
		const parentP = iframe.closest("p");
		if (parentP && parentP.children.length === 1 && parentP.textContent?.trim() === "") {
			parentP.style.margin = "0";
			parentP.style.padding = "0";
			parentP.style.width = "100%";
			parentP.style.display = "flex";
			parentP.style.justifyContent = "center";
		}
	});
}

interface ExtractedDetailsBlock {
	isOpen: boolean;
	summaryMd: string;
	bodyMd: string;
}

/**
 * Extracts balanced HTML `<details>...</details>` blocks outside fenced code blocks
 * so Obsidian's CommonMark parser never splits them at inner blank lines (which would
 * otherwise render an empty `<details>` followed by orphaned content outside).
 */
export function extractDetailsBlocks(markdown: string): {
	transformed: string;
	blocks: ExtractedDetailsBlock[];
} {
	const normalized = markdown.replace(/\r\n/g, "\n");
	if (!/<details(?:\s[^>]*)?>/i.test(normalized)) {
		return { transformed: normalized, blocks: [] };
	}

	const lines = normalized.split("\n");
	const outLines: string[] = [];
	const blocks: ExtractedDetailsBlock[] = [];

	let openFenceChar: string | null = null;
	let openFenceLen = 0;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const ch = marker[0];
			if (!openFenceChar) {
				if (!(ch === "`" && fenceMatch[2].includes("`"))) {
					openFenceChar = ch;
					openFenceLen = marker.length;
				}
			} else if (
				ch === openFenceChar &&
				marker.length >= openFenceLen &&
				/^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)
			) {
				openFenceChar = null;
				openFenceLen = 0;
			}
			outLines.push(line);
			i++;
			continue;
		}

		if (openFenceChar) {
			outLines.push(line);
			i++;
			continue;
		}

		const openTagMatch = line.match(/^\s*<details(\s[^>]*)?>/i);
		if (!openTagMatch) {
			outLines.push(line);
			i++;
			continue;
		}

		// Collect lines until balanced `</details>` (ignoring any tags inside nested code fences)
		const attrs = openTagMatch[1] || "";
		const isOpen = /\bopen\b/i.test(attrs);
		const blockLines: string[] = [];
		let depth = 0;
		let innerFenceChar: string | null = null;
		let innerFenceLen = 0;
		let closed = false;
		let trailingAfterClose = "";

		let j = i;
		while (j < lines.length) {
			const curLine = lines[j];
			const innerFenceMatch = curLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
			if (innerFenceMatch) {
				const marker = innerFenceMatch[1];
				const ch = marker[0];
				if (!innerFenceChar) {
					if (!(ch === "`" && innerFenceMatch[2].includes("`"))) {
						innerFenceChar = ch;
						innerFenceLen = marker.length;
					}
				} else if (
					ch === innerFenceChar &&
					marker.length >= innerFenceLen &&
					/^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(curLine)
				) {
					innerFenceChar = null;
					innerFenceLen = 0;
				}
				blockLines.push(curLine);
				j++;
				continue;
			}

			if (innerFenceChar) {
				blockLines.push(curLine);
				j++;
				continue;
			}

			// Scan `<details...>` and `</details>` tags on this line in document order
			const tagRe = /<(\/?)details(?:\s[^>]*)?>/gi;
			let m: RegExpExecArray | null;
			let closeEndOffset = -1;
			while ((m = tagRe.exec(curLine)) !== null) {
				if (m[1] === "/") {
					depth--;
					if (depth === 0) {
						closeEndOffset = m.index + m[0].length;
						break;
					}
				} else {
					depth++;
				}
			}

			if (closeEndOffset !== -1) {
				blockLines.push(curLine.slice(0, closeEndOffset));
				trailingAfterClose = curLine.slice(closeEndOffset);
				closed = true;
				j++;
				break;
			}

			blockLines.push(curLine);
			j++;
		}

		if (!closed) {
			// Unclosed `<details>`: leave untouched so we never swallow the rest of the document
			outLines.push(line);
			i++;
			continue;
		}

		const fullHtml = blockLines.join("\n").trim();
		const innerRaw = fullHtml
			.replace(/^<details(?:\s[^>]*)?>/i, "")
			.replace(/<\/details>\s*$/i, "");

		let summaryMd = "Details";
		let bodyMd = innerRaw.trim();
		const summaryMatch = innerRaw.match(/^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i);
		if (summaryMatch) {
			summaryMd = summaryMatch[1].trim() || "Details";
			bodyMd = innerRaw.slice(summaryMatch[0].length).trim();
		}

		const idx = blocks.length;
		blocks.push({ isOpen, summaryMd, bodyMd });
		outLines.push("");
		outLines.push(`<div class="slideflow-details-placeholder" data-sf-details-idx="${idx}"></div>`);
		if (trailingAfterClose.trim().length > 0) {
			outLines.push(trailingAfterClose);
		}
		outLines.push("");
		i = j;
	}

	return { transformed: outLines.join("\n"), blocks };
}

async function renderMarkdownWithDetails(
	app: App,
	markdown: string,
	containerEl: HTMLElement,
	sourcePath: string,
	slideComponent: Component
): Promise<void> {
	const { transformed, blocks } = extractDetailsBlocks(markdown);
	await MarkdownRenderer.render(app, transformed, containerEl, sourcePath, slideComponent);

	if (blocks.length === 0) return;

	const placeholders = Array.from(
		containerEl.querySelectorAll<HTMLElement>(".slideflow-details-placeholder[data-sf-details-idx]")
	);

	for (const placeholder of placeholders) {
		const idxAttr = placeholder.getAttribute("data-sf-details-idx");
		const idx = idxAttr !== null ? parseInt(idxAttr, 10) : -1;
		const block = blocks[idx];
		if (!block) continue;

		const detailsEl = document.createElement("details");
		detailsEl.className = "slideflow-details";
		if (block.isOpen) {
			detailsEl.open = true;
		}

		const summaryEl = document.createElement("summary");
		summaryEl.className = "slideflow-details-summary";

		const chevronEl = document.createElement("span");
		chevronEl.className = "slideflow-details-chevron";
		chevronEl.setAttribute("aria-hidden", "true");
		chevronEl.textContent = "▸";
		summaryEl.appendChild(chevronEl);

		const titleEl = document.createElement("span");
		titleEl.className = "slideflow-details-title";
		await MarkdownRenderer.render(app, block.summaryMd, titleEl, sourcePath, slideComponent);
		// Unwrap single-paragraph Markdown wrapper so summary stays inline with the chevron
		if (titleEl.children.length === 1 && titleEl.firstElementChild?.tagName.toLowerCase() === "p") {
			const p = titleEl.firstElementChild;
			while (p.firstChild) {
				titleEl.insertBefore(p.firstChild, p);
			}
			p.remove();
		}
		summaryEl.appendChild(titleEl);
		detailsEl.appendChild(summaryEl);

		const bodyEl = document.createElement("div");
		bodyEl.className = "slideflow-details-body";
		if (block.bodyMd.length > 0) {
			await renderMarkdownWithDetails(app, block.bodyMd, bodyEl, sourcePath, slideComponent);
		}
		detailsEl.appendChild(bodyEl);

		// Add a convenient 1-click Copy button when the collapsible holds a copyable code/text block
		const copyableCodeEl = bodyEl.querySelector<HTMLElement>("pre code, pre");
		if (copyableCodeEl) {
			const copyBtn = document.createElement("button");
			copyBtn.type = "button";
			copyBtn.className = "slideflow-details-copy-btn";
			copyBtn.textContent = "Copy";
			copyBtn.setAttribute("title", "Copy text to clipboard");
			copyBtn.setAttribute("aria-label", "Copy text to clipboard");
			copyBtn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				const textToCopy = (copyableCodeEl.textContent || "").replace(/\n$/, "");
				if (!textToCopy) return;
				void navigator.clipboard.writeText(textToCopy).then(() => {
					copyBtn.textContent = "Copied ✓";
					copyBtn.classList.add("is-copied");
					window.setTimeout(() => {
						copyBtn.textContent = "Copy";
						copyBtn.classList.remove("is-copied");
					}, 1600);
				});
			});
			summaryEl.appendChild(copyBtn);
		}

		placeholder.replaceWith(detailsEl);
	}
}

export async function renderSlideContent(
	app: App,
	markdown: string,
	containerEl: HTMLElement,
	sourcePath: string,
	parentComponent: Component
): Promise<Component> {
	containerEl.empty();
	const slideComponent = new Component();
	parentComponent.addChild(slideComponent);
	await renderMarkdownWithDetails(app, markdown, containerEl, sourcePath, slideComponent);
	enhanceMermaidSvgElements(containerEl);
	enhanceIframeElements(containerEl);
	return slideComponent;
}

export function unloadSlideContent(slideComponent: Component | null, parentComponent: Component) {
	if (slideComponent) {
		parentComponent.removeChild(slideComponent);
		slideComponent.unload();
	}
}
