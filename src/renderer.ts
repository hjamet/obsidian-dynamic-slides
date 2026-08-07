import { App, Component, MarkdownRenderer } from "obsidian";

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
	return slideComponent;
}

export function unloadSlideContent(slideComponent: Component | null, parentComponent: Component) {
	if (slideComponent) {
		parentComponent.removeChild(slideComponent);
		slideComponent.unload();
	}
}
