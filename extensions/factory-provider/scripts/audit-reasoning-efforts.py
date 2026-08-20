#!/usr/bin/env python3
"""Audit Factory reasoning_effort acceptance for Fireworks-backed chat models.

Reads Factory's direct API key from the environment, Pi auth, or the optional
rotation-key file and sends tiny streaming requests. This is a manual diagnostic
script; do not run on Pi startup/reload.
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_key():
    if key := os.environ.get("FACTORY_API_KEY", "").strip():
        return key
    auth_path = Path.home() / ".pi" / "agent" / "auth.json"
    if auth_path.exists():
        factory = json.loads(auth_path.read_text()).get("factory", {})
        if factory.get("type") == "api_key" and factory.get("key"):
            return factory["key"]
    key_path = ROOT / "factory-api-keys.json"
    if key_path.exists():
        entries = json.loads(key_path.read_text()).get("keys", [])
        if entries:
            entry = entries[0]
            return entry if isinstance(entry, str) else entry.get("key")
    raise SystemExit("No Factory API key found")


def droid_version():
    binary = os.environ.get("FACTORY_DROID_BINARY") or os.environ.get("DROID_BINARY") or "droid"
    try:
        return subprocess.check_output([binary, "--version"], text=True, timeout=5).strip() or "0.199.0"
    except (OSError, subprocess.SubprocessError):
        return "0.199.0"


KEY = load_key()
DROID_VERSION = droid_version()
MODELS = ["deepseek-v4-flash-0731", "deepseek-v4-pro", "glm-5.2", "glm-5.2-fast", "inkling", "kimi-k3", "nemotron-3-ultra"]
EFFORTS = ["none", "off", "low", "medium", "high", "xhigh", "max"]

for model in MODELS:
    print(f"\nMODEL {model}")
    for effort in EFFORTS:
        body = {
            "model": model,
            "max_tokens": 8,
            "stream": True,
            "reasoning_effort": effort,
            "messages": [{"role": "user", "content": "Say ok"}],
        }
        req = urllib.request.Request(
            "https://api.factory.ai/api/llm/o/v1/chat/completions",
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {KEY}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "X-Factory-Client": "cli",
                "X-Client-Version": DROID_VERSION,
                "User-Agent": f"factory-cli/{DROID_VERSION}",
                "x-api-provider": "fireworks",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                response.read(500)
                print(f"{effort:>6} {response.status} OK")
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace").replace("\n", " ")[:240]
            print(f"{effort:>6} {error.code} {text}")
        except Exception as error:
            print(f"{effort:>6} EXC {type(error).__name__}: {str(error)[:160]}")
        time.sleep(0.2)
