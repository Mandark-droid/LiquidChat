import type { Attendee, TranscriptSegment } from './types';

/**
 * Parses transcripts pasted from Zoom / Google Meet / Teams / Otter / WebVTT
 * into segments. Timestamps are kept when present ("[12:30]", "00:12:30",
 * VTT cue lines); otherwise segments are untimed (startMs = -1) and keep
 * their order. Speaker prefixes ("Rahul Mehta: …") stay in the text so the
 * summariser can attribute action items.
 */
export function parseTranscript(raw: string): TranscriptSegment[] {
  const lines = raw.replace(/\r/g, '').split('\n');
  const out: TranscriptSegment[] = [];
  let pendingStart = -1;
  let buf: string[] = [];
  let idx = 0;

  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    buf = [];
    if (!text) return;
    out.push({
      index: idx++,
      startMs: pendingStart,
      durationMs: 0,
      wallStartMs: 0,
      speechRatio: 1,
      text,
      status: 'done',
    });
    pendingStart = -1;
  };

  for (const line0 of lines) {
    const line = line0.trim();
    if (!line || /^WEBVTT/i.test(line) || /^NOTE\b/.test(line) || /^\d+$/.test(line)) {
      if (!line) flush();
      continue;
    }
    // VTT/SRT cue: 00:01:02.000 --> 00:01:05.000
    const cue = line.match(/^(\d{1,2}:)?(\d{1,2}):(\d{2})[.,]\d{1,3}\s*-->/);
    if (cue) {
      flush();
      pendingStart = toMs(cue[1] ? cue[1].slice(0, -1) : '0', cue[2], cue[3]);
      continue;
    }
    // Leading timestamp: [12:30] text | 00:12:30 text | 12:30 Speaker: text
    const ts = line.match(/^\[?((\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s+(.*)$/);
    if (ts) {
      flush();
      pendingStart = toMs(ts[2] ?? '0', ts[3], ts[4]);
      buf.push(ts[5]);
      flush();
      continue;
    }
    // Lines that are only a timestamp (Meet/Otter put them above the text)
    const tsOnly = line.match(/^\[?((\d{1,2}):)?(\d{1,2}):(\d{2})\]?$/);
    if (tsOnly) {
      flush();
      pendingStart = toMs(tsOnly[2] ?? '0', tsOnly[3], tsOnly[4]);
      continue;
    }
    buf.push(line.replace(/<\/?v[^>]*>/g, '')); // strip VTT voice tags
    if (/[.?!]$/.test(line) && buf.join(' ').length > 400) flush();
  }
  flush();
  return out;
}

function toMs(h: string, m: string, s: string): number {
  return ((+h * 60 + +m) * 60 + +s) * 1000;
}

/** "Rahul Mehta <rahul@acme.com>; Priya (Acme); ops@acme.com" -> attendees */
export function parseAttendees(raw: string): Attendee[] {
  return raw
    .split(/[;\n]|,(?![^<(]*[>)])/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const email = p.match(/<?([\w.+-]+@[\w-]+\.[\w.-]+)>?/)?.[1];
      const org = p.match(/\(([^)]+)\)/)?.[1]?.trim();
      let name = p.replace(/<[^>]*>/, '').replace(/\([^)]*\)/, '').replace(email ?? '\u0000', '').trim();
      if (!name && email) {
        name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      return { name, email, org };
    })
    .filter(a => a.name);
}

export function formatAttendees(xs: Attendee[]): string {
  return xs
    .map(a => `${a.name}${a.org ? ` (${a.org})` : ''}${a.email ? ` <${a.email}>` : ''}`)
    .join('; ');
}

/** Speaker names found as "Name:" prefixes — offered as attendees on import. */
export function detectSpeakers(segments: TranscriptSegment[]): string[] {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const m = s.text.match(/^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}):\s/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([n]) => n);
}
