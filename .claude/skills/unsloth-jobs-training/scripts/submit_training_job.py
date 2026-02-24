#!/usr/bin/env python3
"""Submit training job to HF Jobs"""

import os
from huggingface_hub import HfApi, HfFolder

# Get token
token = HfFolder.get_saved_token()
if not token:
    raise ValueError("HF token not found. Run: huggingface-cli login")

api = HfApi()

print("=" * 80)
print("SUBMITTING TRAINING JOB TO HF JOBS")
print("=" * 80)

try:
    # Submit job
    job = api.submit_training(
        model_name="LFM2.5-1.2B-Instruct-liquidchat-lora",
        task="text-generation",
        dataset_id="kshitijthakkar/liquidchat-lora-dataset",
        framework="transformers",
        model_id="LiquidAI/LFM2.5-1.2B-Instruct",

        # Hardware
        hardware="gpu-l4",  # 24GB VRAM on L4

        # Training script
        script="run_hf_jobs_training.py",

        # Training parameters
        hyperparameters={
            "learning_rate": "2e-4",
            "batch_size": "2",
            "num_train_epochs": "3",
            "max_seq_length": "2048",
            "lora_rank": "16",
            "lora_alpha": "16",
        },

        # Repository settings
        repository_url=None,  # Will create new repo
        private=True,  # Private repo

        # Repo name
        repo_id="kshitijthakkar/LFM2.5-1.2B-Instruct-liquidchat-lora",
    )

    print(f"Job submitted successfully!")
    print(f"Job ID: {job.job_id}")
    print(f"Status: {job.status}")
    print(f"URL: https://huggingface.co/spaces/kshitijthakkar/job-{job.job_id}")

except Exception as e:
    print(f"Error submitting job: {e}")
    print("\nTrying alternative approach via API...")

    # Alternative: Direct REST API call
    import requests

    headers = {"Authorization": f"Bearer {token}"}

    payload = {
        "task": "text-generation",
        "model": "LiquidAI/LFM2.5-1.2B-Instruct",
        "dataset": "kshitijthakkar/liquidchat-lora-dataset",
        "framework": "transformers",
        "hardware": "gpu-l4",
    }

    resp = requests.post(
        "https://huggingface.co/api/training/v1/submit",
        json=payload,
        headers=headers,
    )

    if resp.status_code == 200:
        result = resp.json()
        print(f"Job submitted! Job ID: {result.get('job_id')}")
        print(f"URL: {result.get('url')}")
    else:
        print(f"Error: {resp.status_code}")
        print(resp.text)
