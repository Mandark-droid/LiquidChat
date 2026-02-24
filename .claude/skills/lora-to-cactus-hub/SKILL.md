---
name: lora-to-cactus-hub
description: Merge a trained LoRA adapter into the base model, convert to Cactus binary format for mobile deployment, and push to Hugging Face Hub. Use after training completes with /unsloth-jobs-training.
argument-hint: [lora-repo-id]
disable-model-invocation: true
allowed-tools: Bash
---

Merge a LoRA adapter into the base model, convert to Cactus format, and push to Hub.

## What is Cactus format

Cactus is a custom optimized binary format (84-byte CACT header + quantized tensors) for efficient on-device inference. It is the native runtime for the LiquidChat Android app via `cactus-react-native`.

Quantization options:
- **INT8** — Recommended default. ~50% size reduction, minimal quality loss.
- **INT4** — Maximum compression, slight quality trade-off. For low-RAM devices.
- **FP16** — Full precision, larger file. For testing only.

## Arguments

`$ARGUMENTS` should be the LoRA adapter repo ID (e.g. `kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora`).
If not provided, ask the user for the LoRA repo and desired precision.

## Step 1: Install Cactus

```bash
pip install cactus-compute
cactus --version
```

## Step 2: Convert (merges LoRA + quantizes in one command)

```bash
# INT8 (recommended for LiquidChat)
cactus convert LiquidAI/LFM2.5-1.2B-Instruct ./converted-model \
  --lora <LORA_REPO_ID>

# INT4 (smaller, for low-RAM devices)
cactus convert LiquidAI/LFM2.5-1.2B-Instruct ./converted-model \
  --lora <LORA_REPO_ID> \
  --precision INT4
```

## Step 3: Verify locally

```bash
cactus run ./converted-model
```

Test with a function-calling prompt, e.g. "Send a text to John saying I'll be late". Expected output: `send_message(recipient="John", message="I'll be late")`.

## Step 4: Push to Hub

```python
from huggingface_hub import HfApi

api = HfApi()
api.create_repo(
    repo_id="kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora-cactus",
    repo_type="model",
    exist_ok=True
)
api.upload_folder(
    folder_path="./converted-model",
    repo_id="kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora-cactus",
    repo_type="model",
    commit_message="Add Cactus-converted LiquidChat LoRA weights"
)
print("Done: https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora-cactus")
```

## Converted output structure

```
converted-model/
├── weights/<model_name>/
│   ├── *.bin              # Quantized tensors (CACT binary format)
│   └── config.txt         # Model metadata
├── vocab.txt
├── merges.txt
├── special_tokens.json    # eos, pad, bos, tool tokens
├── tokenizer_config.txt
└── chat_template.jinja2
```

## Naming convention

```
LoRA adapter:  kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora
Cactus output: kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora-cactus
```

## No local GPU? Run on HF Jobs

```bash
hf jobs uv run \
  --flavor a10g-large \
  --timeout 30m \
  --secrets HF_TOKEN \
  -- python -c "
import subprocess
subprocess.run(['pip', 'install', 'cactus-compute'], check=True)
subprocess.run([
  'cactus', 'convert', 'LiquidAI/LFM2.5-1.2B-Instruct', '/tmp/converted',
  '--lora', '<LORA_REPO_ID>'
], check=True)
from huggingface_hub import HfApi
HfApi().upload_folder(
  folder_path='/tmp/converted',
  repo_id='kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora-cactus',
  repo_type='model'
)
"
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `cactus: command not found` | Run `pip install cactus-compute` |
| LoRA load error | Verify adapter repo is public or `HF_TOKEN` env var is set |
| Hub upload fails | Check `hf whoami` — token needs write access |
| OOM during merge | Use the HF Jobs approach above |

## Next step

Run `/build-apk-liquidchat` to build the Android APK that loads the converted model.
