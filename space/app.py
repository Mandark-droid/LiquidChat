"""
LiquidChat: the cloud "high accuracy" meetings backend for the LiquidChat Android app.

Who spoke when comes first (Silero VAD, WeSpeaker embeddings, clustering), then each speaker turn
is transcribed by Whisper (large-v3, or a Hinglish fine-tune for Hindi/English meetings), and
Gemma 4 writes the minutes. Every model is open and ungated, so no token is needed to run it.

Runs on ZeroGPU: each GPU call is charged to the caller's own Hugging Face quota (send your
token), so anyone can use this Space or duplicate it.

Privacy: uploaded audio is deleted as soon as it has been read, nothing from a meeting is
logged (only durations and counts), and the temporary file cache is cleared every 30 minutes.
"""

import base64
import json
import os
import re
import secrets
import subprocess
import time

# No usage telemetry from the libraries either.
os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import gradio as gr
import numpy as np
import spaces
import torch
from pyannote.audio import Model as EmbeddingModel
from silero_vad import get_speech_timestamps, load_silero_vad
from sklearn.cluster import AgglomerativeClustering
from transformers import (
    AutoModelForCausalLM,
    AutoModelForMultimodalLM,
    AutoProcessor,
    AutoTokenizer,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)

RATE = 16_000
CLIP_S = 28  # longest piece of one speaker's turn given to Whisper at once
GPU_BATCH_S = 12 * 60  # seconds of speech per transcription GPU call

ASR_IDS = {
    "large-v3": "openai/whisper-large-v3",
    "hinglish": "Oriserve/Whisper-Hindi2Hinglish-Prime",
}
LLM_ID = os.environ.get("LLM_ID", "google/gemma-4-12B-it")
# LiquidAI LFM3-1.7B, offered for minutes/chat next to Gemma 4. Its modelling code ships in the repo
# (trust_remote_code), so it is pinned to a reviewed commit.
LFM3_ID, LFM3_REV = "LiquidAI/LFM3-1.7B", "40ebe0aa6662c9d40389c2f5d565b6a2c6aebacd"
EMBEDDING_ID = "pyannote/wespeaker-voxceleb-resnet34-LM"  # the same speaker model the app uses on-device

# Speaker windows and clustering (cosine similarity, average linkage, as in the app).
WIN_S, HOP_S = 2.0, 0.5
SAME_SPEAKER = 0.25
# A voice needs this share of the talking time to count as a speaker; smaller clusters are fragments
# of real voices (a cough, crosstalk, a voice through a laptop speaker) and join the nearest one.
MIN_SPEAKER_SHARE = 0.05

# Loaded once at start-up; ZeroGPU attaches a GPU only while a @spaces.GPU function runs.
ASR = {
    key: (
        WhisperProcessor.from_pretrained(mid),
        WhisperForConditionalGeneration.from_pretrained(mid, dtype=torch.float16).to("cuda"),
    )
    for key, mid in ASR_IDS.items()
}
EMB = EmbeddingModel.from_pretrained(EMBEDDING_ID).to("cuda").eval()
VAD = load_silero_vad()
PROC = AutoProcessor.from_pretrained(LLM_ID)
LLM = AutoModelForMultimodalLM.from_pretrained(LLM_ID, dtype=torch.bfloat16).to("cuda")
LFM3_TOK = AutoTokenizer.from_pretrained(LFM3_ID, revision=LFM3_REV, trust_remote_code=True)
LFM3 = AutoModelForCausalLM.from_pretrained(
    LFM3_ID, revision=LFM3_REV, trust_remote_code=True, dtype=torch.bfloat16
).to("cuda")


# ---------------------------------------------------------------------------
# Audio


# Real audio/video containers only. Playlists (hls), concat lists and similar formats make ffmpeg open
# other files or URLs, which a public Space must never do.
ALLOWED_FORMATS = {"mov", "mp4", "m4a", "3gp", "3g2", "mj2", "mp3", "wav", "ogg", "flac", "aac", "matroska", "webm", "amr", "asf"}


def load_audio(path: str) -> np.ndarray:
    """Any common audio format -> 16 kHz mono float32. The upload is deleted right after."""
    only_this_file = ["-protocol_whitelist", "file"]
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", *only_this_file, "-show_entries", "format=format_name", "-of", "csv=p=0", path],
            capture_output=True,
            text=True,
            timeout=60,
        )
        formats = set(probe.stdout.strip().split(","))
        if probe.returncode != 0 or not formats & ALLOWED_FORMATS:
            raise gr.Error("That file is not a supported recording (m4a, mp3, wav, aac, ogg, flac, webm).")
        raw = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", *only_this_file, "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
            check=True,
            capture_output=True,
            timeout=900,
        ).stdout
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    audio = np.frombuffer(raw, dtype=np.float32).copy()
    if not len(audio):
        raise gr.Error("Could not read any audio from that file.")
    return audio


def speech_regions(audio: np.ndarray) -> list:
    """[(start_s, end_s)] of speech, on the CPU (no GPU quota)."""
    ts = get_speech_timestamps(
        torch.from_numpy(audio),
        VAD,
        sampling_rate=RATE,
        min_speech_duration_ms=300,
        min_silence_duration_ms=400,
        speech_pad_ms=120,
        return_seconds=True,
    )
    return [(float(t["start"]), float(t["end"])) for t in ts]


# ---------------------------------------------------------------------------
# Who spoke when


def _windows(regions: list) -> list:
    out = []
    for a, b in regions:
        if b - a <= WIN_S:
            out.append((a, b))
            continue
        t = a
        while t + WIN_S <= b:
            out.append((t, t + WIN_S))
            t += HOP_S
        if out[-1][1] < b:
            out.append((b - WIN_S, b))
    return out


def _embed_seconds(audio, windows):
    return int(20 + len(windows) / 400)


@spaces.GPU(duration=_embed_seconds)
def _embed(audio: np.ndarray, windows: list) -> np.ndarray:
    t = time.time()
    n = int(WIN_S * RATE)
    vecs = []
    for i in range(0, len(windows), 256):
        batch = np.zeros((len(windows[i : i + 256]), 1, n), dtype=np.float32)
        for j, (a, b) in enumerate(windows[i : i + 256]):
            clip = audio[int(a * RATE) : int(b * RATE)][:n]
            batch[j, 0, : len(clip)] = clip
        with torch.inference_mode():
            vecs.append(EMB(torch.from_numpy(batch).to("cuda")).float().cpu().numpy())
    print(f"_embed: {len(windows)} windows in {time.time() - t:.1f}s")
    return np.concatenate(vecs) if vecs else np.zeros((0, 256), dtype=np.float32)


def _cluster(vecs: np.ndarray, num_speakers: int, max_speakers: int = 0) -> np.ndarray:
    if len(vecs) < 2:
        return np.zeros(len(vecs), dtype=int)
    x = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9)
    if num_speakers:
        cl = AgglomerativeClustering(n_clusters=min(num_speakers, len(x)), metric="cosine", linkage="average")
    else:
        cl = AgglomerativeClustering(
            n_clusters=None, metric="cosine", linkage="average", distance_threshold=1 - SAME_SPEAKER
        )
    labels = cl.fit_predict(x)
    if not num_speakers and max_speakers and len(set(labels)) > max_speakers:
        labels = AgglomerativeClustering(
            n_clusters=min(max_speakers, len(x)), metric="cosine", linkage="average"
        ).fit_predict(x)
    # Tiny clusters are noise (a cough, crosstalk): give them to the nearest real speaker.
    counts = np.bincount(labels)
    big = [k for k in range(len(counts)) if counts[k] >= max(4, MIN_SPEAKER_SHARE * len(x))] or [int(counts.argmax())]
    cents = {k: x[labels == k].mean(0) for k in big}
    for i, k in enumerate(labels):
        if k not in cents:
            labels[i] = max(cents, key=lambda c: float(x[i] @ cents[c]))
    # Number speakers by first appearance: SPEAKER_00 talks first.
    order = {}
    for k in labels:
        order.setdefault(k, len(order))
    return np.array([order[k] for k in labels])


def _turns(regions: list, windows: list, labels: np.ndarray) -> list:
    """Speaker turns at 0.25 s resolution: each instant goes to the majority of windows covering it."""
    step = 0.25
    turns = []
    wi = 0
    for a, b in regions:
        frames = np.arange(a, b, step)
        votes = [{} for _ in frames]
        while wi < len(windows) and windows[wi][1] <= a + 1e-6:
            wi += 1
        j = wi
        while j < len(windows) and windows[j][0] < b:
            wa, wb = windows[j]
            lo, hi = int(max(0, (wa - a) / step)), int(min(len(frames), np.ceil((wb - a) / step)))
            for f in range(lo, hi):
                votes[f][labels[j]] = votes[f].get(labels[j], 0) + 1
            j += 1
        prev = None
        for f, t0 in enumerate(frames):
            spk = max(votes[f], key=votes[f].get) if votes[f] else prev
            if spk is None:
                continue
            if turns and turns[-1]["speaker"] == spk and t0 - turns[-1]["end"] < 0.6:
                turns[-1]["end"] = min(b, t0 + step)
            else:
                turns.append({"start": float(t0), "end": float(min(b, t0 + step)), "speaker": spk})
            prev = spk
    # A short flip between two stretches of the same voice (A, b, A) is that voice; then join
    # what is left of the same speaker.
    for i in range(1, len(turns) - 1):
        t, a, b = turns[i], turns[i - 1], turns[i + 1]
        if t["end"] - t["start"] < 1.2 and a["speaker"] == b["speaker"] != t["speaker"]:
            t["speaker"] = a["speaker"]
    out = []
    for t in turns:
        if out and (t["end"] - t["start"] < 0.5 or out[-1]["speaker"] == t["speaker"]) and t["start"] - out[-1]["end"] < 0.6:
            out[-1]["end"] = t["end"]
        else:
            out.append(dict(t))
    return [{**t, "speaker": f"SPEAKER_{t['speaker']:02d}"} for t in out]


def who_spoke_when(audio: np.ndarray, regions: list, num_speakers: int, max_speakers: int = 0) -> list:
    windows = _windows(regions)
    if not windows:
        return []
    labels = _cluster(_embed(audio, windows), num_speakers, max_speakers)
    return _turns(regions, windows, labels)


# ---------------------------------------------------------------------------
# Speech to text, one speaker turn at a time


def _clips(turns: list) -> list:
    """Whisper-sized pieces: a turn longer than CLIP_S is split, short turns of the same speaker joined."""
    clips = []
    for t in turns:
        a = t["start"]
        while a < t["end"] - 0.2:
            b = min(t["end"], a + CLIP_S)
            last = clips[-1] if clips else None
            if last and last["speaker"] == t["speaker"] and a - last["end"] < 1.0 and b - last["start"] <= CLIP_S:
                last["end"] = b
            else:
                clips.append({"start": a, "end": b, "speaker": t["speaker"]})
            a = b
    return clips


def _asr_seconds(audio, clips, model, language, task):
    return int(25 + sum(c["end"] - c["start"] for c in clips) / 60 * 5)


@spaces.GPU(duration=_asr_seconds)
def _asr(audio: np.ndarray, clips: list, model: str, language: str, task: str) -> list:
    """Batched Whisper over speaker-turn clips, with temperature fallback against repetition loops."""
    t = time.time()
    proc, mdl = ASR[model]
    kwargs = {"task": task}
    if model == "hinglish":
        kwargs = {"task": "transcribe", "language": "en"}  # how the fine-tune was trained
    elif language:
        kwargs["language"] = language
    texts = []
    for i in range(0, len(clips), 16):
        batch = clips[i : i + 16]
        feats = proc(
            [audio[int(c["start"] * RATE) : int(c["end"] * RATE)] for c in batch],
            sampling_rate=RATE,
            return_tensors="pt",
            return_attention_mask=True,
        ).to("cuda", torch.float16)
        out = mdl.generate(
            **feats,
            **kwargs,
            max_new_tokens=220,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8),
            compression_ratio_threshold=1.8,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6,
        )
        seqs = out["sequences"] if isinstance(out, dict) else out
        texts += proc.batch_decode(seqs, skip_special_tokens=True)
    print(f"_asr: {len(clips)} clips, {sum(c['end'] - c['start'] for c in clips) / 60:.1f} min speech in {time.time() - t:.1f}s")
    return [{**c, "text": _clean(x)} for c, x in zip(clips, texts)]


def _clean(text: str) -> str:
    """Drops what is left of decoder loops ("bhi bhi bhi ...") after the fallback."""
    t = re.sub(r"\s+", " ", text or "").strip()
    if t.lower() in {"nan", "none", "null"}:
        return ""
    words = t.lower().split()
    if len(words) >= 12 and len(set(words)) / len(words) < 0.25:
        return ""
    return re.sub(r"\b(\w+(?:\s+\w+){0,3})(?:\s+\1\b){3,}", r"\1 \1", t, flags=re.I)


def _llm_seconds(messages, max_new_tokens, temperature=0.0, model="gemma"):
    # Measured: Gemma 4 12B ~15 tok/s out plus ~10 s to read a 45-minute transcript; LFM3 is faster.
    return int(30 + max_new_tokens / (40 if model == "lfm3" else 14))


@spaces.GPU(duration=_llm_seconds)
def _generate(messages: list, max_new_tokens: int, temperature: float = 0.0, model: str = "gemma") -> str:
    t = time.time()
    if model == "lfm3":
        # Reasoning is on by default and spends the whole budget before writing minutes.
        ids = LFM3_TOK.apply_chat_template(
            messages, add_generation_prompt=True, return_tensors="pt", return_dict=True, enable_thinking=False
        ).to("cuda")
        sample = {"do_sample": True, "temperature": max(temperature, 0.1), "top_k": 50} if temperature > 0 else {"do_sample": False}
        out = LFM3.generate(**ids, max_new_tokens=max_new_tokens, repetition_penalty=1.05, **sample)
        n_in = ids["input_ids"].shape[-1]
        print(f"_generate[lfm3]: {n_in} in, {out.shape[-1] - n_in} out tokens in {time.time() - t:.1f}s")
        text = LFM3_TOK.decode(out[0][n_in:], skip_special_tokens=False)
        text = text.split("</think>")[-1]  # the opening <think> is part of the prompt
        return re.sub(r"<\|[^|>]*\|>", "", text).strip()
    inputs = PROC.apply_chat_template(
        messages,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
        add_generation_prompt=True,
        enable_thinking=False,
    ).to(LLM.device)
    sample = {"do_sample": True, "temperature": temperature, "top_p": 0.95} if temperature > 0 else {"do_sample": False}
    out = LLM.generate(**inputs, max_new_tokens=max_new_tokens, **sample)
    n_in, n_out = inputs["input_ids"].shape[-1], out.shape[-1] - inputs["input_ids"].shape[-1]
    print(f"_generate: {n_in} in, {n_out} out tokens in {time.time() - t:.1f}s")
    return PROC.decode(out[0][n_in:], skip_special_tokens=True).strip()


# ---------------------------------------------------------------------------
# Assembly


def _clock(s: float) -> str:
    s = int(s or 0)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def _plan(audio: np.ndarray, diarize: bool, num_speakers: int, max_speakers: int = 0):
    """Who spoke when, cut into Whisper-sized clips and grouped into GPU-call-sized parts."""
    timings = {}
    t = time.time()
    regions = speech_regions(audio)
    timings["vad_s"] = round(time.time() - t, 1)
    if diarize:
        t = time.time()
        turns = who_spoke_when(audio, regions, int(num_speakers or 0), int(max_speakers or 0))
        timings["speakers_s"] = round(time.time() - t, 1)
    else:
        turns = [{"start": a, "end": b, "speaker": ""} for a, b in regions]
    parts, batch, secs = [], [], 0.0
    for c in _clips(turns):
        if batch and secs + c["end"] - c["start"] > GPU_BATCH_S:
            parts.append(batch)
            batch, secs = [], 0.0
        batch.append(c)
        secs += c["end"] - c["start"]
    if batch:
        parts.append(batch)
    return parts, timings


def _tidy(segments: list) -> list:
    return [
        {"start": round(s["start"], 2), "end": round(s["end"], 2), "speaker": s["speaker"], "text": s["text"]}
        for s in segments
        if s["text"]
    ]


def _transcribe(audio: np.ndarray, model: str, language: str, task: str, diarize: bool, num_speakers: int):
    parts, timings = _plan(audio, diarize, num_speakers)
    t = time.time()
    segments = []
    for part in parts:
        segments += _asr(audio, part, model, language, task)
    timings["transcribe_s"] = round(time.time() - t, 1)
    segments = _tidy(segments)
    return segments, sorted({s["speaker"] for s in segments if s["speaker"]}), timings


# Step-by-step jobs for long meetings: each request does at most one GPU call, so it finishes well
# within the caller's quota token, and the client can show progress. Decoded audio stays in memory
# only (never on disk) and is dropped on finish or after JOB_TTL_S.
JOBS: dict = {}
JOB_TTL_S = 30 * 60


def _job(job_id: str) -> dict:
    now = time.time()
    for k in [k for k, j in JOBS.items() if j["expires"] < now]:
        JOBS.pop(k, None)
    job = JOBS.get(job_id)
    if not job:
        raise gr.Error("This job has expired or finished. Start again.")
    return job


MINUTES_SYSTEM = (
    "You write accurate minutes of meeting (MoM) for a professional services team. Use only what "
    "the transcript says; never invent names, numbers or dates. The transcript may mix Hindi, "
    "Hinglish and English and may contain recognition errors; infer the intended meaning but stay "
    "faithful. Always write in English. Reply with one JSON object and nothing else."
)


def _transcript_text(segments: list, names: dict | None = None) -> str:
    names = names or {}
    return "\n".join(
        f"[{_clock(s['start'])}] {names.get(s.get('speaker'), s.get('speaker') or 'Speaker')}: {s['text']}"
        for s in segments
    )


def _parse_json(raw: str) -> dict:
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise gr.Error("The model did not return minutes. Try again.")
    return _no_placeholders(json.loads(raw[start : end + 1]))


_PLACEHOLDER = re.compile(r"^(empty|none|n/?a|null|unknown|-|not (mentioned|specified|stated))$", re.I)


def _no_placeholders(v):
    """Small models copy template words ("empty", "SPEAKER_00" as a name) into fields."""
    if isinstance(v, dict):
        out = {k: _no_placeholders(x) for k, x in v.items()}
        if isinstance(out.get("speaker_names"), dict):
            out["speaker_names"] = {k: ("" if n == k else n) for k, n in out["speaker_names"].items()}
        return out
    if isinstance(v, list):
        return [_no_placeholders(x) for x in v]
    if isinstance(v, str) and _PLACEHOLDER.match(v.strip()):
        return ""
    return v


def _minutes(segments: list, context: str, model: str = "gemma") -> dict:
    prompt = f"""Meeting context (may be empty):
{context or "-"}

Transcript (each line: [time] SPEAKER: text):
\"\"\"
{_transcript_text(segments)}
\"\"\"

Return JSON with exactly these keys:
{{"title": "short title, max 8 words",
 "summary": "3-5 sentence executive summary",
 "speaker_names": {{"SPEAKER_00": "real name if the transcript makes it clear (introductions, being addressed by name), else empty"}},
 "key_points": ["main discussion point"],
 "decisions": ["decision that was agreed"],
 "action_items": [{{"task": "concrete commitment", "owner": "person's name, or the SPEAKER label if the name is unknown, or empty", "due": "deadline as said, or empty", "priority": "high|medium|low", "time": "mm:ss where it was agreed"}}],
 "open_questions": ["unresolved question"],
 "next_steps": ["next step"]}}

Rules: an action item is something a person committed to or was asked to do. The owner is the person who will do it: when someone says "I will" the owner is that line's speaker; when someone asks another person and they agree, the owner is the person who agreed. Use [] for empty lists."""
    raw = _generate([{"role": "system", "content": MINUTES_SYSTEM}, {"role": "user", "content": prompt}], 1400, 0.0, model)
    return _parse_json(raw)


# ---------------------------------------------------------------------------
# Public API (also exposed as MCP tools)


def transcribe(
    audio_file: str,
    asr_model: str = "large-v3",
    language: str = "",
    task: str = "transcribe",
    identify_speakers: bool = True,
    num_speakers: int = 0,
) -> dict:
    """Transcribe a meeting recording, with speaker labels.

    Args:
        audio_file: The recording (m4a, mp3, wav, aac, ...).
        asr_model: "large-v3" (99 languages) or "hinglish" (Hindi/English code-mixed speech, written in Latin script).
        language: ISO code such as "en" or "hi"; empty to auto-detect.
        task: "transcribe" keeps the spoken language; "translate" outputs English.
        identify_speakers: Label who is speaking (SPEAKER_00, SPEAKER_01, ...).
        num_speakers: Number of people if known; 0 to estimate.

    Returns:
        {"segments": [{"start", "end", "speaker", "text"}], "speakers": [...], "duration_s", "timings"}
    """
    if asr_model not in ASR:
        raise gr.Error(f"asr_model must be one of {sorted(ASR)}")
    audio = load_audio(audio_file)
    segments, speakers, timings = _transcribe(audio, asr_model, language.strip(), task, identify_speakers, num_speakers)
    print(f"transcribe: {len(audio) / RATE / 60:.1f} min audio, {timings}")
    return {"segments": segments, "speakers": speakers, "duration_s": round(len(audio) / RATE, 1), "timings": timings}


def start(audio_file: str, identify_speakers: bool = True, num_speakers: int = 0, max_speakers: int = 0) -> dict:
    """Step 1 of a long meeting: read the recording and work out who spoke when.

    Args:
        audio_file: The recording (m4a, mp3, wav, aac, ...).
        identify_speakers: Label who is speaking (SPEAKER_00, SPEAKER_01, ...).
        num_speakers: Number of people if known; 0 to estimate.
        max_speakers: When estimating, never report more voices than this (e.g. attendees + 1); 0 for no limit.

    Returns:
        {"job_id", "parts": number of transcribe_part calls to make, "speakers", "duration_s", "speech_s", "timings"}
    """
    audio = load_audio(audio_file)
    parts, timings = _plan(audio, identify_speakers, num_speakers, max_speakers)
    job_id = secrets.token_urlsafe(16)
    JOBS[job_id] = {"audio": audio, "parts": parts, "expires": time.time() + JOB_TTL_S}
    speakers = sorted({c["speaker"] for p in parts for c in p if c["speaker"]})
    speech = sum(c["end"] - c["start"] for p in parts for c in p)
    print(f"start: {len(audio) / RATE / 60:.1f} min audio, {len(parts)} parts, {len(speakers)} speakers, {timings}")
    return {
        "job_id": job_id,
        "parts": len(parts),
        "speakers": speakers,
        "duration_s": round(len(audio) / RATE, 1),
        "speech_s": round(speech, 1),
        "timings": timings,
    }


def transcribe_part(job_id: str, part: int, asr_model: str = "hinglish", language: str = "", task: str = "transcribe") -> dict:
    """Step 2: transcribe one part of a started job (call for part = 0 .. parts-1).

    Args:
        job_id: From `start`.
        part: Which part, from 0.
        asr_model: "hinglish" (Hindi/English mixed, Latin script) or "large-v3" (99 languages).
        language: ISO code for large-v3, or empty to auto-detect.
        task: "transcribe" or "translate" (large-v3 only).

    Returns:
        {"segments": [{"start", "end", "speaker", "text"}], "part", "parts"}
    """
    if asr_model not in ASR:
        raise gr.Error(f"asr_model must be one of {sorted(ASR)}")
    job = _job(job_id)
    part = int(part)
    if not 0 <= part < len(job["parts"]):
        raise gr.Error("No such part.")
    job["expires"] = time.time() + JOB_TTL_S
    segments = _tidy(_asr(job["audio"], job["parts"][part], asr_model, language.strip(), task))
    return {"segments": segments, "part": part, "parts": len(job["parts"])}


def finish(job_id: str) -> bool:
    """Step 3: discard the job's audio from memory (it also expires on its own after 30 minutes).

    Args:
        job_id: From `start`.

    Returns:
        True if the job existed.
    """
    return JOBS.pop(job_id, None) is not None


def minutes(transcript_json: str, meeting_context: str = "", model: str = "gemma") -> dict:
    """Write minutes of meeting (summary, decisions, action items with owners) from a transcript.

    Args:
        transcript_json: JSON from `transcribe`, or a list of {"start", "end", "speaker", "text"}.
        meeting_context: Optional title, date, attendees and agenda, as plain text.
        model: "gemma" (Gemma 4 12B) or "lfm3" (LiquidAI LFM3-1.7B).

    Returns:
        {"title", "summary", "speaker_names", "key_points", "decisions", "action_items", "open_questions", "next_steps"}
    """
    data = json.loads(transcript_json)
    segments = data["segments"] if isinstance(data, dict) else data
    if not segments:
        raise gr.Error("The transcript is empty.")
    t = time.time()
    out = _minutes(segments, meeting_context, "lfm3" if model == "lfm3" else "gemma")
    print(f"minutes: {len(segments)} segments, {time.time() - t:.1f}s")
    return out


def process_meeting(
    audio_file: str,
    asr_model: str = "large-v3",
    language: str = "",
    task: str = "transcribe",
    num_speakers: int = 0,
    meeting_context: str = "",
) -> dict:
    """Recording in, finished minutes out: transcript with speakers, then minutes.

    Args:
        audio_file: The recording (m4a, mp3, wav, aac, ...).
        asr_model: "large-v3" or "hinglish".
        language: ISO code, or empty to auto-detect.
        task: "transcribe" or "translate".
        num_speakers: Number of people if known; 0 to estimate.
        meeting_context: Optional title, date, attendees and agenda.

    Returns:
        {"segments", "speakers", "minutes", "duration_s", "timings"}
    """
    result = transcribe(audio_file, asr_model, language, task, True, num_speakers)
    if result["segments"]:
        t = time.time()
        result["minutes"] = _minutes(result["segments"], meeting_context)
        result["timings"]["minutes_s"] = round(time.time() - t, 1)
    print(f"process_meeting: {result['timings']}")
    return result


def ask(question: str, transcript_json: str, notes: str = "") -> str:
    """Answer a question about a meeting from its transcript.

    Args:
        question: The question.
        transcript_json: JSON from `transcribe` (or a list of segments).
        notes: Optional minutes or context to consider too.

    Returns:
        A short answer citing times like [12:30], or a statement that it was not discussed.
    """
    data = json.loads(transcript_json)
    segments = data["segments"] if isinstance(data, dict) else data
    user = f"Notes:\n{notes or '-'}\n\nTranscript:\n\"\"\"\n{_transcript_text(segments)}\n\"\"\"\n\nQuestion: {question}"
    return _generate(
        [
            {
                "role": "system",
                "content": "Answer questions about this meeting using only the transcript and notes. "
                "Name who said or owns something and cite times like [12:30]. If it was not discussed, say so. "
                "Answer in English, briefly.",
            },
            {"role": "user", "content": user},
        ],
        500,
    )


def chat(messages_json: str, max_tokens: int = 1024, temperature: float = 0.3, model: str = "gemma") -> str:
    """General chat completion with Gemma 4 (the LiquidChat app routes requests that need a larger model here).

    Args:
        messages_json: JSON list of {"role": "system"|"user"|"assistant", "content": "..."}.
        max_tokens: Maximum tokens to generate (up to 4096).
        temperature: 0 for deterministic output.
        model: "gemma" (Gemma 4 12B) or "lfm3" (LiquidAI LFM3-1.7B).

    Returns:
        The assistant's reply.
    """
    msgs = [
        {"role": m["role"], "content": str(m.get("content", ""))}
        for m in json.loads(messages_json)
        if m.get("role") in ("system", "user", "assistant")
    ]
    if not msgs or msgs[-1]["role"] != "user":
        raise gr.Error("The last message must be from the user.")
    return _generate(
        msgs, max(16, min(int(max_tokens or 1024), 4096)), float(temperature or 0), "lfm3" if model == "lfm3" else "gemma"
    )


# ---------------------------------------------------------------------------
# UI (LiquidChat branding: the app's logo and desert palette)

_LOGO = base64.b64encode(open(os.path.join(os.path.dirname(__file__), "liquidchat_logo.png"), "rb").read()).decode()

CSS = """
:root, .dark { --lc-brown: #3A2E22; --lc-green: #4A6741; --lc-blue: #3A8FB7; --lc-sand: #F5E6CA; --lc-sand2: #F0DDB8; }
.gradio-container { background: var(--lc-sand) !important; }
#lc-header { display: flex; align-items: center; gap: 16px; background: var(--lc-brown); color: #fff;
  padding: 14px 20px; border-radius: 14px; }
#lc-header img { width: 64px; height: 64px; border-radius: 14px; }
#lc-header h1 { margin: 0; color: #fff; font-size: 28px; }
#lc-header p { margin: 2px 0 0; color: #F0DDB8; }
#lc-footer { text-align: center; color: #6B5D4F; font-size: 13px; padding: 8px; }
#lc-footer img { width: 20px; height: 20px; vertical-align: middle; border-radius: 5px; margin-right: 6px; }
"""

THEME = gr.themes.Soft(primary_hue="green", secondary_hue="blue", neutral_hue="stone").set(
    button_primary_background_fill="#4A6741",
    button_primary_background_fill_hover="#3D5636",
    button_primary_text_color="#FFFFFF",
    block_background_fill="#FFFFFF",
    block_border_color="#D4C4A8",
    color_accent="#3A8FB7",
    link_text_color="#3A8FB7",
)

HEADER = f"""<div id="lc-header"><img src="data:image/png;base64,{_LOGO}" alt="LiquidChat logo"/>
<div><h1>LiquidChat</h1><p>Meeting recording in: transcript with speakers and minutes of meeting out.</p></div></div>"""

FOOTER = f"""<div id="lc-footer"><img src="data:image/png;base64,{_LOGO}" alt=""/>Generated using
<a href="https://github.com/Mandark-droid/LiquidChat">LiquidChat</a> · runs on ZeroGPU with your own Hugging Face quota ·
recordings are deleted after reading and nothing from a meeting is logged.</div>"""


def _ui(audio_file, asr_model, language, num_speakers):
    if not audio_file:
        raise gr.Error("Upload a recording first.")
    r = process_meeting(audio_file, asr_model, language, "transcribe", int(num_speakers or 0))
    m = r.get("minutes") or {}
    names = {k: v for k, v in (m.get("speaker_names") or {}).items() if v}
    md = [f"## {m.get('title', 'Meeting')}", m.get("summary", "")]
    for key, label in [("decisions", "Decisions"), ("key_points", "Key points"), ("open_questions", "Open questions")]:
        if m.get(key):
            md += [f"### {label}"] + [f"- {x}" for x in m[key]]
    if m.get("action_items"):
        md += ["### Action items", "| Task | Owner | Due |", "|---|---|---|"]
        md += [f"| {a.get('task', '')} | {names.get(a.get('owner'), a.get('owner', ''))} | {a.get('due', '')} |" for a in m["action_items"]]
    md += ["", "---", "*Generated using LiquidChat*"]
    notes = chr(10).join(md)
    return notes, _transcript_text(r["segments"], names), r, {"segments": r["segments"], "notes": notes}


def _ask_ui(question, meeting):
    if not meeting:
        raise gr.Error("Process a recording in the Meeting notes tab first.")
    if not (question or "").strip():
        raise gr.Error("Type a question.")
    return ask(question, json.dumps({"segments": meeting["segments"]}, ensure_ascii=False), meeting["notes"])


def _chat_ui(message, history):
    msgs = [{"role": h["role"], "content": h["content"]} for h in history if isinstance(h.get("content"), str)]
    msgs.append({"role": "user", "content": message})
    return chat(json.dumps(msgs, ensure_ascii=False), 1024, 0.3)


with gr.Blocks(title="LiquidChat", analytics_enabled=False, delete_cache=(1800, 1800)) as demo:
    gr.HTML(HEADER)
    gr.Markdown(
        "The cloud mode of the [LiquidChat](https://github.com/Mandark-droid/LiquidChat) Android app: meeting "
        "notes, questions about a meeting, and chat with Gemma 4."
    )
    meeting = gr.State(None)
    with gr.Tabs():
        with gr.Tab("Meeting notes"):
            with gr.Row():
                with gr.Column():
                    f = gr.Audio(type="filepath", label="Recording")
                    m = gr.Radio(
                        [("Hindi + English", "hinglish"), ("Whisper large-v3 (other languages)", "large-v3")],
                        value="hinglish",
                        label="Speech model",
                    )
                    lang = gr.Textbox(label="Language code for large-v3 (empty = auto)", value="")
                    n = gr.Number(label="Number of speakers (0 = estimate)", value=0, precision=0)
                    go = gr.Button("Process", variant="primary")
                with gr.Column():
                    md = gr.Markdown()
                    tx = gr.Textbox(label="Transcript", lines=16)
                    js = gr.JSON(label="Raw result")
            go.click(_ui, [f, m, lang, n], [md, tx, js, meeting], api_name=False)
        with gr.Tab("Ask about the meeting"):
            gr.Markdown("Questions about the recording processed in the Meeting notes tab. Gemma 4 reads the whole transcript.")
            q = gr.Textbox(label="Question", placeholder="Who is sharing the Netscope logs, and by when?")
            ask_btn = gr.Button("Ask", variant="primary")
            answer = gr.Markdown()
            ask_btn.click(_ask_ui, [q, meeting], answer, api_name=False)
            q.submit(_ask_ui, [q, meeting], answer, api_name=False)
        with gr.Tab("Chat"):
            gr.ChatInterface(
                _chat_ui,
                chatbot=gr.Chatbot(height=460, label="Gemma 4"),
                textbox=gr.Textbox(placeholder="Ask anything", container=False),
                api_name=False,
            )
    gr.HTML(FOOTER)

    # API endpoints (and MCP tools). File inputs are real components so clients can upload.
    with gr.Column(visible=False):
        a_file = gr.Audio(type="filepath")
        a_model = gr.Textbox(value="large-v3")
        a_lang = gr.Textbox(value="")
        a_task = gr.Textbox(value="transcribe")
        a_spk = gr.Checkbox(value=True)
        a_n = gr.Number(value=0, precision=0)
        a_ctx = gr.Textbox(value="")
        a_tr = gr.Textbox()
        a_q = gr.Textbox()
        a_notes = gr.Textbox(value="")
        out_json = gr.JSON()
        out_text = gr.Textbox()
        gr.Button().click(transcribe, [a_file, a_model, a_lang, a_task, a_spk, a_n], out_json, api_name="transcribe")
        a_job = gr.Textbox()
        a_part = gr.Number(value=0, precision=0)
        out_bool = gr.Checkbox()
        a_max_spk = gr.Number(value=0, precision=0)
        gr.Button().click(start, [a_file, a_spk, a_n, a_max_spk], out_json, api_name="start")
        gr.Button().click(transcribe_part, [a_job, a_part, a_model, a_lang, a_task], out_json, api_name="transcribe_part")
        gr.Button().click(finish, [a_job], out_bool, api_name="finish")
        a_llm = gr.Textbox(value="gemma")
        gr.Button().click(minutes, [a_tr, a_ctx, a_llm], out_json, api_name="minutes")
        gr.Button().click(process_meeting, [a_file, a_model, a_lang, a_task, a_n, a_ctx], out_json, api_name="process_meeting")
        gr.Button().click(ask, [a_q, a_tr, a_notes], out_text, api_name="ask")
        a_msgs = gr.Textbox()
        a_max = gr.Number(value=1024, precision=0)
        a_temp = gr.Number(value=0.3)
        gr.Button().click(chat, [a_msgs, a_max, a_temp, a_llm], out_text, api_name="chat")

demo.queue(default_concurrency_limit=2).launch(mcp_server=True, ssr_mode=False, theme=THEME, css=CSS)
