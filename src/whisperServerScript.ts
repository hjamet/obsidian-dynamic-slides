/**
 * Bundled self-contained local Faster-Whisper HTTP server for SlideFlow.
 *
 * SlideFlow automatically materializes this script into its own plugin folder
 * (`.obsidian/plugins/slideflow/whisper_server.py`), bootstraps Python/venv/packages
 * when needed, auto-detects CUDA GPU vs CPU, and downloads the chosen Whisper model
 * automatically on first use — zero path settings required!
 */

export const WHISPER_SERVER_VERSION = "2.7.3";

export const WHISPER_SERVER_SCRIPT = `#!/usr/bin/env python3
# SLIDEFLOW_WHISPER_VERSION=${WHISPER_SERVER_VERSION}
"""
SlideFlow managed local Faster-Whisper HTTP dictation server (127.0.0.1 only).
- Zero ffmpeg/pyaudio dependency (stdlib wave + numpy)
- Windowless pythonw.exe safe on Windows (redirects null stdout/stderr to temp log)
- Auto-detects CUDA GPU (float16) vs CPU (int8)
- Auto-downloads requested Whisper model from HuggingFace if missing from local cache
- Auto-shuts down after idle timeout (default 1800s) to free VRAM
"""

from __future__ import annotations

import argparse
import http.server
import io
import json
import logging
import os
import site
import sys
import tempfile
import threading
import time
import traceback
import wave
from pathlib import Path
from typing import Optional
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

import numpy as np

SERVER_VERSION = "${WHISPER_SERVER_VERSION}"
SAMPLE_RATE = 16000
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3056

HALLUCINATION_PATTERNS = (
    "merci d'avoir regardé",
    "merci d'avoir visionné",
    "amara.org",
    "sous-titrage",
    "sous-titres réalisés",
    "sous-titres fait",
    "abonnez-vous",
    "n'oubliez pas de vous abonner",
    "à bientôt pour une nouvelle vidéo",
    "watching!",
    "thanks for watching",
)

logger = logging.getLogger("slideflow_whisper")


def setup_cuda_dlls() -> None:
    """Register NVIDIA pip wheel DLL directories on Windows without mutating PATH."""
    if sys.platform != "win32":
        return
    roots = [Path(sys.prefix) / "Lib" / "site-packages"]
    try:
        user_sp = site.getusersitepackages()
        if user_sp:
            roots.append(Path(user_sp))
    except Exception:
        pass
    seen: set[str] = set()
    for sp in roots:
        nvidia_base = sp / "nvidia"
        if not nvidia_base.exists():
            continue
        for sub in nvidia_base.iterdir():
            bin_dir = sub / "bin"
            if bin_dir.exists():
                s = str(bin_dir)
                if s not in seen:
                    seen.add(s)
                    os.add_dll_directory(s)


def detect_device_and_compute(requested_device: str, requested_compute: str) -> tuple[str, str]:
    if requested_device and requested_device.lower() != "auto":
        dev = requested_device.lower()
        comp = requested_compute if requested_compute and requested_compute.lower() != "auto" else (
            "float16" if dev == "cuda" else "int8"
        )
        return dev, comp

    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def is_hallucination(text: str) -> bool:
    clean = text.strip().lower()
    if not clean or clean in (".", "...", "!", "?"):
        return True
    for pat in HALLUCINATION_PATTERNS:
        if pat in clean:
            remainder = clean.replace(pat, "").strip(" .,!?:;-'" + '"')
            if len(remainder) < 15:
                return True
    return False


def decode_wav_to_16k_float32(wav_bytes: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        rate = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if nframes == 0 or not raw:
        return np.zeros(0, dtype=np.float32)

    if sampwidth == 2:
        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        arr = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sampwidth == 1:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {sampwidth}")

    if channels > 1:
        arr = arr.reshape(-1, channels).mean(axis=1)

    if rate != SAMPLE_RATE and len(arr) > 1:
        target_len = max(1, int(round(len(arr) * SAMPLE_RATE / rate)))
        old_idx = np.linspace(0.0, len(arr) - 1, num=len(arr), dtype=np.float64)
        new_idx = np.linspace(0.0, len(arr) - 1, num=target_len, dtype=np.float64)
        arr = np.interp(new_idx, old_idx, arr).astype(np.float32)

    return arr.astype(np.float32, copy=False)


class DictationEngine:
    def __init__(self, model_name: str, device: str, compute_type: str):
        self.model_name = model_name
        self.requested_device = device
        self.requested_compute = compute_type
        self.device = device
        self.compute_type = compute_type
        self.status = "loading"
        self.error: Optional[str] = None
        self.model = None
        self.load_seconds: Optional[float] = None
        self.ready_event = threading.Event()
        self.infer_lock = threading.Lock()
        self.last_activity = time.time()

    def load_model_blocking(self) -> None:
        t0 = time.time()
        try:
            setup_cuda_dlls()
            self.device, self.compute_type = detect_device_and_compute(
                self.requested_device, self.requested_compute
            )
            from faster_whisper import WhisperModel

            logger.info(
                "Loading Faster-Whisper '%s' on %s (%s)...",
                self.model_name,
                self.device,
                self.compute_type,
            )
            try:
                self.model = WhisperModel(
                    self.model_name,
                    device=self.device,
                    compute_type=self.compute_type,
                    local_files_only=True,
                )
            except Exception as local_exc:
                msg = str(local_exc).lower()
                if (
                    "localentrynotfounderror" in type(local_exc).__name__.lower()
                    or "cannot find the requested files" in msg
                    or "local_files_only" in msg
                    or "not found" in msg
                ):
                    self.status = "downloading"
                    logger.info("Downloading Whisper model '%s' from HuggingFace...", self.model_name)
                    self.model = WhisperModel(
                        self.model_name,
                        device=self.device,
                        compute_type=self.compute_type,
                        local_files_only=False,
                    )
                else:
                    raise
            self.load_seconds = round(time.time() - t0, 2)
            self.status = "ready"
            logger.info("Faster-Whisper ready in %.2fs.", self.load_seconds)
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()}"
            self.status = "error"
            logger.exception("Critical error loading Faster-Whisper.")
        finally:
            self.ready_event.set()

    def transcribe(self, wav_bytes: bytes, language: Optional[str], timeout_s: float = 300.0) -> dict:
        self.last_activity = time.time()
        if not self.ready_event.wait(timeout=timeout_s):
            raise TimeoutError(f"Whisper model still loading after {timeout_s:.0f}s.")
        if self.status == "error" or self.model is None:
            raise RuntimeError(self.error or "Whisper model unavailable.")

        audio = decode_wav_to_16k_float32(wav_bytes)
        duration_s = round(len(audio) / SAMPLE_RATE, 2)
        if len(audio) < int(SAMPLE_RATE * 0.15):
            return {"text": "", "duration_s": duration_s, "inference_s": 0.0, "language": language or "auto"}

        lang_arg = None if (not language or language.lower() == "auto") else language
        t0 = time.time()
        with self.infer_lock:
            segments, info = self.model.transcribe(
                audio,
                language=lang_arg,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=350, speech_pad_ms=200),
                beam_size=5,
            )
            parts = []
            for seg in segments:
                txt = seg.text.strip()
                if txt and not is_hallucination(txt):
                    parts.append(txt)
        inference_s = round(time.time() - t0, 2)
        self.last_activity = time.time()
        full_text = " ".join(parts).strip()
        detected_lang = getattr(info, "language", lang_arg or "auto")
        return {
            "text": full_text,
            "duration_s": duration_s,
            "inference_s": inference_s,
            "language": detected_lang,
        }


def is_server_already_running(host: str, port: int) -> bool:
    try:
        with urlopen(f"http://{host}:{port}/health", timeout=1.0) as resp:
            return resp.status == 200
    except (URLError, OSError):
        return False


def ensure_windowless_streams() -> Optional[Path]:
    """Under pythonw.exe on Windows, sys.stdout/sys.stderr are None; bind them safely."""
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    if sys.stdout is not None and sys.stderr is not None:
        return None
    log_path = Path(tempfile.gettempdir()) / "slideflow_whisper.log"
    try:
        log_fp = open(log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        log_fp = open(os.devnull, "w", encoding="utf-8")
        log_path = None
    if sys.stdout is None:
        sys.stdout = log_fp
    if sys.stderr is None:
        sys.stderr = log_fp
    return log_path


def main() -> None:
    log_path = ensure_windowless_streams()

    parser = argparse.ArgumentParser(description="SlideFlow managed local Faster-Whisper server")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--default-language", default="fr")
    parser.add_argument("--idle-timeout", type=int, default=1800)
    args = parser.parse_args()

    log_kwargs = {
        "level": logging.INFO,
        "format": "%(asctime)s [%(levelname)s] %(message)s",
        "datefmt": "%H:%M:%S",
    }
    if log_path is not None:
        log_kwargs["filename"] = str(log_path)
        log_kwargs["encoding"] = "utf-8"
    logging.basicConfig(**log_kwargs)

    if is_server_already_running(args.host, args.port):
        logger.info("Whisper dictation server already running on http://%s:%d.", args.host, args.port)
        return

    engine = DictationEngine(args.model, args.device, args.compute_type)
    shutdown_event = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send_json(self, status_code: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path in ("/health", "/status"):
                engine.last_activity = time.time()
                code = 500 if engine.status == "error" else 200
                self._send_json(
                    code,
                    {
                        "status": engine.status,
                        "version": SERVER_VERSION,
                        "model": engine.model_name,
                        "device": engine.device,
                        "compute_type": engine.compute_type,
                        "load_seconds": engine.load_seconds,
                        "error": engine.error,
                    },
                )
            else:
                self._send_json(404, {"error": f"Unknown route: {parsed.path}"})

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/shutdown":
                self._send_json(200, {"status": "shutting_down"})
                shutdown_event.set()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return

            if parsed.path != "/transcribe":
                self._send_json(404, {"error": f"Unknown POST route: {parsed.path}"})
                return

            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    self._send_json(400, {"error": "Empty WAV audio body."})
                    return
                body = self.rfile.read(length)
                qs = parse_qs(parsed.query)
                lang = qs.get("language", [args.default_language])[0]
                result = engine.transcribe(body, language=lang)
                self._send_json(200, result)
            except Exception as exc:
                logger.exception("Error in /transcribe")
                self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

        def log_message(self, fmt: str, *log_args) -> None:
            pass

    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    http_thread = threading.Thread(target=server.serve_forever, daemon=True, name="DictationHTTP")
    http_thread.start()

    # Load CUDA + Faster-Whisper on main thread to avoid Windows DLL deadlocks
    engine.load_model_blocking()

    if args.idle_timeout > 0:
        def idle_watchdog() -> None:
            while not shutdown_event.wait(30.0):
                if time.time() - engine.last_activity >= args.idle_timeout:
                    shutdown_event.set()
                    server.shutdown()
                    break

        threading.Thread(target=idle_watchdog, daemon=True, name="IdleWatchdog").start()

    try:
        while not shutdown_event.wait(0.5):
            pass
    except KeyboardInterrupt:
        shutdown_event.set()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
`;
