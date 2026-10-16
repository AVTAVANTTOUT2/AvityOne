#!/usr/bin/env python3
"""Install optional speech tooling in an isolated directory without root or apt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv


PIP_URL = "https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl"
PIP_SHA256 = "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
MODEL = "Systran/faster-whisper-base"
REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"


def main():
    parser = argparse.ArgumentParser(description="Installe la dictée CPU, sans modifier la configuration AvityOne.")
    parser.add_argument("--directory", type=Path, default=Path.home() / ".local/share/avityone-transcription")
    args = parser.parse_args()
    target = args.directory.expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    python = target / "venv/bin/python"
    if not python.exists():
        venv.EnvBuilder(with_pip=False).create(target / "venv")
    wheel = target / "pip-26.2.1-py3-none-any.whl"
    if not wheel.exists() or hashlib.sha256(wheel.read_bytes()).hexdigest() != PIP_SHA256:
        with urllib.request.urlopen(PIP_URL, timeout=60) as response:
            data = response.read(4 << 20)
        if hashlib.sha256(data).hexdigest() != PIP_SHA256:
            raise ValueError("Empreinte du paquet pip invalide")
        wheel.write_bytes(data)
    env = {**os.environ, "PYTHONPATH": str(wheel), "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_XET": "1"}
    subprocess.run([sys.executable, "-m", "pip", "--python", str(python), "install", "--no-cache-dir",
                    "--only-binary=:all:", "pip==26.2.1", "faster-whisper==1.2.1", "ctranslate2==4.8.3", "av==16.1.0"], env=env, check=True)
    subprocess.run([str(python), "-c", "from huggingface_hub import snapshot_download; import sys; "
                    "snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], "
                    "allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.txt'])",
                    MODEL, REVISION, str(target / "model")], env=env, check=True)
    shutil.copyfile(Path(__file__).with_name("transcribe.py"), target / "transcribe.py")
    installed = subprocess.check_output([str(python), "-m", "pip", "freeze"], text=True)
    (target / "requirements-installed.txt").write_text(installed, encoding="utf8")
    (target / "model-version.json").write_text(json.dumps({"repository": MODEL, "revision": REVISION}, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"transcription": {"command": str(python), "args": [str(target / "transcribe.py"),
                      "--file", "{file}", "--language", "{language}", "--threads", "4"]}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Installation de la dictée interrompue : {error}", file=sys.stderr)
        sys.exit(1)
