/**
 * commentImages.ts — Temporary non-synced image storage for SlideFlow comment attachments.
 *
 * Stores pasted or attached images strictly inside `os.tmpdir()/slideflow-comment-images/`
 * (outside the Obsidian vault so Obsidian Sync never syncs temporary review screenshots),
 * while providing exact absolute paths for `agy` CLI calls and XML clipboard exports.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CommentImageAttachment {
	id: string;
	path: string;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
}

const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/bmp": ".bmp",
	"image/svg+xml": ".svg",
};

const EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
};

export function getCommentImagesTempDir(): string {
	return path.join(os.tmpdir(), "slideflow-comment-images");
}

export function ensureCommentImagesTempDir(): string {
	const dir = getCommentImagesTempDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export function inferMimeTypeFromPath(filePath: string, fallback: string = "image/png"): string {
	const ext = path.extname(filePath || "").toLowerCase();
	return EXT_TO_MIME[ext] || fallback;
}

function formatTimestampTag(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

export async function saveImageBufferToTemp(
	buffer: Buffer,
	mimeType: string = "image/png"
): Promise<CommentImageAttachment> {
	if (!buffer || buffer.length === 0) {
		throw new Error("Image buffer is empty.");
	}
	const dir = ensureCommentImagesTempDir();
	const normMime = (mimeType || "image/png").toLowerCase().split(";")[0].trim();
	const ext = MIME_TO_EXT[normMime] || ".png";
	const effectiveMime = MIME_TO_EXT[normMime] ? normMime : "image/png";

	const rand = Math.random().toString(36).slice(2, 8);
	const ts = formatTimestampTag(new Date());
	const id = `img_${Date.now()}_${rand}`;
	const fileName = `sf_${ts}_${rand}${ext}`;
	const absPath = path.resolve(dir, fileName);

	await fs.promises.writeFile(absPath, buffer);

	return {
		id,
		path: absPath,
		fileName,
		mimeType: effectiveMime,
		sizeBytes: buffer.length,
	};
}

export async function readImageAsDataUrl(
	filePath: string,
	mimeType?: string
): Promise<string | null> {
	if (!filePath || !fs.existsSync(filePath)) return null;
	try {
		const bytes = await fs.promises.readFile(filePath);
		const mime = mimeType || inferMimeTypeFromPath(filePath);
		return `data:${mime};base64,${bytes.toString("base64")}`;
	} catch {
		return null;
	}
}

export function isInsideCommentImagesTempDir(filePath: string): boolean {
	if (!filePath) return false;
	const root = path.resolve(getCommentImagesTempDir());
	const target = path.resolve(filePath);
	const rel = path.relative(root, target);
	return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export function deleteTempImageSafe(filePath: string): void {
	if (!isInsideCommentImagesTempDir(filePath)) return;
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// ignore OS file lock races during cleanup
	}
}

export function pruneStaleTempImages(
	referencedPaths: Set<string>,
	maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): number {
	const dir = getCommentImagesTempDir();
	if (!fs.existsSync(dir)) return 0;

	const normalizedRefs = new Set<string>();
	for (const p of referencedPaths) {
		if (p) normalizedRefs.add(path.resolve(p).toLowerCase());
	}

	const now = Date.now();
	let removed = 0;
	try {
		const entries = fs.readdirSync(dir);
		for (const name of entries) {
			const abs = path.resolve(dir, name);
			if (normalizedRefs.has(abs.toLowerCase())) continue;
			try {
				const st = fs.statSync(abs);
				if (!st.isFile()) continue;
				if (now - st.mtimeMs >= maxAgeMs) {
					fs.unlinkSync(abs);
					removed++;
				}
			} catch {
				// ignore per-file stat/unlink issues
			}
		}
	} catch {
		return 0;
	}
	return removed;
}
