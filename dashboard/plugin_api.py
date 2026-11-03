"""Fast Prompt Autocomplete Backend Router (`/api/plugins/prompt-autocomplete`).

Provides:
  - `GET /corpus` — Deduplicated user prompt sentences from `hermes_state.SessionDB`
    so the frontend WebWorker N-gram / Prefix Trie responds in <1ms.
  - `POST /complete` — Ultra-low-latency completion via the public `agent.plugin_llm.PluginLlm`
    facade. When model overrides are permitted in `plugins.entries.prompt-autocomplete.llm`,
    races 4 fast small models in parallel (`qwen/qwen-2.5-7b-instruct`,
    `meta-llama/llama-3.1-8b-instruct`, `meta-llama/llama-4-scout`,
    `google/gemini-3.5-flash-lite`); otherwise routes through the plugin's registered
    `prompt_autocomplete` auxiliary task slot.
"""

from __future__ import annotations

import concurrent.futures
import re
import threading
import time
from typing import Any

from agent.plugin_llm import PluginLlm, PluginLlmTrustError
from fastapi import APIRouter, Body
from hermes_state import SessionDB

router = APIRouter()

_PLUGIN_ID = "prompt-autocomplete"
_TASK_KEY = "prompt_autocomplete"

_AC_LOCK = threading.Lock()
_AC_LLM: PluginLlm | None = None
_AC_WARMED = False
_AC_RESULT_CACHE: dict[tuple[str, str], str] = {}

_AC_RACE_MODELS = (
    "qwen/qwen-2.5-7b-instruct",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-4-scout",
    "google/gemini-3.5-flash-lite",
)

_HEBREW_RE = re.compile(r"[\u0590-\u05FF]")
_LATIN_RE = re.compile(r"[A-Za-z]")


def _get_llm() -> PluginLlm:
    global _AC_LLM, _AC_WARMED
    if _AC_LLM is not None:
        return _AC_LLM
    with _AC_LOCK:
        if _AC_LLM is None:
            _AC_LLM = PluginLlm(plugin_id=_PLUGIN_ID)
        if not _AC_WARMED:
            _AC_WARMED = True
            threading.Thread(target=_warmup_llm, daemon=True).start()
    return _AC_LLM


def _warmup_llm() -> None:
    try:
        llm = _AC_LLM
        if llm is None:
            return
        try:
            llm.complete(
                [{"role": "user", "content": "hi"}],
                model="qwen/qwen-2.5-7b-instruct",
                max_tokens=1,
                timeout=3.0,
                purpose="autocomplete_warmup",
            )
        except PluginLlmTrustError:
            llm.complete(
                [{"role": "user", "content": "hi"}],
                task=_TASK_KEY,
                max_tokens=1,
                timeout=3.0,
                purpose="autocomplete_warmup",
            )
    except Exception:
        pass


def _clean_ac_suffix(raw: str, tail: str, direction: str = "ltr") -> str:
    s = (raw or "").strip().strip("\"'`")
    if not s:
        return ""
    s = s.splitlines()[0].strip()
    clean_tail = tail.strip()
    low_tail = clean_tail.lower()

    if s.lower() in low_tail:
        return ""

    if low_tail and s.lower().startswith(low_tail):
        s = s[len(clean_tail):].lstrip()

    if len(clean_tail) >= 5 and s.lower().startswith(low_tail[:-2]):
        s = s[len(clean_tail) - 2:].lstrip()

    tail_words = clean_tail.split()
    for k in range(min(5, len(tail_words)), 0, -1):
        suffix_words = " ".join(tail_words[-k:]).lower()
        if s.lower().startswith(suffix_words + " "):
            s = s[len(suffix_words):].lstrip()
            break
        if s.lower() == suffix_words:
            return ""

    s = s.strip()
    if direction == "rtl":
        if not _HEBREW_RE.search(s) or _LATIN_RE.search(s):
            return ""
    return s


@router.get("/corpus")
def get_autocomplete_corpus() -> dict[str, Any]:
    """Return deduplicated user prompt sentences from SessionDB + warmup LLM pool."""
    _get_llm()
    phrases: list[str] = []
    seen: set[str] = set()
    db = SessionDB()
    try:
        sessions = db.search_sessions(limit=25)
        for sess in sessions:
            sid = sess.get("id")
            if not sid:
                continue
            for msg in db.get_messages(str(sid)):
                if msg.get("role") != "user":
                    continue
                raw = msg.get("content")
                if not isinstance(raw, str) or raw.startswith("[") or raw.startswith("/"):
                    continue
                for line in re.split(r"[\r\n]+|(?<=[.?!])\s+", raw):
                    clean = re.sub(r"\s+", " ", line).strip()
                    low = clean.lower()
                    if 6 <= len(clean) <= 180 and low not in seen:
                        seen.add(low)
                        phrases.append(clean)
            if len(phrases) >= 400:
                break
    except Exception:
        pass
    finally:
        db.close()

    return {"ok": True, "phrases": phrases[:400], "models": list(_AC_RACE_MODELS)}


@router.post("/complete")
def post_fast_autocomplete(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Fast small-model completion via `PluginLlm`."""
    prefix = str(payload.get("prefix") or "")
    direction = str(payload.get("direction") or "ltr")
    if len(prefix.strip()) < 3:
        return {"ok": True, "suggestion": "", "ms": 0}

    tail = prefix[-180:]
    cache_key = (direction, tail.lower())
    if cache_key in _AC_RESULT_CACHE:
        return {
            "ok": True,
            "suggestion": _AC_RESULT_CACHE[cache_key],
            "model": "cache",
            "ms": 0,
            "cached": True,
        }

    t0 = time.monotonic()
    llm = _get_llm()

    lang_hint = "Hebrew (עברית)" if direction == "rtl" else "English"
    sys_prompt = (
        f"Autocomplete the user's unfinished sentence in {lang_hint} with 2 to 6 words. "
        "Output ONLY the exact untyped continuation suffix. NEVER repeat any words from the input. No quotes."
    )
    msgs = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": tail},
    ]

    def _call_model(model_id: str) -> tuple[str, str]:
        res = llm.complete(
            msgs,
            model=model_id,
            max_tokens=10,
            temperature=0.1,
            timeout=2.2,
            purpose="prompt_autocomplete",
        )
        cleaned = _clean_ac_suffix(res.text, tail, direction)
        if not cleaned or len(cleaned) < 2:
            raise ValueError("empty or echoed")
        return res.model or model_id, cleaned

    # 1) Try parallel small-model race when model override trust is enabled
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=len(_AC_RACE_MODELS))
    futs = [ex.submit(_call_model, m) for m in _AC_RACE_MODELS]
    trust_denied = False
    try:
        for fut in concurrent.futures.as_completed(futs, timeout=2.3):
            try:
                winner_model, suggestion = fut.result()
                ms = int((time.monotonic() - t0) * 1000)
                if len(_AC_RESULT_CACHE) > 500:
                    _AC_RESULT_CACHE.clear()
                _AC_RESULT_CACHE[cache_key] = suggestion
                ex.shutdown(wait=False, cancel_futures=True)
                return {"ok": True, "suggestion": suggestion, "model": winner_model, "ms": ms}
            except PluginLlmTrustError:
                trust_denied = True
            except Exception:
                continue
    except Exception:
        pass
    finally:
        ex.shutdown(wait=False, cancel_futures=True)

    # 2) Fallback: use the plugin's own registered auxiliary task (`prompt_autocomplete`)
    if trust_denied:
        try:
            res = llm.complete(
                msgs,
                task=_TASK_KEY,
                max_tokens=10,
                temperature=0.1,
                timeout=2.5,
                purpose="prompt_autocomplete",
            )
            cleaned = _clean_ac_suffix(res.text, tail, direction)
            if cleaned and len(cleaned) >= 2:
                ms = int((time.monotonic() - t0) * 1000)
                _AC_RESULT_CACHE[cache_key] = cleaned
                return {"ok": True, "suggestion": cleaned, "model": res.model, "ms": ms}
        except Exception:
            pass

    return {"ok": False, "suggestion": "", "ms": int((time.monotonic() - t0) * 1000)}
