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
	await MarkdownRenderer.render(app, markdown, containerEl, sourcePath, slideComponent);
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
