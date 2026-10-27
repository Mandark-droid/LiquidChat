/**
 * OpenTelemetry: one span per meeting processed (on the phone or on the LiquidChat Space), with
 * what came out of it. The transcript and minutes text are attached only when content capture is
 * on. On-device speech-to-text and model calls appear as their own Cactus spans.
 */
import { setContent, withSpan } from '../observability/spans';
import { meetingStore } from './MeetingStore';
import { transcriptPlain } from './MinutesGenerator';

export function traceMeeting<T>(id: string, mode: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    `meeting.${mode}`,
    { 'liquidchat.meeting.id': id, 'liquidchat.meeting.mode': mode },
    async span => {
      const result = await fn();
      const m = await meetingStore.get(id).catch(() => null);
      if (m) {
        span.setAttribute('liquidchat.meeting.status', m.status);
        span.setAttribute('liquidchat.meeting.duration_s', Math.round(m.durationMs / 1000));
        span.setAttribute('liquidchat.meeting.stt_model', m.sttModel ?? '');
        span.setAttribute(
          'liquidchat.meeting.segments',
          m.segments.filter(s => s.status === 'done').length,
        );
        span.setAttribute('liquidchat.meeting.speakers', m.speakers?.length ?? 0);
        span.setAttribute('liquidchat.meeting.action_items', m.actionItems.length);
        if (m.minutes?.model)
          span.setAttribute('liquidchat.meeting.minutes_model', m.minutes.model);
        if (m.error) span.setAttribute('error.type', m.error.slice(0, 200));
        setContent(span, 'liquidchat.meeting.transcript', transcriptPlain(m));
        setContent(span, 'liquidchat.meeting.minutes', m.minutes?.summary);
        setContent(
          span,
          'liquidchat.meeting.action_items_text',
          m.actionItems.map(a => `${a.task}${a.owner ? ` (${a.owner})` : ''}`),
        );
      }
      return result;
    },
  );
}
