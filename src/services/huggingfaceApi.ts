const HF_API_BASE = 'https://huggingface.co/api';

export interface HFUserInfo {
  id: string;
  name: string;
  fullname: string;
}

export interface HFDatasetUploadResult {
  success: boolean;
  repoId?: string;
  url?: string;
  error?: string;
}

export async function hfWhoami(token: string): Promise<HFUserInfo | null> {
  try {
    const response = await fetch(`${HF_API_BASE}/whoami-v2`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return { id: data.id, name: data.name, fullname: data.fullname || data.name };
  } catch {
    return null;
  }
}

export async function validateHFToken(
  token: string,
): Promise<{ valid: boolean; username?: string; error?: string }> {
  if (!token?.trim()) return { valid: false, error: 'Token is empty' };
  const userInfo = await hfWhoami(token);
  if (userInfo) return { valid: true, username: userInfo.name };
  return { valid: false, error: 'Invalid token or network error' };
}

async function createDatasetRepo(
  token: string,
  repoId: string,
  isPrivate: boolean = false,
): Promise<boolean> {
  try {
    const response = await fetch(`${HF_API_BASE}/repos/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoId.split('/')[1],
        type: 'dataset',
        private: isPrivate,
      }),
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

async function uploadFiles(
  token: string,
  repoId: string,
  files: Array<{ path: string; content: string }>,
  commitMessage: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const commitUrl = `https://huggingface.co/api/datasets/${repoId}/commit/main`;
    const response = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: commitMessage,
        files: files.map(f => ({ path: f.path, content: f.content })),
      }),
    });
    if (response.ok) return { success: true };

    // Fallback to single file upload
    for (const file of files) {
      const uploadUrl = `https://huggingface.co/api/datasets/${repoId}/upload/main/${file.path}`;
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: file.content,
      });
      if (!uploadResponse.ok) {
        return { success: false, error: `Failed to upload ${file.path}` };
      }
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function pushDatasetToHub(
  token: string,
  jsonlContent: string,
  options: { isPrivate?: boolean } = {},
): Promise<HFDatasetUploadResult> {
  try {
    const userInfo = await hfWhoami(token);
    if (!userInfo) return { success: false, error: 'Invalid HuggingFace token.' };

    const date = new Date().toISOString().split('T')[0];
    const repoId = `${userInfo.name}/liquidchat-mobile-actions-${date}`;

    const repoCreated = await createDatasetRepo(
      token,
      repoId,
      options.isPrivate ?? false,
    );
    if (!repoCreated)
      return { success: false, error: 'Failed to create dataset repository.' };

    const readme = generateReadme(repoId, userInfo.name);
    const result = await uploadFiles(
      token,
      repoId,
      [
        { path: 'train.jsonl', content: jsonlContent },
        { path: 'README.md', content: readme },
      ],
      'Upload chat history from LiquidChat',
    );

    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      repoId,
      url: `https://huggingface.co/datasets/${repoId}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function generateReadme(repoId: string, username: string): string {
  return `---
license: apache-2.0
task_categories:
  - conversational
  - text-generation
language:
  - en
tags:
  - chat
  - liquidchat
  - mobile-actions
  - tool-calling
  - fine-tuning
size_categories:
  - n<1K
---

# ${repoId.split('/')[1]}

Chat history dataset exported from LiquidChat mobile app.

## Dataset Description

This dataset contains conversations with a mobile-actions fine-tuned LLM, including tool calls (flashlight, calendar, email, maps, contacts, wifi) and their results.

## Usage

\`\`\`python
from datasets import load_dataset
dataset = load_dataset("${repoId}")
\`\`\`

- **Created by**: ${username}
- **Exported from**: LiquidChat
- **License**: Apache 2.0
`;
}
