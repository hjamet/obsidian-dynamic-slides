import { Plugin, Notice, MarkdownView, PluginSettingTab, Setting, App, TFile } from "obsidian";
import { parseMarkdownSections, findCurrentSectionNode, SectionNode } from "./parser";
import { PresentationModal } from "./modal";
import { KeyboardNavigator } from "./keyboard";
import { TOCComponent } from "./toc";

export interface DynamicSlidesSettings {
	transitionDuration: number; // in seconds
	scrollDuration: number;
}

export interface DocumentStackFrame {
	filePath: string;
	fileTitle: string;
	currentNode: SectionNode;
	flatNodes: SectionNode[];
	rootNode: SectionNode;
}

export const DEFAULT_SETTINGS: DynamicSlidesSettings = {
	transitionDuration: 0.65,
	scrollDuration: 1.0
};

export function computeDirection(
	oldNode: SectionNode | null,
	newNode: SectionNode
): 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump' {
	if (!oldNode || oldNode.id === newNode.id) {
		return 'jump';
	}
	if (newNode.level > oldNode.level) {
		return 'zoom-in';
	}
	if (newNode.level < oldNode.level) {
		return 'zoom-out';
	}
	if ((newNode.flatIndex ?? 0) > (oldNode.flatIndex ?? 0)) {
		return 'next';
	}
	return 'prev';
}

export default class DynamicSlidesPlugin extends Plugin {
	settings: DynamicSlidesSettings = DEFAULT_SETTINGS;
	private activeModal: PresentationModal | null = null;
	private keyboardNav: KeyboardNavigator | null = null;
	private tocComp: TOCComponent | null = null;

	private rootNode: SectionNode | null = null;
	private flatNodes: SectionNode[] = [];
	private currentNode: SectionNode | null = null;
	private activeSourcePath: string = "";
	private documentStack: DocumentStackFrame[] = [];

	async onload() {
		console.log("Loading Dynamic Section Slides plugin");
		await this.loadSettings();

		this.addSettingTab(new DynamicSlidesSettingTab(this.app, this));

		this.addRibbonIcon("presentation", "Dynamic Section Slides", () => {
			this.startPresentation();
		});

		this.addCommand({
			id: "start-dynamic-slides",
			name: "Start Dynamic Section Slides presentation",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "p" }],
			callback: () => {
				this.startPresentation();
			}
		});
	}

	onunload() {
		this.closePresentation();
		console.log("Unloading Dynamic Section Slides plugin");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private startPresentation() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Aucune note Markdown active pour la présentation.");
			return;
		}

		const file = view.file;
		if (!file) {
			new Notice("Fichier introuvable.");
			return;
		}

		const markdownText = view.editor.getValue();
		if (!markdownText.trim()) {
			new Notice("Note vide : impossible de démarrer la présentation.");
			return;
		}

		this.documentStack = [];

		this.activeSourcePath = file.path;
		const cache = this.app.metadataCache.getFileCache(file);
		const parsed = parseMarkdownSections(markdownText, cache?.headings);

		if (parsed.error === "no_headings") {
			new Notice("Note sans en-tête H1-H6 : affichage de la note complète en slide unique.");
		}

		this.rootNode = parsed.root;
		this.flatNodes = parsed.flatNodes;

		// Toujours démarrer systématiquement à la slide 1 (première vraie section de contenu),
		// jamais à la slide 0 (vue d'ensemble) ni à la position du curseur / précédente.
		if (this.flatNodes.length > 1) {
			this.currentNode = this.flatNodes[1];
		} else {
			this.currentNode = this.flatNodes[0];
		}

		this.activeModal = new PresentationModal(
			this.app,
			() => {
				this.cleanupNavigation();
			},
			this.settings.transitionDuration,
			this.settings.scrollDuration * 1000
		);
		this.activeModal.setScrollDuration(this.settings.scrollDuration * 1000);

		this.activeModal.setReturnButton(null);
		this.activeModal.onReturnClickCallback = () => {
			this.popDocumentStack();
		};
		this.activeModal.onLinkClickCallback = (href: string) => {
			void this.handleInternalLinkClick(href);
		};

		this.activeModal.open(this.currentNode, this.activeSourcePath);

		this.tocComp = new TOCComponent(this.activeModal.getOverlayElement(), (selectedNode) => {
			this.goToNode(selectedNode);
		});
		this.activeModal.setTOC(this.tocComp);
		this.tocComp.update(this.currentNode, this.flatNodes);

		this.updateSlideCounter();

		this.keyboardNav = new KeyboardNavigator({
			onNext: () => this.handleNextNavigation(),
			onPrev: () => this.handlePrevNavigation(),
			onFastNext: () => this.fastJumpNext(),
			onFastPrev: () => this.fastJumpPrev(),
			onClose: () => this.closePresentation()
		});
		this.keyboardNav.attach();
	}

	private updateSlideCounter() {
		if (!this.activeModal || !this.currentNode) return;
		const total = this.flatNodes.length > 1 ? this.flatNodes.length - 1 : 1;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		const current = this.flatNodes.length > 1 ? idx : 1;
		this.activeModal.setCounter(current, total);
	}

	private handleNextNavigation() {
		if (this.activeModal) {
			const handled = this.activeModal.handleNext();
			if (!handled) {
				this.nextSlide();
			}
		} else {
			this.nextSlide();
		}
	}

	private handlePrevNavigation() {
		if (this.activeModal) {
			const handled = this.activeModal.handlePrev();
			if (!handled) {
				this.prevSlide();
			}
		} else {
			this.prevSlide();
		}
	}

	private fastJumpNext() {
		if (this.activeModal) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
		}
		this.nextSlide();
	}

	private fastJumpPrev() {
		if (this.activeModal) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
		}
		this.prevSlide('start');
	}

	private async handleInternalLinkClick(linkpath: string) {
		const cleanPath = linkpath.split('#')[0].split('^')[0].trim();
		let targetFile = this.app.metadataCache.getFirstLinkpathDest(cleanPath, this.activeSourcePath);
		if (!targetFile) {
			targetFile = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.activeSourcePath);
		}
		if (!targetFile) {
			const allFiles = this.app.vault.getMarkdownFiles();
			targetFile = allFiles.find(f => f.basename.toLowerCase() === cleanPath.toLowerCase() || f.name.toLowerCase() === cleanPath.toLowerCase()) || null;
		}

		if (targetFile && targetFile instanceof TFile) {
			const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourcePath);
			const activeFileBasename = (currentFile instanceof TFile) ? currentFile.basename : (this.activeSourcePath.split('/').pop()?.replace(/\.md$/, '') || "Note principale");

			if (this.currentNode && this.rootNode) {
				this.documentStack.push({
					filePath: this.activeSourcePath,
					fileTitle: activeFileBasename,
					currentNode: this.currentNode,
					flatNodes: this.flatNodes,
					rootNode: this.rootNode
				});
			}

			const markdownText = await this.app.vault.read(targetFile);
			const cache = this.app.metadataCache.getFileCache(targetFile);
			const parsed = parseMarkdownSections(markdownText, cache?.headings);

			this.activeSourcePath = targetFile.path;
			this.rootNode = parsed.root;
			this.flatNodes = parsed.flatNodes;
			this.currentNode = this.flatNodes.length > 1 ? this.flatNodes[1] : this.flatNodes[0];

			if (this.activeModal && this.currentNode) {
				this.activeModal.closeMediaZoom(false);
				this.activeModal.cancelScrollAnimation(false);
				this.activeModal.updateSlide(this.currentNode, this.activeSourcePath, 'zoom-in', 'start');
				this.activeModal.setReturnButton(activeFileBasename);
				this.updateSlideCounter();
			}

			if (this.tocComp && this.currentNode) {
				this.tocComp.update(this.currentNode, this.flatNodes);
			}

			new Notice(`Présentation de la note : ${targetFile.basename}`);
		} else {
			new Notice(`Fichier introuvable pour le lien : ${linkpath}`);
		}
	}

	private popDocumentStack() {
		if (this.documentStack.length === 0) return;
		const parentFrame = this.documentStack.pop()!;
		this.activeSourcePath = parentFrame.filePath;
		this.flatNodes = parentFrame.flatNodes;
		this.rootNode = parentFrame.rootNode;
		this.currentNode = parentFrame.currentNode;

		if (this.activeModal && this.currentNode) {
			this.activeModal.closeMediaZoom(false);
			this.activeModal.cancelScrollAnimation(false);
			this.activeModal.updateSlide(this.currentNode, this.activeSourcePath, 'zoom-out', 'start');
			const prevParent = this.documentStack[this.documentStack.length - 1];
			this.activeModal.setReturnButton(prevParent ? prevParent.fileTitle : null);
			this.updateSlideCounter();
		}

		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes);
		}

		new Notice(`Retour à la note : ${parentFrame.fileTitle}`);
	}

	private goToNode(
		node: SectionNode,
		overrideDirection?: 'next' | 'prev' | 'zoom-in' | 'zoom-out' | 'jump',
		enterFrom: 'start' | 'end' = 'start'
	) {
		const direction = overrideDirection ?? computeDirection(this.currentNode, node);
		this.currentNode = node;
		if (this.activeModal && this.currentNode) {
			this.activeModal.updateSlide(this.currentNode, this.activeSourcePath, direction, enterFrom);
			this.updateSlideCounter();
		}
		if (this.tocComp && this.currentNode) {
			this.tocComp.update(this.currentNode, this.flatNodes);
		}
	}

	private nextSlide() {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx === -1 && this.flatNodes.length > 0) {
			this.goToNode(this.flatNodes[0], 'next', 'start');
			return;
		}
		if (idx >= 0 && idx < this.flatNodes.length - 1) {
			this.goToNode(this.flatNodes[idx + 1], 'next', 'start');
		} else if (idx === this.flatNodes.length - 1) {
			new Notice("Fin de la présentation atteinte.");
		}
	}

	private prevSlide(enterFrom: 'start' | 'end' = 'end') {
		if (!this.currentNode) return;
		const idx = this.flatNodes.findIndex(n => n.id === this.currentNode?.id);
		if (idx > 1) {
			this.goToNode(this.flatNodes[idx - 1], 'prev', enterFrom);
		} else if (idx === 1 || idx === 0) {
			if (this.documentStack.length > 0) {
				this.popDocumentStack();
			} else {
				new Notice("Début de la présentation atteint.");
			}
		}
	}

	private expandParent() {
		if (!this.currentNode || !this.currentNode.parent) {
			if (this.documentStack.length > 0) {
				this.popDocumentStack();
				return;
			} else {
				new Notice("Niveau supérieur racine atteint.");
				return;
			}
		}
		this.goToNode(this.currentNode.parent, 'zoom-out', 'start');
	}

	private reduceChild() {
		if (!this.currentNode || this.currentNode.children.length === 0) {
			new Notice("Niveau le plus fin atteint.");
			return;
		}
		this.goToNode(this.currentNode.children[0], 'zoom-in', 'start');
	}

	private closePresentation() {
		if (this.activeModal) {
			this.activeModal.close();
			this.activeModal = null;
		}
		this.cleanupNavigation();
	}

	private cleanupNavigation() {
		if (this.keyboardNav) {
			this.keyboardNav.detach();
			this.keyboardNav = null;
		}
		if (this.tocComp) {
			this.tocComp.destroy();
			this.tocComp = null;
		}
	}
}

export class DynamicSlidesSettingTab extends PluginSettingTab {
	plugin: DynamicSlidesPlugin;

	constructor(app: App, plugin: DynamicSlidesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const setting = new Setting(containerEl)
			.setName("Durée des animations de transition")
			.setDesc(`Durée actuelle : ${this.plugin.settings.transitionDuration}s`)
			.addSlider(slider =>
				slider
					.setLimits(0.2, 1.5, 0.05)
					.setValue(this.plugin.settings.transitionDuration)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const roundedValue = Math.round(value * 100) / 100;
						this.plugin.settings.transitionDuration = roundedValue;
						await this.plugin.saveSettings();
						setting.setDesc(`Durée actuelle : ${roundedValue}s`);
					})
			);

		new Setting(containerEl)
			.setName("Durée du défilement fluide")
			.setDesc("Ajuste la durée (en secondes) de l'animation de défilement vertical du texte de slide.")
			.addSlider(slider =>
				slider
					.setLimits(0.5, 4.0, 0.1)
					.setValue(this.plugin.settings.scrollDuration)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const roundedValue = Math.round(value * 10) / 10;
						this.plugin.settings.scrollDuration = roundedValue;
						await this.plugin.saveSettings();
					})
			);
	}
}
