/**
 * VoiceDictation — Self-managed local Faster-Whisper dictation (zero path settings).
 *
 * - Instant microphone capture in Electron (Web Audio PCM -> 16 kHz mono WAV).
 * - Automatically writes the bundled Python server into `.obsidian/plugins/slideflow/whisper_server.py`.
 * - Automatically discovers Python 3, reuses existing Faster-Whisper installation if available,
 *   or bootstraps an isolated plugin `.venv` and installs `faster-whisper` + `numpy` (and NVIDIA CUDA
 *   runtime wheels if an NVIDIA GPU is detected).
 * - Automatically downloads the selected Whisper model on first use and restarts seamlessly if the
 *   user changes model in Settings.
 * - Strict Fail-Fast: surfaces every real error explicitly without silent fallbacks.
 */

import { App } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { WHISPER_SERVER_SCRIPT, WHISPER_SERVER_VERSION } from "./whisperServerScript";

export interface VoiceDictationConfig {
	whisperModel: string;
	language: string;
}

export interface TranscriptionResponse {
	text: string;
	duration_s: number;
	inference_s: number;
	language: string;
}

interface HealthResponse {
	status: string;
	version?: string;
	model?: string;
	device?: string;
	error?: string;
}

const TARGET_SAMPLE_RATE = 16000;
const WHISPER_PORT = 3056;
const WHISPER_BASE_URL = `http://127.0.0.1:${WHISPER_PORT}`;

function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || input.length <= 1) return input;
	const ratio = fromRate / toRate;
	const newLength = Math.max(1, Math.round(input.length / ratio));
	const output = new Float32Array(newLength);
	for (let i = 0; i < newLength; i++) {
		const pos = i * ratio;
		const low = Math.floor(pos);
		const high = Math.min(low + 1, input.length - 1);
		const weight = pos - low;
		output[i] = input[low] * (1 - weight) + input[high] * weight;
	}
	return output;
}

function encodeMonoWav16k(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const resampled = resampleFloat32(samples, sampleRate, TARGET_SAMPLE_RATE);
	const dataLength = resampled.length * 2;
	const buffer = new ArrayBuffer(44 + dataLength);
	const view = new DataView(buffer);

	const writeStr = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};

	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataLength, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, TARGET_SAMPLE_RATE, true);
	view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, "data");
	view.setUint32(40, dataLength, true);

	let offset = 44;
	for (let i = 0; i < resampled.length; i++) {
		const clamped = Math.max(-1, Math.min(1, resampled[i]));
		const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
		view.setInt16(offset, int16, true);
		offset += 2;
	}

	return buffer;
}

function runProcessCapture(
	exe: string,
	args: string[],
	timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn(exe, args, {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = window.setTimeout(() => {
			if (!settled) {
				settled = true;
				try {
					child.kill();
				} catch {
					// ignore
				}
				reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${exe}`));
			}
		}, timeoutMs);

		child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

export class VoiceDictationService {
	private app: App;
	private pluginDirRelative: string;
	private getConfig: () => VoiceDictationConfig;

	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private processorNode: ScriptProcessorNode | null = null;
	private muteGainNode: GainNode | null = null;
	private chunks: Float32Array[] = [];
	private recordingSampleRate: number = 48000;
	private recording: boolean = false;

	private spawnAttemptedAt: number = 0;
	private cachedReadyPython: string | null = null;
	private runtimeSetupPromise: Promise<string> | null = null;

	constructor(app: App, pluginDirRelative: string, getConfig: () => VoiceDictationConfig) {
		this.app = app;
		this.pluginDirRelative = pluginDirRelative;
		this.getConfig = getConfig;
	}

	public isRecording(): boolean {
		return this.recording;
	}

	private getPluginAbsoluteDir(): string {
		const adapter = this.app.vault.adapter as any;
		const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		if (!basePath) {
			throw new Error("Local voice dictation requires desktop Obsidian.");
		}
		return path.join(basePath, ...this.pluginDirRelative.replace(/\\/g, "/").split("/"));
	}

	private ensureBundledServerScript(): string {
		const dir = this.getPluginAbsoluteDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const scriptPath = path.join(dir, "whisper_server.py");
		const versionMarker = `# SLIDEFLOW_WHISPER_VERSION=${WHISPER_SERVER_VERSION}`;
		let needsWrite = true;
		if (fs.existsSync(scriptPath)) {
			try {
				const existing = fs.readFileSync(scriptPath, "utf8");
				if (existing.includes(versionMarker)) {
					needsWrite = false;
				}
			} catch {
				needsWrite = true;
			}
		}
		if (needsWrite) {
			fs.writeFileSync(scriptPath, WHISPER_SERVER_SCRIPT, "utf8");
		}
		return scriptPath;
	}

	private getVenvPythonPath(): string {
		const dir = this.getPluginAbsoluteDir();
		return process.platform === "win32"
			? path.join(dir, ".venv", "Scripts", "python.exe")
			: path.join(dir, ".venv", "bin", "python");
	}

	private discoverPythonCandidates(): string[] {
		const candidates: string[] = [];
		const pushUnique = (p: string) => {
			if (p && !candidates.includes(p)) candidates.push(p);
		};

		const venvPy = this.getVenvPythonPath();
		if (fs.existsSync(venvPy)) {
			pushUnique(venvPy);
		}

		if (process.platform === "win32") {
			pushUnique("python");
			const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
			const pyBase = path.join(localAppData, "Programs", "Python");
			if (fs.existsSync(pyBase)) {
				try {
					const dirs = fs.readdirSync(pyBase).filter((d) => /^Python3\d+$/i.test(d)).sort().reverse();
					for (const d of dirs) {
						const exe = path.join(pyBase, d, "python.exe");
						if (fs.existsSync(exe)) pushUnique(exe);
					}
				} catch {
					// ignore directory scan errors
				}
			}
		} else {
			pushUnique("python3");
			pushUnique("/opt/homebrew/bin/python3");
			pushUnique("/usr/local/bin/python3");
			pushUnique("python");
		}

		return candidates;
	}

	private async testPythonHasWhisper(pyExe: string): Promise<boolean> {
		try {
			const res = await runProcessCapture(
				pyExe,
				["-c", "import faster_whisper, numpy; print('OK')"],
				10000
			);
			return res.code === 0 && res.stdout.includes("OK");
		} catch {
			return false;
		}
	}

	private async testPython3Available(pyExe: string): Promise<boolean> {
		try {
			const res = await runProcessCapture(
				pyExe,
				["-c", "import sys; assert sys.version_info >= (3, 9); print(sys.executable)"],
				6000
			);
			return res.code === 0;
		} catch {
			return false;
		}
	}

	private async hasNvidiaGpu(): Promise<boolean> {
		try {
			const res = await runProcessCapture("nvidia-smi", ["-L"], 4000);
			return res.code === 0 && res.stdout.trim().length > 0;
		} catch {
			return false;
		}
	}

	private async resolveOrBootstrapPython(onStatus?: (msg: string) => void): Promise<string> {
		if (this.cachedReadyPython) {
			return this.cachedReadyPython;
		}
		if (this.runtimeSetupPromise) {
			return this.runtimeSetupPromise;
		}

		const runSetup = async (): Promise<string> => {
			const candidates = this.discoverPythonCandidates();

			// 1. Reuse any existing Python (plugin .venv or system Python) that already has faster-whisper + numpy
			for (const py of candidates) {
				if (await this.testPythonHasWhisper(py)) {
					this.cachedReadyPython = py;
					return py;
				}
			}

			// 2. Otherwise locate a base Python >= 3.9 and auto-install isolated plugin .venv + faster-whisper
			let basePython: string | null = null;
			for (const py of candidates) {
				if (await this.testPython3Available(py)) {
					basePython = py;
					break;
				}
			}

			if (!basePython) {
				throw new Error(
					"Python 3.9+ was not found on this machine. Install Python 3 to enable automatic local Whisper dictation."
				);
			}

			const venvDir = path.join(this.getPluginAbsoluteDir(), ".venv");
			const venvPy = this.getVenvPythonPath();

			if (!fs.existsSync(venvPy)) {
				onStatus?.("Setting up local Whisper Python environment (first time only)…");
				const mk = await runProcessCapture(basePython, ["-m", "venv", venvDir], 120000);
				if (mk.code !== 0) {
					throw new Error(`Failed creating plugin venv: ${(mk.stderr || mk.stdout).trim()}`);
				}
			}

			const hasGpu = await this.hasNvidiaGpu();
			const pkgs = ["faster-whisper", "numpy"];
			if (hasGpu && (process.platform === "win32" || process.platform === "linux")) {
				pkgs.push("nvidia-cublas-cu12", "nvidia-cudnn-cu12");
			}

			onStatus?.(
				hasGpu
					? "Installing Faster-Whisper + CUDA runtime (first time only)…"
					: "Installing Faster-Whisper runtime (first time only)…"
			);
			const pipRes = await runProcessCapture(
				venvPy,
				["-m", "pip", "install", "--upgrade", ...pkgs],
				600000
			);
			if (pipRes.code !== 0) {
				throw new Error(
					`Failed installing Faster-Whisper: ${(pipRes.stderr || pipRes.stdout).trim().slice(0, 300)}`
				);
			}

			if (!(await this.testPythonHasWhisper(venvPy))) {
				throw new Error("Faster-Whisper installation completed but import check failed.");
			}

			this.cachedReadyPython = venvPy;
			return venvPy;
		};

		this.runtimeSetupPromise = runSetup().finally(() => {
			this.runtimeSetupPromise = null;
		});
		return this.runtimeSetupPromise;
	}

	private async fetchHealth(): Promise<HealthResponse | null> {
		const ctrl = new AbortController();
		const timer = window.setTimeout(() => ctrl.abort(), 1500);
		try {
			const resp = await fetch(`${WHISPER_BASE_URL}/health`, { method: "GET", signal: ctrl.signal });
			return (await resp.json()) as HealthResponse;
		} catch {
			return null;
		} finally {
			window.clearTimeout(timer);
		}
	}

	private async shutdownRunningServer(): Promise<void> {
		try {
			await fetch(`${WHISPER_BASE_URL}/shutdown`, { method: "POST" });
			await new Promise((r) => window.setTimeout(r, 500));
		} catch {
			// ignore if already stopped
		}
	}

	private async spawnLocalServer(
		cfg: VoiceDictationConfig,
		onStatus?: (msg: string) => void
	): Promise<void> {
		const now = Date.now();
		if (now - this.spawnAttemptedAt < 3500) return;
		this.spawnAttemptedAt = now;

		const scriptPath = this.ensureBundledServerScript();
		const pyExe = await this.resolveOrBootstrapPython(onStatus);

		const args = [
			scriptPath,
			"--port",
			String(WHISPER_PORT),
			"--model",
			cfg.whisperModel || "medium",
			"--device",
			"auto",
			"--compute-type",
			"auto",
			"--default-language",
			cfg.language || "fr",
		];

		const child = spawn(pyExe, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}

	/**
	 * Silently prewarms the managed Whisper server when SlideFlow opens.
	 * If a server is already running with a different model/version, restarts it cleanly.
	 */
	public async prewarmServer(): Promise<void> {
		const cfg = this.getConfig();
		try {
			const health = await this.fetchHealth();
			if (health) {
				const sameModel = !health.model || health.model === (cfg.whisperModel || "medium");
				const sameVer = !health.version || health.version === WHISPER_SERVER_VERSION;
				if (sameModel && sameVer && health.status !== "error") {
					return;
				}
				await this.shutdownRunningServer();
			}
			await this.spawnLocalServer(cfg);
		} catch (err) {
			console.error("[SlideFlow] Whisper prewarm failed:", err);
		}
	}

	public async startRecording(onLevel?: (rmsLevel: number) => void): Promise<void> {
		if (this.recording) return;

		void this.prewarmServer();

		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			throw new Error("Microphone API (getUserMedia) is unavailable in this window.");
		}

		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
		});

		const audioCtx = new AudioContext();
		const source = audioCtx.createMediaStreamSource(stream);
		const processor = audioCtx.createScriptProcessor(4096, 1, 1);
		const muteGain = audioCtx.createGain();
		muteGain.gain.value = 0;

		this.chunks = [];
		this.recordingSampleRate = audioCtx.sampleRate;

		processor.onaudioprocess = (ev: AudioProcessingEvent) => {
			if (!this.recording) return;
			const channelData = ev.inputBuffer.getChannelData(0);
			const copy = new Float32Array(channelData.length);
			copy.set(channelData);
			this.chunks.push(copy);

			if (onLevel) {
				let sum = 0;
				for (let i = 0; i < copy.length; i++) {
					sum += copy[i] * copy[i];
				}
				const rms = Math.sqrt(sum / copy.length);
				onLevel(Math.min(1, rms * 8));
			}
		};

		source.connect(processor);
		processor.connect(muteGain);
		muteGain.connect(audioCtx.destination);

		this.mediaStream = stream;
		this.audioContext = audioCtx;
		this.sourceNode = source;
		this.processorNode = processor;
		this.muteGainNode = muteGain;
		this.recording = true;
	}

	public cancelRecording(): void {
		this.recording = false;
		this.cleanupAudioNodes();
		this.chunks = [];
	}

	private cleanupAudioNodes(): void {
		if (this.processorNode) {
			this.processorNode.onaudioprocess = null;
			try {
				this.processorNode.disconnect();
			} catch {
				// ignore
			}
			this.processorNode = null;
		}
		if (this.sourceNode) {
			try {
				this.sourceNode.disconnect();
			} catch {
				// ignore
			}
			this.sourceNode = null;
		}
		if (this.muteGainNode) {
			try {
				this.muteGainNode.disconnect();
			} catch {
				// ignore
			}
			this.muteGainNode = null;
		}
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach((t) => t.stop());
			this.mediaStream = null;
		}
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
	}

	public async stopAndTranscribe(onStatus?: (msg: string) => void): Promise<TranscriptionResponse> {
		if (!this.recording) {
			throw new Error("No active voice recording.");
		}
		this.recording = false;
		const capturedChunks = this.chunks;
		const sampleRate = this.recordingSampleRate;
		this.chunks = [];
		this.cleanupAudioNodes();

		const totalSamples = capturedChunks.reduce((acc, c) => acc + c.length, 0);
		if (totalSamples < sampleRate * 0.15) {
			return { text: "", duration_s: 0, inference_s: 0, language: this.getConfig().language || "fr" };
		}

		const merged = new Float32Array(totalSamples);
		let offset = 0;
		for (const c of capturedChunks) {
			merged.set(c, offset);
			offset += c.length;
		}

		const wavBuffer = encodeMonoWav16k(merged, sampleRate);
		const cfg = this.getConfig();

		onStatus?.("Connecting to local Whisper engine…");
		let health = await this.fetchHealth();

		if (
			health &&
			((health.model && health.model !== (cfg.whisperModel || "medium")) ||
				(health.version && health.version !== WHISPER_SERVER_VERSION) ||
				health.status === "error")
		) {
			await this.shutdownRunningServer();
			health = null;
		}

		if (!health) {
			onStatus?.("Starting managed Faster-Whisper engine…");
			await this.spawnLocalServer(cfg, onStatus);
		}

		// Wait for ready; extend deadline automatically when downloading model for the first time
		let deadline = Date.now() + 60000;
		let extendedForDownload = false;

		while (Date.now() < deadline) {
			health = await this.fetchHealth();
			if (health) {
				if (health.status === "ready") break;
				if (health.status === "error") {
					throw new Error(`Whisper server error: ${health.error || "unknown"}`);
				}
				if (health.status === "downloading") {
					if (!extendedForDownload) {
						deadline = Date.now() + 600000;
						extendedForDownload = true;
					}
					onStatus?.(`Downloading Whisper "${health.model || cfg.whisperModel}" model (first time only)…`);
				} else {
					onStatus?.(`Loading Whisper "${health.model || cfg.whisperModel}"…`);
				}
			}
			await new Promise((r) => window.setTimeout(r, 350));
		}

		if (!health || health.status !== "ready") {
			throw new Error("Timed out waiting for local Whisper engine to become ready.");
		}

		onStatus?.("Transcribing…");
		const lang = encodeURIComponent(cfg.language || "fr");
		const resp = await fetch(`${WHISPER_BASE_URL}/transcribe?language=${lang}`, {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: wavBuffer,
		});

		const json = await resp.json();
		if (!resp.ok) {
			throw new Error(json?.error || `HTTP ${resp.status} on /transcribe`);
		}

		return json as TranscriptionResponse;
	}
}
