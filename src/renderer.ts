import { App, Component, MarkdownRenderer } from "obsidian";

export function enhanceSvgDimensions(svg: SVGSVGElement) {
	if (!svg) return;

	// Check if viewBox is missing or empty
	let viewBox = svg.getAttribute("viewBox");
	if (!viewBox || viewBox.trim() === "") {
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
				}
			} catch (e) {
				const rect = svg.getBoundingClientRect();
				w = rect.width;
				h = rect.height;
			}
		}

		if (w > 0 && h > 0) {
			svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		}
	}

	// Ensure preserveAspectRatio is set for uniform responsive scaling
	if (!svg.getAttribute("preserveAspectRatio")) {
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
	}

	// Override constraining inline styles set by Mermaid or Obsidian
	svg.style.maxWidth = "100%";
	svg.style.maxHeight = "100%";
	svg.style.width = "100%";
	svg.style.height = "100%";
}

export function enhanceMermaidSvgElements(containerEl: HTMLElement) {
	const mermaidContainers = containerEl.querySelectorAll<HTMLElement>(
		".mermaid, svg.mermaid, .block-language-mermaid, div[class*='block-language-mermaid']"
	);

	mermaidContainers.forEach((container) => {
		container.style.width = "100%";
		container.style.maxWidth = "100%";

		const svgs = container.tagName.toLowerCase() === "svg"
			? [container as unknown as SVGSVGElement]
			: Array.from(container.querySelectorAll<SVGSVGElement>("svg"));

		svgs.forEach((svg) => {
			enhanceSvgDimensions(svg);
		});
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
	return slideComponent;
}

export function unloadSlideContent(slideComponent: Component | null, parentComponent: Component) {
	if (slideComponent) {
		parentComponent.removeChild(slideComponent);
		slideComponent.unload();
	}
}
