# Local open-source voice for Claude's think lines: Kokoro-82M (Apache-2.0) via kokoro-onnx. Loads the model once,
# then POST /tts {"text": "...", "voice": "am_michael"} returns a WAV. Listens on 127.0.0.1 only.
# The voice comes from tts/voice.txt (read on every line). Run: tts/.venv/bin/python tts/server.py   (dashboard.js falls back to macOS `say` when this isn't running)
import io
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("TTS_PORT", 5123))
VOICE_FILE = os.path.join(HERE, "voice.txt")  # edit to switch voices live, no restart: a Kokoro voice (am_puck, am_santa,
# bm_fable) or any macOS voice (Fred, Zarvox, Bad News - `say -v '?'` lists them)


def default_voice():
    try:
        return open(VOICE_FILE).read().strip() or "am_michael"
    except OSError:
        return os.environ.get("KOKORO_VOICE", "am_michael")


kokoro = Kokoro(os.path.join(HERE, "models/kokoro-v1.0.onnx"), os.path.join(HERE, "models/voices-v1.0.bin"))
KOKORO_VOICES = set(kokoro.get_voices())
LOCK = threading.Lock()  # one line at a time: parallel lines slow each other down past the bot's timeout


def mac_say(text, voice):
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        subprocess.run(["say", "-v", voice, "-r", "190", "-o", f.name, "--file-format=WAVE", "--data-format=LEI16@22050", text],
                       check=True, timeout=20)
        return open(f.name, "rb").read()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            voice = req.get("voice") or default_voice()
            if voice not in KOKORO_VOICES:
                return self.reply(mac_say(str(req["text"])[:600], voice))
            with LOCK:
                samples, rate = kokoro.create(str(req["text"])[:600], voice=voice, speed=float(req.get("speed", 1.05)),
                                              lang="en-gb" if voice.startswith("b") else "en-us")
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
            self.reply(buf.getvalue())
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def reply(self, wav):
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
