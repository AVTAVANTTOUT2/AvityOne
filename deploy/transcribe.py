#!/usr/bin/env python3
"""Local CPU transcription command; stdout contains only the transcript."""
import argparse
import fcntl
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description="Dictée locale AvityOne avec faster-whisper (CPU).")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--language", default="fr")
    parser.add_argument("--model", type=Path, default=Path(__file__).resolve().parent / "model")
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    if not args.file.is_file():
        parser.error("fichier audio introuvable")
    if not (args.model / "model.bin").is_file():
        parser.error("modèle absent : exécute deploy/install-transcription.py")
    if not 1 <= args.threads <= 16:
        parser.error("--threads doit être compris entre 1 et 16")
    # Installation alone accesses the network. Dictation always uses local files.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    # Serialize before loading the model: concurrent recordings share CPU and RAM.
    with (args.model / ".transcription.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        from faster_whisper import WhisperModel

        model = WhisperModel(str(args.model), device="cpu", compute_type="int8",
                             cpu_threads=args.threads, num_workers=1, local_files_only=True)
        segments, _ = model.transcribe(str(args.file), language=args.language.split("-")[0],
                                       beam_size=1, condition_on_previous_text=False, vad_filter=False)
        print(" ".join(segment.text.strip() for segment in segments).strip())


if __name__ == "__main__":
    try:
        main()
    except (ImportError, RuntimeError, ValueError, OSError) as error:
        print(f"Transcription impossible : {error}", file=sys.stderr)
        sys.exit(1)
