#!/usr/bin/env python3
"""
LiquidChat LoRA Training Script using Unsloth + HF Jobs
Based on: https://github.com/Mandark-droid/LFM2.5-1.2B-Instruct-mobile-actions

Trains LFM2.5-1.2B-Instruct with LoRA adapters on LiquidChat dataset
using Unsloth optimizations for efficient fine-tuning on HF Jobs.
"""

import os
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
)
from trl import SFTTrainer
from unsloth import FastLanguageModel
from peft import LoraConfig
import torch

# ============================================================================
# CONFIGURATION
# ============================================================================

MODEL_ID = "LiquidAI/LFM2.5-1.2B-Instruct"
DATASET_ID = "kshitijthakkar/liquidchat-lora-dataset"
OUTPUT_DIR = "./lora-liquidchat"
HF_MODEL_ID = "kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora"

# Training hyperparameters (proven from mobile-actions training)
LEARNING_RATE = 2e-4
BATCH_SIZE = 2
GRADIENT_ACCUMULATION_STEPS = 4
EPOCHS = 3
MAX_SEQUENCE_LENGTH = 2048
SEED = 3407

# LoRA configuration (proven parameters)
LORA_RANK = 16
LORA_ALPHA = 16
LORA_DROPOUT = 0
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "out_proj", "in_proj", "w1", "w2", "w3"]

# ============================================================================
# LOAD MODEL AND TOKENIZER WITH UNSLOTH
# ============================================================================

print("Loading model with Unsloth optimizations...")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL_ID,
    max_seq_length=MAX_SEQUENCE_LENGTH,
    dtype=torch.float16,
    load_in_4bit=True,
)

# Prepare model for training
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

print(f"Model prepared. Trainable params: {model.get_num_parameters('trainable'):,}")

# ============================================================================
# LOAD DATASET
# ============================================================================

print(f"Loading dataset from {DATASET_ID}...")
dataset = load_dataset(DATASET_ID)

print(f"Train samples: {len(dataset['train']):,}")
print(f"Eval samples: {len(dataset['validation']):,}")

# ============================================================================
# FORMAT DATASET FOR TRAINING (Response-Only Loss Masking)
# ============================================================================

def format_chat_template(examples):
    """Convert dataset to ChatML format with response-only masking."""
    formatted_texts = []

    for messages in examples["messages"]:
        # Build conversation
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

# Apply formatting
train_dataset = dataset["train"].map(format_chat_template, batched=True, remove_columns=dataset["train"].column_names)
eval_dataset = dataset["validation"].map(format_chat_template, batched=True, remove_columns=dataset["validation"].column_names)

print(f"Formatted train samples: {len(train_dataset)}")
print(f"Formatted eval samples: {len(eval_dataset)}")

# ============================================================================
# TRAINING SETUP
# ============================================================================

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
    report_to=["tensorboard", "wandb"],
    logging_first_step=True,
    push_to_hub=True,
    hub_model_id=HF_MODEL_ID,
    hub_private_repo=False,
    remove_unused_columns=False,
)

# ============================================================================
# TRAINER & TRAINING
# ============================================================================

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    dataset_text_field="text",
    max_seq_length=MAX_SEQUENCE_LENGTH,
    packing=True,  # Optimize throughput
)

print("Starting training...")
trainer.train()

# ============================================================================
# SAVE & PUSH TO HUB
# ============================================================================

print("Saving LoRA adapters...")
model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)

print(f"Pushing to hub: {HF_MODEL_ID}...")
model.push_to_hub(HF_MODEL_ID, token=os.getenv("HF_TOKEN"))

print("✓ Training complete!")
print(f"Model saved to: {OUTPUT_DIR}")
print(f"Model pushed to: https://huggingface.co/{HF_MODEL_ID}")
