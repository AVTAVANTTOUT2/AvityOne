import os
from pathlib import Path
from types import SimpleNamespace
import time


class WhisperModel:
    def __init__(self, model, **options):
        assert (Path(model) / "model.bin").is_file()
        assert options == {"device": "cpu", "compute_type": "int8", "cpu_threads": 2,
                           "num_workers": 1, "local_files_only": True}
        assert os.environ["HF_HUB_OFFLINE"] == "1"
        assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
        self.active = Path(model) / "active-test"
        self.active.touch(exist_ok=False)

    def transcribe(self, audio, **options):
        assert Path(audio).read_text() == "fake-audio"
        assert options == {"language": "fr", "beam_size": 1,
                           "condition_on_previous_text": False, "vad_filter": False}
        time.sleep(0.2)
        self.active.unlink()
        return iter([SimpleNamespace(text=" Bonjour en français. "), SimpleNamespace(text=" Deuxième phrase. ")]), None
