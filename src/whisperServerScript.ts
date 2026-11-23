/**
 * Bundled self-contained local Faster-Whisper HTTP server for SlideFlow.
 *
 * SlideFlow automatically materializes this script into its own plugin folder
 * (`.obsidian/plugins/slideflow/whisper_server.py`), bootstraps Python/venv/packages
 * when needed, auto-detects CUDA GPU vs CPU, and downloads the chosen Whisper model
 * automatically on first use with live byte-level progress reporting — zero path settings required!
 */

export const WHISPER_SERVER_VERSION = "2.8.0";

export const WHISPER_SERVER_SCRIPT = `#!/usr/bin/env python3
# SLIDEFLOW_WHISPER_VERSION=${WHISPER_SERVER_VERSION}
"""
SlideFlow managed local Faster-Whisper HTTP dictation server (127.0.0.1 only).
- Zero ffmpeg/pyaudio dependency (stdlib wave + numpy)
- Windowless pythonw.exe safe on Windows (redirects stdout/stderr to temp log)
- Exclusive port binding on Windows (SO_EXCLUSIVEADDRUSE) to prevent duplicate GPU loads
- Auto-detects CUDA GPU (float16) vs CPU (int8)
- Auto-downloads requested Whisper model from HuggingFace with live byte-level progress in /health
- Auto-shuts down after idle timeout (default 1800s) to free VRAM
"""

from __future__ import annotations

import argparse
import errno
import http.server
import io
import json
import logging
import os
import re
import site
import socket
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


class ExclusiveThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """Prevents multiple Whisper instances from sharing the same localhost port on Windows."""

    allow_reuse_address = False

    def server_bind(self) -> None:
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class DictationEngine:
    def __init__(self, model_name: str, device: str, compute_type: str):
        self.model_name = model_name
        self.requested_device = device
        self.requested_compute = compute_type
        self.device = device
        self.compute_type = compute_type
        self.status = "loading"
        self.stage = "initializing"
        self.progress: Optional[float] = 5.0
        self.progress_detail = f"Initializing Whisper '{model_name}'…"
        self.downloaded_mb: Optional[float] = None
        self.total_mb: Optional[float] = None
        self.error: Optional[str] = None
        self.model = None
        self.load_seconds: Optional[float] = None
        self.ready_event = threading.Event()
        self.infer_lock = threading.Lock()
        self.progress_lock = threading.Lock()
        self.last_activity = time.time()

    def _set_progress(
        self,
        *,
        status: Optional[str] = None,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        detail: Optional[str] = None,
        downloaded_mb: Optional[float] = None,
        total_mb: Optional[float] = None,
    ) -> None:
        with self.progress_lock:
            if status is not None:
                self.status = status
            if stage is not None:
                self.stage = stage
            self.progress = progress
            if detail is not None:
                self.progress_detail = detail
            self.downloaded_mb = downloaded_mb
            self.total_mb = total_mb

    def _download_model_with_progress(self) -> str:
        import huggingface_hub
        from faster_whisper import utils as fw_utils

        if re.match(r".*/.*", self.model_name):
            repo_id = self.model_name
        else:
            repo_id = fw_utils._MODELS.get(self.model_name)
            if repo_id is None:
                raise ValueError(f"Unknown Whisper model '{self.model_name}'")

        allow_patterns = [
            "config.json",
            "preprocessor_config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
        ]

        engine = self
        bar_lock = threading.Lock()
        byte_bars: dict[int, list[float]] = {}
        next_bar_id = [0]

        class SilentProgressTqdm:
            """Stream-free tqdm-compatible progress hook safe under pythonw.exe."""

            def __init__(self, iterable=None, *args, **kwargs):
                self.iterable = iterable
                inferred_total = kwargs.get("total")
                if inferred_total is None and iterable is not None:
                    try:
                        inferred_total = len(iterable)
                    except TypeError:
                        inferred_total = 0.0
                self.total = float(inferred_total or 0.0)
                self.n = float(kwargs.get("initial") or 0.0)
                self.desc = str(kwargs.get("desc") or "")
                self.unit = str(kwargs.get("unit") or "")
                self.is_byte_bar = (
                    self.unit.upper().startswith("B")
                    or bool(kwargs.get("unit_scale"))
                    or self.total >= 100_000
                )
                with bar_lock:
                    self._bar_id = next_bar_id[0]
                    next_bar_id[0] += 1
                    if self.is_byte_bar and self.total > 0:
                        byte_bars[self._bar_id] = [self.n, self.total]
                self._publish()

            def __iter__(self):
                if self.iterable is None:
                    return
                for item in self.iterable:
                    yield item
                    self.update(1)

            def _publish(self) -> None:
                with bar_lock:
                    if self.is_byte_bar and self.total > 0:
                        byte_bars[self._bar_id] = [self.n, self.total]
                    if byte_bars:
                        dl_bytes = sum(v[0] for v in byte_bars.values())
                        tot_bytes = sum(v[1] for v in byte_bars.values())
                        if tot_bytes > 0:
                            pct = round(min(99.5, max(0.0, 100.0 * dl_bytes / tot_bytes)), 1)
                            dl_mb = round(dl_bytes / (1024.0 * 1024.0), 1)
                            tot_mb = round(tot_bytes / (1024.0 * 1024.0), 1)
                            engine._set_progress(
                                status="downloading",
                                stage="downloading_model",
                                progress=pct,
                                detail=f"Downloading Whisper '{engine.model_name}' ({dl_mb:.0f} / {tot_mb:.0f} MB)",
                                downloaded_mb=dl_mb,
                                total_mb=tot_mb,
                            )
                            return
                if self.total > 0:
                    pct = round(min(95.0, max(0.0, 100.0 * self.n / self.total)), 1)
                    engine._set_progress(
                        status="downloading",
                        stage="downloading_model",
                        progress=pct,
                        detail=f"Downloading Whisper '{engine.model_name}' ({int(self.n)}/{int(self.total)} files)",
                    )

            def update(self, n: float = 1) -> None:
                self.n = max(0.0, self.n + float(n or 0.0))
                self._publish()

            def set_description(self, desc: Optional[str] = None, refresh: bool = True) -> None:
                if desc:
                    self.desc = str(desc)

            def set_postfix(self, *args, **kwargs) -> None:
                pass

            def set_postfix_str(self, *args, **kwargs) -> None:
                pass

            def refresh(self, *args, **kwargs) -> None:
                self._publish()

            def reset(self, total: Optional[float] = None) -> None:
                self.n = 0.0
                if total is not None:
                    self.total = float(total)
                self._publish()

            def close(self) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_val, exc_tb):
                self.close()
                return False

            @classmethod
            def get_lock(cls):
                return bar_lock

            @classmethod
            def set_lock(cls, lock) -> None:
                pass

        self._set_progress(
            status="downloading",
            stage="downloading_model",
            progress=0.0,
            detail=f"Downloading Whisper '{self.model_name}' from HuggingFace…",
        )
        return huggingface_hub.snapshot_download(
            repo_id,
            allow_patterns=allow_patterns,
            local_files_only=False,
            tqdm_class=SilentProgressTqdm,
        )

    def load_model_blocking(self) -> None:
        t0 = time.time()
        try:
            self._set_progress(
                status="loading",
                stage="detecting_device",
                progress=10.0,
                detail="Detecting CUDA GPU / CPU runtime…",
            )
            setup_cuda_dlls()
            self.device, self.compute_type = detect_device_and_compute(
                self.requested_device, self.requested_compute
            )
            from faster_whisper import WhisperModel

            self._set_progress(
                status="loading",
                stage="loading_model",
                progress=None,
                detail=f"Loading Whisper '{self.model_name}' on {self.device.upper()} ({self.compute_type})…",
            )
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
                    logger.info("Downloading Whisper model '%s' from HuggingFace...", self.model_name)
                    local_snapshot_dir = self._download_model_with_progress()
                    self._set_progress(
                        status="loading",
                        stage="loading_model",
                        progress=None,
                        detail=f"Loading downloaded Whisper '{self.model_name}' into {self.device.upper()}…",
                    )
                    self.model = WhisperModel(
                        local_snapshot_dir,
                        device=self.device,
                        compute_type=self.compute_type,
                        local_files_only=True,
                    )
                else:
                    raise
            self.load_seconds = round(time.time() - t0, 2)
            self._set_progress(
                status="ready",
                stage="ready",
                progress=100.0,
                detail=f"Ready ({self.device.upper()} · {self.compute_type})",
            )
            logger.info("Faster-Whisper ready in %.2fs.", self.load_seconds)
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()}"
            self._set_progress(
                status="error",
                stage="error",
                progress=None,
                detail=f"Whisper error: {exc}",
            )
            logger.exception("Critical error loading Faster-Whisper.")
        finally:
            self.ready_event.set()

    def get_health_payload(self) -> dict:
        with self.progress_lock:
            return {
                "status": self.status,
                "stage": self.stage,
                "version": SERVER_VERSION,
                "model": self.model_name,
                "device": self.device,
                "compute_type": self.compute_type,
                "progress": self.progress,
                "progress_detail": self.progress_detail,
                "downloaded_mb": self.downloaded_mb,
                "total_mb": self.total_mb,
                "load_seconds": self.load_seconds,
                "error": self.error,
            }

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


def acquire_single_instance_mutex(port: int) -> Optional[int]:
    """Acquire an OS-level named mutex on Windows so concurrent spawns never double-load VRAM.

    Returns the mutex handle on Windows (caller must close on exit), 0 on non-Windows,
    or None if another instance already holds the mutex.
    """
    if sys.platform != "win32":
        return 0
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    mutex_name = f"Local\\\\SlideFlowWhisper_{port}"
    handle = kernel32.CreateMutexW(None, False, mutex_name)
    if not handle:
        err = ctypes.get_last_error()
        raise OSError(err, f"CreateMutexW failed for {mutex_name}")
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return None
    return int(handle)


def release_single_instance_mutex(handle: Optional[int]) -> None:
    if sys.platform != "win32" or not handle:
        return
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle(handle)


def ensure_windowless_streams() -> Optional[Path]:
    """Under pythonw.exe on Windows, redirect null/devnull streams to a temp log safely."""
    exe_name = os.path.basename(sys.executable or "").lower()
    is_pythonw = exe_name.startswith("pythonw")
    if not is_pythonw and sys.stdout is not None and sys.stderr is not None:
        return None
    log_path = Path(tempfile.gettempdir()) / "slideflow_whisper.log"
    try:
        log_fp = open(log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        log_fp = open(os.devnull, "w", encoding="utf-8")
        log_path = None
    if sys.stdout is None or is_pythonw:
        sys.stdout = log_fp
    if sys.stderr is None or is_pythonw:
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

    mutex_handle = acquire_single_instance_mutex(args.port)
    if mutex_handle is None:
        logger.info("Another Whisper dictation server instance already holds mutex for port %d; exiting.", args.port)
        return

    if is_server_already_running(args.host, args.port):
        logger.info("Whisper dictation server already running on http://%s:%d.", args.host, args.port)
        release_single_instance_mutex(mutex_handle)
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
                payload = engine.get_health_payload()
                code = 500 if payload["status"] == "error" else 200
                self._send_json(code, payload)
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

    try:
        server = ExclusiveThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as bind_err:
        if bind_err.errno in (errno.EADDRINUSE, 10048, 10013):
            logger.info("Port %d already exclusively bound (%s); exiting.", args.port, bind_err)
            release_single_instance_mutex(mutex_handle)
            return
        release_single_instance_mutex(mutex_handle)
        raise

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
        release_single_instance_mutex(mutex_handle)


if __name__ == "__main__":
    main()
`;
