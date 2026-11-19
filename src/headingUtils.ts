/**
 * headingUtils.ts — Clean display and HTML formatting for Markdown headings in SlideFlow.
 *
 * Properly resolves Obsidian wikilinks (`[[path|alias]]`, `[[path]]`), Markdown links
 * (`[label](url)`), and inline formatting (`code`, `bold`, `italic`) inside child-heading
 * containers, TOC entries, diff matching, and the review drawer.
 */

export function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function defaultDisplayForWikilinkTarget(target: string): string {
	const trimmed = target.trim();
	const hashIdx = trimmed.indexOf("#");
	const filePart = hashIdx >= 0 ? trimmed.slice(0, hashIdx).trim() : trimmed;
	const subPart = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).replace(/^\^/, "").trim() : "";

	const base = filePart
		? (filePart.split("/").pop() || filePart).replace(/\.md$/i, "")
		: "";

	if (base && subPart) return `${base} › ${subPart}`;
	return base || subPart || trimmed;
}

/**
 * Resolves `[[target|alias]]` -> `alias`, `[[target]]` -> clean basename, and `[label](url)` -> `label`,
 * returning plain human-readable text suitable for TOC items, breadcrumbs, and diff title normalization.
 */
export function stripHeadingLinksToPlainText(rawTitle: string): string {
	if (!rawTitle) return "";
	let out = rawTitle.replace(/!?\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
		const pipeIdx = inner.indexOf("|");
		if (pipeIdx >= 0) {
			const alias = inner.slice(pipeIdx + 1).trim();
			if (alias) return alias;
			return defaultDisplayForWikilinkTarget(inner.slice(0, pipeIdx));
		}
		return defaultDisplayForWikilinkTarget(inner);
	});
	out = out.replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1");
	// Strip basic inline Markdown wrappers for crisp plain text in TOC / labels
	out = out.replace(/`([^`]+)`/g, "$1");
	out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
	out = out.replace(/\*([^*]+)\*/g, "$1");
	return out.trim();
}

function formatInlineTextToSafeHtml(raw: string): string {
	const codeTokens: string[] = [];
	let masked = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
		const idx = codeTokens.length;
		codeTokens.push(`<code>${escapeHtml(code)}</code>`);
		return `@@SFCODE${idx}@@`;
	});

	let escaped = escapeHtml(masked);
	escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
	escaped = escaped.replace(/@@SFCODE(\d+)@@/g, (_m, idxStr: string) => {
		return codeTokens[parseInt(idxStr, 10)] ?? "";
	});
	return escaped;
}

/**
 * Formats a child heading's Markdown title into safe HTML for `.dynamic-slides-child-heading`.
 *
 * - For pure archived-link headings (`isPureLinkLeaf === true`, e.g. `### [[notes/Sub|Question ?]]`
 *   with no body underneath), renders a real `<a class="internal-link" data-href="...">alias</a>`
 *   so clicking opens the sub-note directly and modified-subnote green dots attach natively.
 * - For headings that have body content or sub-children underneath (e.g. an archived heading with
 *   an embedded chart), renders the clean alias inside `<span data-link-href="...">alias</span>`
 *   so clicking navigates to the child slide while still allowing the green modified-subnote dot.
 */
export function renderChildHeadingInnerHtml(rawTitle: string, isPureLinkLeaf: boolean): string {
	if (!rawTitle) return "";

	const tokenRe = /(!?\[\[([^\]]+)\]\])|(\[([^\]\n]+)\]\(([^)\n]+)\))/g;
	let result = "";
	let lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = tokenRe.exec(rawTitle)) !== null) {
		if (m.index > lastIndex) {
			result += formatInlineTextToSafeHtml(rawTitle.slice(lastIndex, m.index));
		}

		if (m[2] !== undefined) {
			const inner = m[2];
			const pipeIdx = inner.indexOf("|");
			const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
			const rawAlias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : "";
			const display = rawAlias || defaultDisplayForWikilinkTarget(target);
			const formattedDisplay = formatInlineTextToSafeHtml(display);

			if (isPureLinkLeaf) {
				result += `<a class="internal-link slideflow-child-heading-internal-link" data-href="${escapeHtml(target)}" href="${escapeHtml(target)}">${formattedDisplay}</a>`;
			} else {
				result += `<span class="slideflow-child-heading-linked-title" data-link-href="${escapeHtml(target)}">${formattedDisplay}</span>`;
			}
		} else if (m[4] !== undefined) {
			const label = m[4];
			const url = (m[5] || "").trim();
			const formattedLabel = formatInlineTextToSafeHtml(label);
			if (isPureLinkLeaf && url && !/^https?:\/\//i.test(url)) {
				result += `<a class="internal-link slideflow-child-heading-internal-link" data-href="${escapeHtml(url)}" href="${escapeHtml(url)}">${formattedLabel}</a>`;
			} else {
				result += formattedLabel;
			}
		}

		lastIndex = tokenRe.lastIndex;
	}

	if (lastIndex < rawTitle.length) {
		result += formatInlineTextToSafeHtml(rawTitle.slice(lastIndex));
	}

	return result;
}
