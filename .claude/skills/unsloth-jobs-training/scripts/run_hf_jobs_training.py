#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "torch==2.8.0",
#     "transformers==4.57.3",
#     "datasets==3.1.0",
#     "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git",
#     "peft==0.14.0",
#     "trl==0.13.0",
#     "huggingface-hub==1.4.1",
#     "tensorboard==2.18.0",
#     "wandb==0.18.0",
#     "bitsandbytes==0.45.0",
# ]
# ///
"""
HF Jobs Training Script - PEP 723 format
Run with: uv run run_hf_jobs_training.py
Submit to HF Jobs: huggingface-cli jobs submit --model-id ... --task training
"""

import os
from datasets import load_dataset
from transformers import AutoTokenizer, TrainingArguments
from trl import SFTTrainer
from unsloth import FastLanguageModel
import torch

# ============================================================================
# CONFIGURATION
# ============================================================================

MODEL_ID = "LiquidAI/LFM2.5-1.2B-Instruct"
DATASET_ID = "kshitijthakkar/liquidchat-lora-dataset"
OUTPUT_DIR = "./lora-liquidchat"
HF_MODEL_ID = "kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora"

# Training hyperparameters (proven configuration)
LEARNING_RATE = 2e-4
BATCH_SIZE = 2
GRADIENT_ACCUMULATION_STEPS = 4
EPOCHS = 3
MAX_SEQUENCE_LENGTH = 2048
SEED = 3407

# LoRA configuration
LORA_RANK = 16
LORA_ALPHA = 16
LORA_DROPOUT = 0.0
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "out_proj", "in_proj", "w1", "w2", "w3"]

# ============================================================================
# SETUP
# ============================================================================

print("=" * 80)
print("LiquidChat LoRA Training on HF Jobs")
print("=" * 80)
print(f"Model: {MODEL_ID}")
print(f"Dataset: {DATASET_ID}")
print(f"Output: {HF_MODEL_ID}")
print(f"GPU: L4 (22GB VRAM)")
print("=" * 80)

# Set HF token if available
if "HF_TOKEN" not in os.environ:
    print("⚠️  Warning: HF_TOKEN not set. Set via: export HF_TOKEN=hf_...")
    print("   You can get your token from: https://huggingface.co/settings/tokens")

# ============================================================================
# LOAD MODEL WITH UNSLOTH
# ============================================================================

print("\n[1/5] Loading model with Unsloth optimizations...")
try:
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_ID,
        max_seq_length=MAX_SEQUENCE_LENGTH,
        dtype=torch.float16,
        load_in_4bit=True,
    )
    print("✓ Model loaded successfully")
except Exception as e:
    print(f"✗ Failed to load model: {e}")
    raise

# Prepare for training
print("Preparing model for LoRA training...")
model = FastLanguageModel.get_peft_model(
    model,
    r=LORA_RANK,
    lora_alpha=LORA_ALPHA,
    lora_dropout=LORA_DROPOUT,
    target_modules=TARGET_MODULES,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=SEED,
)

trainable_params = model.get_num_parameters("trainable")
total_params = model.get_num_parameters("all")
trainable_pct = 100 * trainable_params / total_params
print(f"✓ Trainable params: {trainable_params:,} / {total_params:,} ({trainable_pct:.2f}%)")

# ============================================================================
# LOAD DATASET
# ============================================================================

print("\n[2/5] Loading dataset...")
try:
    dataset = load_dataset(DATASET_ID)
    train_samples = len(dataset["train"])
    eval_samples = len(dataset["validation"])
    print(f"✓ Train samples: {train_samples:,}")
    print(f"✓ Eval samples: {eval_samples:,}")
except Exception as e:
    print(f"✗ Failed to load dataset: {e}")
    raise

# ============================================================================
# FORMAT DATASET
# ============================================================================

print("\n[3/5] Formatting dataset...")


def format_chat_template(examples):
    """Convert to ChatML format."""
    formatted_texts = []
    for messages in examples["messages"]:
        text = ""
        for msg in messages:
            role = msg["role"]
            content = msg["content"]

            if role == "system":
                text += f"<|im_start|>system\n{content}<|im_end|>\n"
            elif role == "user":
                text += f"<|im_start|>user\n{content}<|im_end|>\n"
            elif role == "assistant":
                text += f"<|im_start|>assistant\n{content}<|im_end|>\n"

        formatted_texts.append(text)

    return {"text": formatted_texts}


train_dataset = dataset["train"].map(
    format_chat_template, batched=True, remove_columns=dataset["train"].column_names
)
eval_dataset = dataset["validation"].map(
    format_chat_template, batched=True, remove_columns=dataset["validation"].column_names
)
print(f"✓ Dataset formatted")

# ============================================================================
# TRAINING ARGUMENTS
# ============================================================================

print("\n[4/5] Setting up training arguments...")
training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=BATCH_SIZE,
    per_device_eval_batch_size=BATCH_SIZE,
    gradient_accumulation_steps=GRADIENT_ACCUMULATION_STEPS,
    learning_rate=LEARNING_RATE,
    lr_scheduler_type="linear",
    warmup_steps=100,
    logging_steps=50,
    save_steps=500,
    eval_steps=500,
    evaluation_strategy="steps",
    save_strategy="steps",
    load_best_model_at_end=True,
    metric_for_best_model="eval_loss",
    greater_is_better=False,
    optim="adamw_8bit",
    weight_decay=0.01,
    max_grad_norm=1.0,
    seed=SEED,
    report_to=["tensorboard"],
    logging_first_step=True,
    push_to_hub=True,
    hub_model_id=HF_MODEL_ID,
    hub_strategy="every_save",
    remove_unused_columns=False,
)

# ============================================================================
# TRAIN
# ============================================================================

print("\n[5/5] Starting training...")
print(f"Expected runtime: ~2-3 hours on L4 GPU")
print("-" * 80)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    dataset_text_field="text",
    max_seq_length=MAX_SEQUENCE_LENGTH,
    packing=True,
)

trainer.train()

# ============================================================================
# FINALIZE
# ============================================================================

print("\n" + "=" * 80)
print("Training completed!")
print("=" * 80)
print(f"LoRA adapters saved to: {OUTPUT_DIR}")
print(f"Model pushed to Hub: https://huggingface.co/{HF_MODEL_ID}")
print("\nNext steps:")
print("1. Test inference with: /lora-to-cactus-hub")
print("2. Convert to Cactus format: cactus convert <base> <output> --lora <lora>")
print("3. Build APK: /build-apk-liquidchat")
print("=" * 80)
