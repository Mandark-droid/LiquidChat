---
name: lora-to-cactus-hub
description: Merge a trained LoRA adapter into the base model, convert to Cactus binary format for mobile deployment, and push to Hugging Face Hub. Use after training completes with /unsloth-jobs-training.
argument-hint: [lora-repo-id]
disable-model-invocation: false
allowed-tools: Bash
---

Merge a LoRA adapter into the base model, convert to Cactus format, and push to Hub.

## What is Cactus format

Cactus is a custom optimized binary format (flat `.weights` binary files + `config.txt`) for efficient on-device inference. It is the native runtime for the LiquidChat Android app via `cactus-react-native`.

Quantization options:
- **INT8** — Recommended default. ~50% size reduction, minimal quality loss. (~1.2GB for LFM2.5-1.2B)
- **INT4** — Maximum compression, slight quality trade-off. For low-RAM devices.
- **FP16** — Full precision, larger file. For testing only.

## Arguments

`$ARGUMENTS` should be the LoRA adapter repo ID (e.g. `kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora`).
If not provided, ask the user for the LoRA repo and desired precision.

## Prerequisites

The conversion uses the local Cactus repo. **`cactus-compute` is NOT on PyPI** — do not attempt `pip install cactus-compute`.

- Cactus repo: `H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\`
- Python venv: `<cactus-repo>\venv\Scripts\python.exe`
- Required packages: `torch`, `transformers`, `peft` (install peft if missing)

```bash
# Check peft is installed
H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\venv\Scripts\python.exe -c "import torch, peft, transformers; print('ready')"

# Install peft if missing
H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\venv\Scripts\python.exe -m pip install peft -q
```

## Step 1: Verify LoRA repo on Hub

```python
python -c "
from huggingface_hub import HfApi
files = list(HfApi().list_repo_files('<LORA_REPO_ID>'))
print('\n'.join(files))
"
```

Expected files: `adapter_config.json`, `adapter_model.safetensors`, `tokenizer.json`, `tokenizer_config.json`

## Step 2: Run conversion (merge + quantize)

```python
# Run from the Cactus repo directory
cd H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus

H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\venv\Scripts\python.exe -c "
import sys
from pathlib import Path
sys.path.insert(0, str(Path('.') / 'python'))

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
from src.converter import convert_hf_model_weights
from src.tokenizer import convert_hf_tokenizer
from src.tensor_io import format_config_value

BASE_MODEL_ID = 'LiquidAI/LFM2.5-1.2B-Instruct'
LORA_ADAPTER = '<LORA_REPO_ID>'
OUTPUT_DIR = Path('weights/<output-name>')
PRECISION = 'INT8'

print('[1/5] Loading base model:', BASE_MODEL_ID)
base_model = AutoModelForCausalLM.from_pretrained(BASE_MODEL_ID, trust_remote_code=True)
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_ID, trust_remote_code=True)

print('[2/5] Loading LoRA adapter:', LORA_ADAPTER)
model = PeftModel.from_pretrained(base_model, LORA_ADAPTER)
print('  Merging LoRA weights...')
merged_model = model.merge_and_unload()
del base_model, model
print('  Merge complete.')

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
print('[3/5] Converting weights to Cactus format (INT8)...')

class FakeArgs:
    precision = PRECISION

config = convert_hf_model_weights(merged_model, OUTPUT_DIR, PRECISION, FakeArgs())
config.setdefault('model_variant', 'default')
config['precision'] = 'FP16'

print('[4/5] Writing config.txt...')
with open(OUTPUT_DIR / 'config.txt', 'w') as f:
    for key, value in config.items():
        f.write(f'{key}={format_config_value(value)}\n')

print('[5/5] Converting tokenizer...')
convert_hf_tokenizer(tokenizer, OUTPUT_DIR)

print()
print('Done! Files:', len(list(OUTPUT_DIR.iterdir())))
"
```

This runs on CPU — model load + merge takes ~5 minutes, quantization ~5-10 minutes.

## Step 3: Verify output

```bash
ls -lh H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\weights\<output-name>\
```

Expected: ~157 files, ~1.2GB total for LFM2.5-1.2B INT8. Files include:
- `layer_N_*.weights` — per-layer quantized tensors
- `token_embeddings.weights` — embedding table (~137MB)
- `config.txt` — model metadata
- `vocab.txt`, `merges.txt`, `tokenizer.json`, `tokenizer_config.txt`
- `special_tokens.json`, `chat_template.jinja2`

## Step 4: Push to Hub

```python
H:\C_Documents\Documents\LLM-Code\llm_engineering\Projects\cactus\venv\Scripts\python.exe -c "
from huggingface_hub import HfApi
api = HfApi()
api.create_repo(
    repo_id='kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora-cactus',
    repo_type='model',
    exist_ok=True
)
print('Repo ready. Uploading...')
api.upload_folder(
    folder_path='weights/<output-name>',
    repo_id='kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora-cactus',
    repo_type='model',
    commit_message='Add Cactus INT8 weights — LFM2.5-1.2B + <task> LoRA merged'
)
print('Done: https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora-cactus')
"
```

## Validated example (working conversion)

```
LoRA adapter:  kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora
Output dir:    weights/lfm25-liquidchat-lora
Hub repo:      kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora-cactus
Files pushed:  157
Output size:   ~1.2GB (INT8)
Completed:     2026-02-25
```

## Naming convention

```
LoRA adapter:  kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora
Output dir:    weights/lfm25-<task>
Cactus output: kshitijthakkar/LFM2.5-1.2B-Instruct-<task>-lora-cactus
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `cactus-compute` not found on PyPI | Expected — do NOT use pip install. Use the local Cactus repo converter directly |
| `No module named 'peft'` | Run `venv/Scripts/python.exe -m pip install peft` in the Cactus repo |
| `No module named 'src.converter'` | Must `cd` into the Cactus repo root before running, and add `python/` to `sys.path` |
| LoRA load error | Verify adapter repo is public or `HF_TOKEN` env var is set |
| Hub upload fails | Check `huggingface-cli whoami` — token needs write access |
| OOM during merge | CPU-only merge uses ~4-5GB RAM. Close other apps. No GPU needed. |
| Symlinks warning on Windows | Cosmetic only — conversion still works. Set `HF_HUB_DISABLE_SYMLINKS_WARNING=1` to suppress |

## Next step

Run `/build-apk-liquidchat` to build the Android APK that loads the converted model.
