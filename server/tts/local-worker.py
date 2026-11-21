#!/usr/bin/env python3
"""Persistent local TTS worker. Only JSON-lines replies use the original stdout."""

import base64
import gc
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import wave


SAMPLE_RATE = 24_000
MAX_TEXT_CHARACTERS = 5_000
MAX_REQUEST_BYTES = 64 * 1024
MAX_AUDIO_BYTES = 32 * 1024 * 1024  # Includes the 44-byte PCM WAV header.


class AudioLimit(Exception):
    pass


class Synthesizer:
    def __init__(self):
        spec = importlib.util.spec_from_file_location(
            "local_tts_config", Path.home() / "tts" / "tts.py"
        )
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        self.engines = cli.ENGINES
        self.split_text = cli.split_text
        self.model = None
        self.engine = None

    def load(self, engine, repo):
        if self.engine != engine:
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model

            if self.model is not None:
                self.model = None
                self.engine = None
                gc.collect()
                mx.clear_cache()
            self.model = load_model(repo)
            self.engine = engine
        return self.model

    def handle(self, request):
        request_id = request.get("id")
        engine = request.get("engine")
        text = request.get("text")
        rate = request.get("rate", 1)
        cfg = self.engines.get(engine) if isinstance(engine, str) else None
        if (
            type(request_id) is not int or request_id < 1
            or cfg is None
            or not isinstance(text, str) or len(text) > MAX_TEXT_CHARACTERS
            or type(rate) not in (int, float) or not 0.5 <= rate <= 2
        ):
            return {"error": "invalid_request"}
        voice = request.get("voice", cfg["default_voice"])
        if voice not in [voice_id for voice_id, _ in cfg["voices"]]:
            return {"error": "invalid_request"}
        chunks = self.split_text(text, cfg["max_chars"])
        if not chunks:
            return {"error": "invalid_request"}

        model = self.load(engine, cfg["repo"])
        wav = self.synthesize(model, chunks, voice, rate, cfg["lang"])
        return {"audio": base64.b64encode(wav).decode("ascii")}

    @staticmethod
    def synthesize(model, chunks, voice, rate, lang):
        import numpy as np

        output = io.BytesIO()
        samples = 0
        pause_samples = SAMPLE_RATE // 4
        with wave.open(output, "wb") as wav:
            wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))

            def write(pcm, length):
                nonlocal samples
                samples += length
                if 44 + samples * 2 > MAX_AUDIO_BYTES:
                    raise AudioLimit
                wav.writeframesraw(pcm)

            for index, chunk in enumerate(chunks):
                if index:
                    write(b"\0" * (2 * pause_samples), pause_samples)
                before_chunk = samples
                for result in model.generate(
                    text=chunk, voice=voice, speed=rate, lang_code=lang
                ):
                    sample_rate = (
                        getattr(result, "sample_rate", None)
                        or getattr(model, "sample_rate", None)
                        or SAMPLE_RATE
                    )
                    if sample_rate != SAMPLE_RATE:
                        raise ValueError("unexpected sample rate")
                    audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    pcm = (np.clip(audio, -1, 32767 / 32768) * 32768).astype("<i2")
                    write(pcm.tobytes(), pcm.size)
                if samples == before_chunk:
                    raise ValueError("empty audio")
        return output.getvalue()


def serve(protocol):
    synthesizer = None
    while line := sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1):
        if len(line) > MAX_REQUEST_BYTES:
            return
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid request")
            if type(request.get("id")) is int:
                request_id = request["id"]
        except (ValueError, RecursionError):
            reply = {"error": "invalid_request"}
        else:
            try:
                if synthesizer is None:
                    synthesizer = Synthesizer()
                reply = synthesizer.handle(request)
            except AudioLimit:
                reply = {"error": "audio_limit"}
            except Exception:
                reply = {"error": "synthesis_failed"}
        protocol.write(json.dumps({"id": request_id, **reply}) + "\n")


def main():
    # Redirect the OS descriptors too, including native MLX output and startup errors.
    with os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="ascii", buffering=1) as protocol:
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), sys.stdout.fileno())
            os.dup2(sink.fileno(), sys.stderr.fileno())
        serve(protocol)


if __name__ == "__main__":
    main()
