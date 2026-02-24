---
name: unsloth-jobs-training
description: Submit a LoRA fine-tuning job to Hugging Face Jobs using Unsloth optimizations on LFM2.5-1.2B-Instruct. Use when the user wants to train or fine-tune a model on HF Jobs cloud GPUs.
argument-hint: [dataset-id] [output-repo-id]
disable-model-invocation: true
allowed-tools: Bash
---

Submit a LoRA fine-tuning job to Hugging Face Jobs using Unsloth.

## Arguments

`$ARGUMENTS` should contain the dataset ID and optionally the output repo ID.
If not provided, ask the user for: dataset ID, output repo ID, and run name.

## Default Configuration (proven from LFM2.5 mobile-actions training)

- Base model: `LiquidAI/LFM2.5-1.2B-Instruct`
- LoRA rank/alpha: 16
- Batch size: 2 (effective 8 with grad accumulation 4)
- Learning rate: 2e-4, linear decay
- Epochs: 3
- Max seq length: 2048
- Eval split: 2% from training data
- Hardware: `a10g-large` (24GB VRAM)
- Timeout: 4h
- Trackio space: `kshitijthakkar/trackio`

## Step 1: Confirm authentication

```bash
hf whoami
```

## Step 2: Submit the job

Run this command (substitute `<DATASET_ID>`, `<OUTPUT_REPO>`, `<RUN_NAME>`):

```bash
hf jobs uv run \
  --flavor a10g-large \
  --timeout 4h \
  --secrets HF_TOKEN \
  "C:\Users\kshit\.claude\plugins\cache\huggingface-skills\hugging-face-model-trainer\3f4f55d6264b\scripts\unsloth_sft_example.py" \
  -- \
  --dataset <DATASET_ID> \
  --num-epochs 3 \
  --lora-r 16 \
  --lora-alpha 16 \
  --batch-size 2 \
  --gradient-accumulation 4 \
  --learning-rate 2e-4 \
  --max-seq-length 2048 \
  --eval-split 0.02 \
  --trackio-space kshitijthakkar/trackio \
  --run-name <RUN_NAME> \
  --seed 3407 \
  --output-repo <OUTPUT_REPO>
```

## Step 3: Report back to user

After submission, provide:
- Job ID (from command output)
- Job URL: `https://huggingface.co/jobs/kshitijthakkar/<job-id>`
- Trackio dashboard: `https://huggingface.co/spaces/kshitijthakkar/trackio`
- Estimated completion: ~2-3 hours for 30k samples, 3 epochs on A10G

## Check job status

```bash
PYTHONUTF8=1 hf jobs inspect <job-id>
```

## CLI syntax rules (critical)

- All HF Jobs flags (`--flavor`, `--timeout`, `--secrets`) MUST come **before** the script path
- Use `--` (double dash) to separate HF Jobs flags from script arguments
- `PYTHONUTF8=1` prefix avoids Windows encoding errors in log output
- Local script files are uploaded automatically by the CLI

## Dataset requirements

Dataset must have a `messages`, `conversations`, or `conversation` column with lists of `{role, content}` dicts. The script handles column renaming and ChatML formatting automatically.

## Validated example (working job)

```bash
hf jobs uv run \
  --flavor a10g-large \
  --timeout 4h \
  --secrets HF_TOKEN \
  "C:\Users\kshit\.claude\plugins\cache\huggingface-skills\hugging-face-model-trainer\3f4f55d6264b\scripts\unsloth_sft_example.py" \
  -- \
  --dataset kshitijthakkar/liquidchat-lora-dataset \
  --num-epochs 3 \
  --lora-r 16 --lora-alpha 16 \
  --batch-size 2 --gradient-accumulation 4 \
  --learning-rate 2e-4 --max-seq-length 2048 \
  --eval-split 0.02 \
  --trackio-space kshitijthakkar/trackio \
  --run-name liquidchat-lora-v1 \
  --seed 3407 \
  --output-repo kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora
```

Job ID: `699d9b0f52d1c53b7df7d678` — GPU: A10G — Started: 2026-02-24

## Troubleshooting

| Error | Fix |
|-------|-----|
| `UnicodeEncodeError` in CLI | Job still submitted fine — ignore or use `PYTHONUTF8=1` prefix |
| OOM on GPU | Reduce `--batch-size 1`, increase `--gradient-accumulation 8` |
| Job timeout | Increase `--timeout 6h` or reduce `--num-epochs` |
| Hub push fails | Verify `--secrets HF_TOKEN` is set and token has write access |

## Next step after training

Run `/lora-to-cactus-hub` to merge adapters and convert to Cactus format for mobile deployment.
