/**
 * VoiceDictation — Enregistrement micro natif Electron (PCM -> WAV 16kHz) + Pont Faster-Whisper GPU local.
 *
 * - Démarrage de l'enregistrement micro INSTANTANÉ (0 ms) dans Electron via Web Audio API,
 *   même pendant que le serveur Python GPU Faster-Whisper charge le modèle en arrière-plan.
 * - Aucun repli silencieux (Fail-Fast strict) : toute erreur micro ou serveur est remontée explicitement.
 * - Zéro dépendance ffmpeg / pyaudio.
 */

import { App } from "obsidian";
import * as path from "path";
import { spawn } from "child_process";

export interface VoiceDictationConfig {
	serverUrl: string;
	autoStartServer: boolean;
	pythonPath: string;
	scriptPath: string; // vault-relative or absolute
	whisperModel: string;
	whisperDevice: string;
	whisperComputeType: string;
	language: string;
}

export interface TranscriptionResponse {
	text: string;
	duration_s: number;
	inference_s: number;
	language: string;
}

const TARGET_SAMPLE_RATE = 16000;

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
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true);  // PCM format
	view.setUint16(22, 1, true);  // mono
	view.setUint32(24, TARGET_SAMPLE_RATE, true);
	view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);  // block align
	view.setUint16(34, 16, true); // 16-bit
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

export class VoiceDictationService {
	private app: App;
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

	constructor(app: App, getConfig: () => VoiceDictationConfig) {
		this.app = app;
		this.getConfig = getConfig;
	}

	public isRecording(): boolean {
		return this.recording;
	}

	private resolveScriptFullPath(cfg: VoiceDictationConfig): string {
		const raw = (cfg.scriptPath || "").trim();
		if (!raw) {
			throw new Error("Chemin du script whisper_dictation_server.py non configuré.");
		}
		if (path.isAbsolute(raw)) {
			return raw;
		}
		const adapter = this.app.vault.adapter as any;
		const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		if (!basePath) {
			throw new Error("Impossible de résoudre le dossier du coffre sur cette plateforme.");
		}
		return path.join(basePath, ...raw.replace(/\\/g, "/").split("/"));
	}

	private getPortFromUrl(urlStr: string): number {
		try {
			const u = new URL(urlStr);
			return u.port ? parseInt(u.port, 10) : 3056;
		} catch {
			return 3056;
		}
	}

	private async fetchHealth(serverUrl: string): Promise<{ status: string; error?: string; model?: string } | null> {
		const base = serverUrl.replace(/\/+$/, "");
		const ctrl = new AbortController();
		const timer = window.setTimeout(() => ctrl.abort(), 1500);
		try {
			const resp = await fetch(`${base}/health`, { method: "GET", signal: ctrl.signal });
			const data = await resp.json();
			return data;
		} catch {
			return null;
		} finally {
			window.clearTimeout(timer);
		}
	}

	private spawnLocalServer(cfg: VoiceDictationConfig): void {
		const now = Date.now();
		if (now - this.spawnAttemptedAt < 4000) return;
		this.spawnAttemptedAt = now;

		const scriptFull = this.resolveScriptFullPath(cfg);
		const port = this.getPortFromUrl(cfg.serverUrl);
		const pythonExe = (cfg.pythonPath || "python").trim() || "python";

		const args = [
			scriptFull,
			"--port",
			String(port),
			"--model",
			cfg.whisperModel || "medium",
			"--device",
			cfg.whisperDevice || "cuda",
			"--compute-type",
			cfg.whisperComputeType || "float16",
			"--default-language",
			cfg.language || "fr",
		];

		const child = spawn(pythonExe, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}

	/**
	 * Préchauffe silencieusement le serveur Faster-Whisper GPU en arrière-plan à l'ouverture de SlideFlow.
	 */
	public async prewarmServer(): Promise<void> {
		const cfg = this.getConfig();
		if (!cfg.autoStartServer) return;
		const health = await this.fetchHealth(cfg.serverUrl);
		if (!health) {
			try {
				this.spawnLocalServer(cfg);
			} catch (err) {
				console.error("[SlideFlow] Échec du préchauffage Whisper:", err);
			}
		}
	}

	public async startRecording(onLevel?: (rmsLevel: number) => void): Promise<void> {
		if (this.recording) return;

		// Démarre le préchauffage GPU en parallèle pendant qu'Henri parle
		void this.prewarmServer();

		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			throw new Error("API microphone navigator.mediaDevices.getUserMedia indisponible dans cette fenêtre.");
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
				// ignore disconnect cleanup
			}
			this.processorNode = null;
		}
		if (this.sourceNode) {
			try {
				this.sourceNode.disconnect();
			} catch {
				// ignore disconnect cleanup
			}
			this.sourceNode = null;
		}
		if (this.muteGainNode) {
			try {
				this.muteGainNode.disconnect();
			} catch {
				// ignore disconnect cleanup
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
			throw new Error("Aucun enregistrement vocal en cours.");
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
		const baseUrl = cfg.serverUrl.replace(/\/+$/, "");

		// Vérification & démarrage automatique du serveur Faster-Whisper GPU
		onStatus?.("⏳ Connexion au serveur Whisper GPU…");
		let health = await this.fetchHealth(baseUrl);
		if (!health) {
			if (!cfg.autoStartServer) {
				throw new Error(
					`Serveur Whisper injoignable sur ${baseUrl} (et démarrage automatique désactivé dans les réglages).`
				);
			}
			onStatus?.("⏳ Démarrage du serveur Faster-Whisper GPU…");
			this.spawnLocalServer(cfg);
		}

		// Attente propre que le modèle soit prêt (max 45s)
		const deadline = Date.now() + 45000;
		while (Date.now() < deadline) {
			health = await this.fetchHealth(baseUrl);
			if (health) {
				if (health.status === "ready") break;
				if (health.status === "error") {
					throw new Error(`Erreur critique serveur Faster-Whisper : ${health.error || "inconnue"}`);
				}
				onStatus?.(`⏳ Chargement Faster-Whisper (${health.model || cfg.whisperModel}) sur GPU…`);
			}
			await new Promise((r) => window.setTimeout(r, 350));
		}

		if (!health || health.status !== "ready") {
			throw new Error(
				`Timeout : le serveur Faster-Whisper sur ${baseUrl} n'est pas devenu prêt en 45s.`
			);
		}

		onStatus?.("⚡ Transcription GPU en cours…");
		const lang = encodeURIComponent(cfg.language || "fr");
		const resp = await fetch(`${baseUrl}/transcribe?language=${lang}`, {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: wavBuffer,
		});

		const json = await resp.json();
		if (!resp.ok) {
			throw new Error(json?.error || `HTTP ${resp.status} sur /transcribe`);
		}

		return json as TranscriptionResponse;
	}
}
