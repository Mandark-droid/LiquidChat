/**
 * OpenTelemetry: one span per meeting processed (on the phone or on the LiquidChat Space), with
 * what came out of it. Counts and status always; the transcript, minutes, action items and any
 * error text only with content capture (the SDK decides). On-device speech-to-text and model
 * calls appear inside it as their own spans.
 */
import { traceWorkflow } from '@traceverse/genai-otel-instrument-node/react-native';

import { meetingStore } from './MeetingStore';
import { transcriptPlain } from './MinutesGenerator';
import type { Meeting } from './types';

export async function traceMeeting<T>(id: string, mode: string, fn: () => Promise<T>): Promise<T> {
  const { result } = await traceWorkflow(
    `meeting.${mode}`,
    {
      attributes: { 'liquidchat.meeting.id': id, 'liquidchat.meeting.mode': mode },
      resultAttributes: ({ m }) => (m ? summary(m) : {}),
      output: ({ m }) =>
        m && {
          transcript: transcriptPlain(m),
          minutes: m.minutes?.summary,
          actionItems: m.actionItems.map(a => `${a.task}${a.owner ? ` (${a.owner})` : ''}`),
          error: m.error,
        },
    },
    async () => {
      const result = await fn();
      const m = await meetingStore.get(id).catch(() => null);
      return { result, m };
    },
  );
  return result;
}

function summary(m: Meeting): Record<string, string | number | undefined> {
  return {
    'liquidchat.meeting.status': m.status,
    'liquidchat.meeting.duration_s': Math.round(m.durationMs / 1000),
    'liquidchat.meeting.stt_model': m.sttModel ?? '',
    'liquidchat.meeting.segments': m.segments.filter(s => s.status === 'done').length,
    'liquidchat.meeting.speakers': m.speakers?.length ?? 0,
    'liquidchat.meeting.action_items': m.actionItems.length,
    'liquidchat.meeting.minutes_model': m.minutes?.model,
    // A category always; the message itself (it can quote the transcript) is in the output.
    'error.type': m.error
      ? m.status === 'error'
        ? 'meeting_failed'
        : 'meeting_warning'
      : undefined,
  };
}
