import { SectionNode } from "./parser";

function isAncestorOf(ancestor: SectionNode, target: SectionNode): boolean {
	let curr: SectionNode | null = target.parent;
	while (curr) {
		if (curr.id === ancestor.id) {
			return true;
		}
		curr = curr.parent;
	}
	return false;
}

function shouldExpandChildren(node: SectionNode, activeNode: SectionNode): boolean {
	if (node.id === activeNode.id) return true;
	if (isAncestorOf(node, activeNode)) return true;
	if (node.parent && node.parent.id === activeNode.id) return true;
	return false;
}

export class TOCComponent {
	private containerEl: HTMLElement;
	private treeScrollEl: HTMLElement;
	private toggleBtnEl: HTMLElement | null = null;
	private onSelectCallback: (node: SectionNode) => void;

	constructor(parentContainer: HTMLElement, onSelectNode: (node: SectionNode) => void) {
		this.onSelectCallback = onSelectNode;

		if (parentContainer.tagName.toLowerCase() === "aside" && parentContainer.hasClass("dynamic-slides-sidebar-toc")) {
			this.containerEl = parentContainer;
		} else {
			this.containerEl = document.createElement("aside");
			this.containerEl.addClass("dynamic-slides-sidebar-toc");
			if (parentContainer.firstChild) {
				parentContainer.insertBefore(this.containerEl, parentContainer.firstChild);
			} else {
				parentContainer.appendChild(this.containerEl);
			}
		}

		this.treeScrollEl = this.containerEl.createDiv({ cls: "dynamic-slides-toc-tree-scroll" });
	}

	public setToggleBtn(btn: HTMLElement): void {
		this.toggleBtnEl = btn;
		this.updateToggleBtnText();
	}

	public updateToggleBtnText(): void {
		if (this.toggleBtnEl) {
			if (this.isCollapsed()) {
				this.toggleBtnEl.setText("☰ Table des matières");
			} else {
				this.toggleBtnEl.setText("◀ TOC");
			}
		}
	}

	public toggleSidebar(open?: boolean): void {
		if (open === undefined) {
			this.containerEl.toggleClass("is-collapsed", !this.isCollapsed());
		} else {
			this.containerEl.toggleClass("is-collapsed", !open);
		}
		this.updateToggleBtnText();
	}

	public isCollapsed(): boolean {
		return this.containerEl.hasClass("is-collapsed");
	}

	private scrollToActive(): void {
		requestAnimationFrame(() => {
			const activeItemEl = this.treeScrollEl.querySelector(".is-active") as HTMLElement;
			if (activeItemEl) {
				activeItemEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		});
	}

	public update(currentNode: SectionNode, flatNodes: SectionNode[]): void {
		this.treeScrollEl.empty();
		const rootNode = flatNodes[0] || this.getRootNode(currentNode);
		const treeUl = this.treeScrollEl.createEl("ul", { cls: "dynamic-slides-toc-tree" });
		this.renderNode(rootNode, treeUl, currentNode);
		this.scrollToActive();
	}

	private getRootNode(node: SectionNode): SectionNode {
		let curr = node;
		while (curr.parent) {
			curr = curr.parent;
		}
		return curr;
	}

	private renderNode(node: SectionNode, containerUl: HTMLElement, activeNode: SectionNode): void {
		const li = containerUl.createEl("li", { cls: "dynamic-slides-toc-node" });
		const isCurrent = node.id === activeNode.id;
		const hasChildren = node.children && node.children.length > 0;
		const isExpanded = hasChildren && shouldExpandChildren(node, activeNode);

		const itemEl = li.createDiv({
			cls: `dynamic-slides-toc-item level-${node.level} ${isCurrent ? "is-active" : ""}`
		});

		itemEl.createEl("span", {
			cls: `dynamic-slides-toc-fold-icon ${hasChildren ? "" : "empty"}`,
			text: hasChildren ? (isExpanded ? "▼" : "▶") : ""
		});

		itemEl.createEl("span", {
			cls: "dynamic-slides-toc-title",
			text: node.title
		});

		itemEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.onSelectCallback(node);
		});

		if (hasChildren) {
			const childrenUl = li.createEl("ul", { cls: "dynamic-slides-toc-children" });
			childrenUl.style.display = isExpanded ? "block" : "none";
			for (const child of node.children) {
				this.renderNode(child, childrenUl, activeNode);
			}
		}
	}

	public destroy(): void {
		this.containerEl.remove();
	}
}


