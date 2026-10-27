---
title: LiquidChat
emoji: 💧
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 6.30.0
python_version: "3.12"
app_file: app.py
pinned: false
license: apache-2.0
short_description: Meeting transcripts, speakers and minutes for LiquidChat
---

# LiquidChat

The cloud "high accuracy" mode of the [LiquidChat](https://github.com/Mandark-droid/LiquidChat) Android app:
a meeting recording in, a transcript with speaker labels and minutes of meeting out.
Who spoke when is worked out first, then each speaker turn is transcribed, so text is never split across speakers.

| Step | Model |
|---|---|
| Speech to text | `openai/whisper-large-v3`, or `Oriserve/Whisper-Hindi2Hinglish-Prime` for Hindi/English mixed meetings |
| Who spoke when | Silero VAD + `pyannote/wespeaker-voxceleb-resnet34-LM` speaker embeddings, clustered (the same speaker model the app uses on-device) |
| Minutes, action items, Q&A | `google/gemma-4-12B-it` |

**Quota.** Runs on ZeroGPU. Calls made with your Hugging Face token use your own daily ZeroGPU quota
(a 45-minute meeting uses roughly 3 GPU minutes; PRO accounts get 40 minutes a day).

**Privacy.** Uploaded audio is deleted as soon as it has been decoded, nothing from a meeting is
written to the logs (only durations), and the temporary file cache is cleared every 30 minutes.

## API

Endpoints (Gradio API and MCP tools at `/gradio_api/mcp/`).

Long meetings, step by step (each request makes at most one GPU call, so progress can be shown):

- `start(audio_file, identify_speakers, num_speakers)` → `job_id`, number of `parts`, speakers
- `transcribe_part(job_id, part, asr_model, language, task)` for each part
- `finish(job_id)` (the job's audio is kept in memory only, and expires after 30 minutes anyway)

One-shot (fine for recordings up to ~15 minutes):

- `transcribe(audio_file, asr_model, language, task, identify_speakers, num_speakers)`
- `minutes(transcript_json, meeting_context)`
- `process_meeting(audio_file, asr_model, language, task, num_speakers, meeting_context)`
- `ask(question, transcript_json, notes)`
- `chat(messages_json, max_tokens, temperature)`: general Gemma 4 chat (used by the app when a request needs a larger model)

```python
from gradio_client import Client, handle_file
client = Client("kshitijthakkar/LiquidChat", token="hf_...")
result = client.predict(handle_file("meeting.m4a"), "large-v3", "", "transcribe", 0, "", api_name="/process_meeting")
```

Every model is open and ungated: to run your own copy, just duplicate the Space (ZeroGPU hardware).
