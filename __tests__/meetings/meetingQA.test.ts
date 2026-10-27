jest.mock('@dr.pogodin/react-native-fs', () => ({}));
jest.mock('cactus-react-native', () => ({}));

import { meetingContext, passages, rank, terms } from '../../src/meetings/meetingQA';
import { action, makeMeeting, seg } from './fixtures';

/** A 45-minute meeting: routine filler with three facts buried in it. */
function longMeeting() {
  const segments = Array.from({ length: 90 }, (_, i) =>
    seg(i, `We went through routine item ${i} and nothing changed there, moving on.`),
  );
  segments[7] = seg(7, 'The Netscope log retention is thirty days in production.');
  segments[52] = seg(52, 'Lalit will share the LiteLLM latency numbers with Priya by Thursday.');
  segments[83] = seg(83, 'We agreed to drop Mule and keep the gateway on LiteLLM.');
  return makeMeeting({
    title: 'Gateway review',
    segments,
    actionItems: [
      action({ task: 'Share LiteLLM latency numbers', owner: 'Lalit', dueText: 'Thursday' }),
    ],
  });
}

describe('meeting Q&A retrieval', () => {
  it('drops stop words and plural endings', () => {
    expect(terms('What are the latency numbers?')).toEqual(['latency', 'number']);
  });

  it('finds facts from late in a long meeting, not just the opening', () => {
    const ctx = meetingContext(longMeeting(), 'What did we decide about Mule?');
    expect(ctx).toContain('drop Mule');
    expect(ctx).toContain('[41:30]');
  });

  it('keeps the action items with owners in every answer', () => {
    const ctx = meetingContext(longMeeting(), 'how long are logs retained?');
    expect(ctx).toContain('Share LiteLLM latency numbers — owner: Lalit — due: Thursday');
    expect(ctx).toContain('retention is thirty days');
  });

  it('stays within the character budget', () => {
    const ctx = meetingContext(longMeeting(), 'routine item', 3000);
    expect(ctx.length).toBeLessThan(3200);
  });

  it('falls back to the opening when nothing matches', () => {
    const ctx = meetingContext(longMeeting(), 'zzz qqq');
    expect(ctx).toContain('routine item 0');
  });

  it('windows overlap by one line so a reply stays with its question', () => {
    const ps = passages(['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)], 650);
    expect(ps.map(p => p.text.length)).toEqual([601, 601]);
    expect(rank('', ps)).toHaveLength(2);
  });
});
