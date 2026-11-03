# Dynamic Section Slides for Obsidian

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](manifest.json)
[![Obsidian](https://img.shields.io/badge/Obsidian-v0.15.0%2B-purple.svg)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Dynamic Section Slides** turns any standard Markdown note in Obsidian into an interactive, full-screen presentation. It requires no special presentation delimiters (such as `---`), proprietary frontmatter, or slide-specific formatting. Instead, it parses your existing Markdown heading hierarchy (`#`, `##`, `###`, etc.) to generate dynamic slides with two-dimensional keyboard navigation, smooth intra-slide scrolling, full-screen media zooming, recursive sub-note drilldown, and a collapsible table of contents.

---

## Key Features

### 1. Automatic Heading-Based Slicing
- **Zero Proprietary Syntax**: Present your existing notes directly without altering their Markdown structure.
- **Hierarchical Section Tree**: Headings are parsed into parent and child nodes (`parser.ts`). Parent sections display their introductory content followed by interactive buttons for their child sections.
- **Notes Without Headings**: If a note does not contain any H1–H6 headings, the entire note is rendered as a clean single slide.

### 2. Intra-Slide Step Navigation ("Scroll-First, Zoom-Last")
- **Smooth Content Scrolling**: If slide content exceeds the viewport height, pressing the advance key smoothly scrolls through the content using symmetrical sinusoidal easing (`easeInOutSine`) before proceeding.
- **Sequential Media Zoom**: After text content has scrolled, the plugin automatically isolates and magnifies media elements (images, Mermaid diagrams, data tables, iframes, and code blocks) into a full-screen modal.
- **Media-Only Slides**: Slides containing only media (e.g. diagrams or figures without body text) immediately expand to full-screen view.

### 3. Sub-Note Drilldown & Document Stack
- **In-Presentation Note Traversal**: Clicking an internal link (`[[Note Title]]` or `[[Note Title#Section]]`) renders the target note inside the presentation modal without leaving presentation mode.
- **Breadcrumb Navigation**: A persistent document stack tracks your path across linked notes, displaying a top banner and return button to restore previous presentations (`↩ Back to original note`).
- **In-Slide Anchor Jumps**: Clicking `#Section` links or child section cards navigates directly to target sections with directional zoom animations.

### 4. Interactive Table of Contents (Hover TOC)
- **Collapsible Sidebar**: Hovering over the bottom-left corner of the screen reveals the Table of Contents toggle button (`☰ Table of contents`).
- **Live Tree Structure**: Displays the active document tree with folding indicators (`▼` / `▶`), auto-scrolls to the current slide, and highlights the active section.

### 5. Responsive Diagrams & Embeds
- **Mermaid Diagrams**: Automatically computes bounding boxes and responsive `viewBox` coordinates to scale diagrams cleanly inside presentations.
- **Embedded Web Content**: Supports responsive `iframe` embeds with fullscreen and playback permissions.
- **Dynamic Scale / Zoom**: Interactive bottom-right toolbar controls scale from 70% to 200%.

### 6. Editor Synchronization on Exit
- Exiting the presentation (`Escape`) automatically scrolls the active Obsidian editor and places the cursor on the exact line of the section being viewed.

---

## Keyboard Navigation

| Key | Action | Behavior |
|:---|:---|:---|
| `Right Arrow` / `Space` / `PageDown` | **Next Step / Slide** | Scrolls down if overflow exists; steps through media zoom; advances to next slide. |
| `Left Arrow` / `Shift + Space` / `PageUp` | **Previous Step / Slide** | Reverses through media zoom; scrolls up; returns to previous slide. |
| `Down Arrow` | **Fast Next Slide** | Skips intra-slide scroll and media zoom, jumping immediately to the next section. |
| `Up Arrow` | **Fast Previous Slide** | Skips intra-slide scroll and media zoom, jumping immediately to the previous section. |
| `+` / `=` / `NumPad +` | **Zoom In** | Increases slide font and display scale by +10% (up to 200%). |
| `-` / `_` / `NumPad -` | **Zoom Out** | Decreases slide font and display scale by -10% (down to 70%). |
| `0` / `NumPad 0` | **Reset Zoom** | Resets presentation scale to 100%. |
| `Escape` | **Close Presentation** | Exits full-screen mode and focuses the active editor at the current section line. |

---

## Configuration Settings

Settings can be adjusted in **Settings → Community Plugins → Dynamic Section Slides**:

- **Transition Animation Duration**: Adjusts slide animation speed between 0.2s and 1.5s (default: `0.65s`).
- **Smooth Scroll Duration**: Controls the duration of intra-slide vertical scrolling animations between 0.5s and 4.0s (default: `1.0s`).
- **Default Zoom Level**: Sets default presentation scale between 70% and 200% (default: `100%`).

---

## How to Use

1. Open any Markdown note in Obsidian.
2. Launch the presentation via any of the following:
   - Click the **Dynamic Section Slides** icon in the ribbon (presentation icon).
   - Press the default hotkey: `Ctrl + Shift + P` (Windows/Linux) or `Cmd + Shift + P` (macOS).
   - Open the Command Palette (`Ctrl + P` / `Cmd + P`) and select **Start Dynamic Section Slides presentation**.
3. Navigate through your sections using the keyboard or interactive TOC.
4. Press `Escape` to close and return to your note.

---

## Development & Build

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher)
- npm

### Installation & Compilation
```bash
# Clone repository
git clone https://github.com/hjamet/obsidian-dynamic-slides.git
cd obsidian-dynamic-slides

# Install dependencies
npm install

# Build production bundle (main.js)
npm run build

# Watch mode for active development
npm run dev
```

### Manual Installation in Obsidian
1. Build the project (`npm run build`).
2. Copy `manifest.json`, `main.js`, and `styles.css` into your Obsidian vault:
   `<VaultFolder>/.obsidian/plugins/dynamic-section-slides/`
3. Reload Obsidian and enable **Dynamic Section Slides** under **Settings → Community Plugins**.

---

## Architecture Overview

- `src/main.ts`: Plugin lifecycle, command registration, settings management, document stack traversal, and editor line synchronization.
- `src/parser.ts`: Markdown heading tree parser, section node hierarchy construction, and cursor line locator.
- `src/modal.ts`: Presentation overlay DOM, step state machine (scroll / zoom / advance), and bottom toolbars.
- `src/renderer.ts`: Markdown rendering bridge with Mermaid SVG `viewBox` calculations and `iframe` styling.
- `src/keyboard.ts`: Key event capture and navigation dispatcher.
- `src/toc.ts`: Collapsible sidebar table of contents and active node indicator.
- `styles.css`: CSS animations (`slideAnimNext`, `slideAnimPrev`, `slideAnimZoomIn`, `slideAnimZoomOut`), responsive layouts, and modal themes.

---

## License

This project is licensed under the [MIT License](LICENSE).
Author: [Henri Jamet](https://github.com/hjamet).
