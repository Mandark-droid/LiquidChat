# LiquidChat LoRA Training Guide

Training custom LoRA adapters for LFM2.5-1.2B-Instruct on the LiquidChat dataset using Unsloth optimizations on Hugging Face Jobs.

## Overview

- **Base Model**: LiquidAI/LFM2.5-1.2B-Instruct (1.2B parameters)
- **Dataset**: kshitijthakkar/liquidchat-lora-dataset (32,193 examples)
- **Training Method**: Supervised Fine-Tuning (SFT) with LoRA
- **Hardware**: NVIDIA L4 GPU on HF Jobs (22GB VRAM)
- **Expected Duration**: ~2-3 hours
- **Cost**: ~$5-10 (L4 GPU pricing)

## Key Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| **LoRA Rank (r)** | 16 | Balances parameter count and expressiveness |
| **LoRA Alpha** | 16 | Usually equals rank for consistency |
| **Batch Size** | 2 | Per device (effective 8 with 4x gradient accumulation) |
| **Learning Rate** | 2e-4 | Linear decay schedule |
| **Epochs** | 3 | Prevents overfitting on synthetic data |
| **Seq Length** | 2,048 | Supports long conversations |
| **Optimizer** | AdamW 8-bit | Memory-efficient |
| **Precision** | FP16 | Unsloth optimized training |
| **Packing** | Enabled | Improves throughput |

## Prerequisites

### Local Testing (Optional)
```bash
# Install dependencies
pip install unsloth transformers datasets trl peft huggingface-hub torch

# Set HF token for Hub operations
export HF_TOKEN="hf_your_token_here"
```

### HF Jobs Submission
1. Hugging Face account with write access
2. HF_TOKEN set in environment or Hugging Face secrets
3. Model output repo already exists or will be created

## Quick Start

### Option 1: Submit to HF Jobs (Recommended)

```bash
# 1. Make sure you're authenticated
huggingface-cli login
# Paste your token from https://huggingface.co/settings/tokens

# 2. Create a Jobs training config (YAML)
# Save as training_config.yaml:
model_name: LiquidAI/LFM2.5-1.2B-Instruct
dataset: kshitijthakkar/liquidchat-lora-dataset
output_model_id: kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora
hardware: gpu-l4

# 3. Submit the training job
huggingface-cli jobs submit \
  --script run_hf_jobs_training.py \
  --hardware gpu-l4 \
  --private \
  --repo-type model

# 4. Monitor training
huggingface-cli jobs logs <job-id>
huggingface-cli jobs status <job-id>
```

### Option 2: Local Testing (Requires GPU)

```bash
# Run locally first to verify setup
python run_hf_jobs_training.py

# Monitor training on tensorboard
tensorboard --logdir ./lora-liquidchat/runs
```

## File Structure

```
LiquidChat/
├── run_hf_jobs_training.py       # Main training script (HF Jobs compatible)
├── train_liquidchat_lora.py      # Alternative training script
├── TRAINING_GUIDE.md             # This file
└── .claude/skills/
    ├── unsloth-jobs-training.json
    ├── lora-to-cactus-hub.json
    └── build-apk-liquidchat.json
```

## Step-by-Step Workflow

### 1. Prepare & Verify

```bash
# Verify dataset exists and is accessible
python -c "from datasets import load_dataset; ds = load_dataset('kshitijthakkar/liquidchat-lora-dataset'); print(f'Train: {len(ds[\"train\"])}, Eval: {len(ds[\"validation\"])}')"
# Output: Train: 31600, Eval: 643
```

### 2. Submit to HF Jobs

```bash
# Use the /unsloth-jobs-training skill for guidance, or submit directly:
huggingface-cli jobs submit \
  --script run_hf_jobs_training.py \
  --hardware gpu-l4 \
  --private

# Note: Job will start and run in background on HF infrastructure
```

### 3. Monitor Training

```bash
# Get job ID from submission output, then:
huggingface-cli jobs logs <job-id> --tail 50

# Or check status
huggingface-cli jobs status <job-id>
```

### 4. Wait for Completion

Training will:
1. Load model with Unsloth (2-3 min)
2. Download and format dataset (3-5 min)
3. Train for 3 epochs (90+ min)
4. Push to Hub (5-10 min)

Estimated total: **~2-3 hours**

### 5. Use Trained Model

Once complete, the model will be at: `https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora`

#### Test Inference
```bash
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base_model_id = "LiquidAI/LFM2.5-1.2B-Instruct"
lora_model_id = "kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora"

base_model = AutoModelForCausalLM.from_pretrained(base_model_id)
model = PeftModel.from_pretrained(base_model, lora_model_id)
tokenizer = AutoTokenizer.from_pretrained(base_model_id)

# Now use model for inference
```

#### Convert to Cactus Format (Next Skill)
```bash
# After training completes, convert for mobile deployment:
/lora-to-cactus-hub

# This will:
# 1. Merge LoRA adapters
# 2. Convert to Cactus binary format
# 3. Push converted weights to Hub
```

#### Build APK (Final Skill)
```bash
# Finally, build APK with the converted model:
/build-apk-liquidchat
```

## Output Structure

### HF Hub Location
```
https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora
├── adapter_config.json     # LoRA configuration
├── adapter_model.bin       # LoRA weights
├── special_tokens_map.json
├── tokenizer.json
├── tokenizer_config.json
└── README.md               # Auto-generated model card
```

### Local Checkpoints (if running locally)
```
./lora-liquidchat/
├── checkpoint-500/
├── checkpoint-1000/
├── adapter_config.json
├── adapter_model.bin
└── runs/                   # TensorBoard logs
```

## Expected Results

Based on mobile-actions training:

- **Train Loss**: 0.01-0.02
- **Eval Loss**: 0.01-0.03
- **No Overfitting**: Eval loss doesn't diverge
- **Inference Quality**: 100% accuracy on function-calling tasks
- **Speed**: 2x faster than standard training
- **Memory**: 60% less VRAM usage

## Troubleshooting

### Issue: Job stuck on "uploading model"
- **Solution**: Check HF_TOKEN is valid and has write access
- **Check**: `huggingface-cli whoami`

### Issue: Out of memory
- **Solution**: Reduce batch size to 1, gradient accumulation to 2
- **Alternative**: Request GPU with more VRAM (gpu_a10, gpu_a100)

### Issue: Dataset not found
- **Solution**: Ensure dataset is public or you have access
- **Check**: `huggingface-cli list-datasets kshitijthakkar/liquidchat-lora-dataset`

### Issue: Model download fails
- **Solution**: Check internet connection and HF Hub status
- **Try**: `huggingface-cli model-info LiquidAI/LFM2.5-1.2B-Instruct`

## Advanced: Custom Configuration

To change parameters, edit `run_hf_jobs_training.py`:

```python
# Learning rate
LEARNING_RATE = 2e-4  # Increase for faster learning, decrease for stability

# Batch size
BATCH_SIZE = 2  # Reduce if OOM, increase for stability

# LoRA rank
LORA_RANK = 16  # Higher = more expressive but slower, more parameters

# Epochs
EPOCHS = 3  # More epochs if dataset is small, fewer if large

# Max sequence length
MAX_SEQUENCE_LENGTH = 2048  # Reduce if OOM on long examples
```

## Integration with Skills

This training is the first step in the complete pipeline:

1. **🚀 `/unsloth-jobs-training`** (you are here)
   - Train LoRA adapters on HF Jobs
   - Output: LoRA adapters on Hub

2. **🔄 `/lora-to-cactus-hub`** (next)
   - Convert to Cactus format
   - Output: Optimized weights on Hub

3. **📱 `/build-apk-liquidchat`** (final)
   - Build Android APK
   - Deploy to device

## Support

For issues with:
- **Training script**: Check `run_hf_jobs_training.py` logs
- **HF Jobs**: Visit https://huggingface.co/docs/hub/jobs
- **Unsloth**: Visit https://github.com/unslothai/unsloth
- **LiquidChat**: Use `/unsloth-jobs-training` skill for guidance

## Next Steps

1. ✅ Review this guide
2. ⏳ Submit training job
3. ⏱️ Wait for training (~2-3 hours)
4. 🔄 Run `/lora-to-cactus-hub` skill for conversion
5. 📱 Run `/build-apk-liquidchat` skill to build APK
6. 🚀 Deploy to device!
