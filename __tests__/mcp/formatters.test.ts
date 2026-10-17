import { formatMcpResult, hasMcpFormatter } from '../../src/mcp/formatters';

// Real output of hub_repo_search (query "LFM2", sorted by trendingScore), trimmed to two repos.
const SAMPLE = [
  'Found 2 repositories across models matching query "LFM2", sorted by trendingScore (descending).',
  '',
  '## Models (2)',
  '',
  '### LiquidAI/LFM2.5-24B-A2B',
  '',
  '**Task:** text-generation | **Library:** transformers | **Downloads:** 11.9K | **Likes:** 443 | **Trending Score:** 430',
  '',
  '**Tags:** transformers, safetensors, lfm2_moe, text-generation, liquid, lfm2.5, edge, moe',
  '*and 11 more...*',
  '',
  '**Created:** 12 Oct, 2026',
  '**Link:** [https://hf.co/LiquidAI/LFM2.5-24B-A2B](https://hf.co/LiquidAI/LFM2.5-24B-A2B)',
  '',
  '---',
  '',
  '### unsloth/LFM2.5-24B-A2B-GGUF',
  '',
  '**Task:** text-generation | **Library:** transformers | **Downloads:** 35.8K | **Likes:** 65',
  '',
  '**Link:** [https://hf.co/unsloth/LFM2.5-24B-A2B-GGUF](https://hf.co/unsloth/LFM2.5-24B-A2B-GGUF)',
].join('\n');

describe('formatMcpResult', () => {
  it('turns a Hugging Face search into a short list', () => {
    expect(formatMcpResult('huggingface', 'hub_repo_search', SAMPLE)).toBe(
      [
        'Found 2 repositories across models matching query "LFM2", sorted by trendingScore (descending).',
        '• LiquidAI/LFM2.5-24B-A2B — text-generation · 11.9K downloads · 443 likes',
        '• unsloth/LFM2.5-24B-A2B-GGUF — text-generation · 35.8K downloads · 65 likes',
      ].join('\n'),
    );
  });
  it('returns null for text it cannot parse, so the caller falls back', () => {
    expect(formatMcpResult('huggingface', 'hub_repo_search', 'No results.')).toBeNull();
  });
  it('knows which tools have a formatter', () => {
    expect(hasMcpFormatter('huggingface', 'hub_repo_search')).toBe(true);
    expect(hasMcpFormatter('huggingface', 'hub_repo_details')).toBe(false);
    expect(hasMcpFormatter('other', 'hub_repo_search')).toBe(false);
  });
});
