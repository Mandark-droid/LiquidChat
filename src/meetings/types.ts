export type MeetingStatus =
  | 'recording'
  | 'paused'
  | 'transcribing' // recording stopped, segments still in the STT queue
  | 'summarizing'
  | 'ready'
  | 'interrupted' // app died mid-recording; recoverable
  | 'error';

export type SegmentStatus = 'pending' | 'done' | 'skipped' | 'error';

export interface TranscriptSegment {
  index: number;
  /** Offset on the meeting's audio timeline (pauses excluded). */
  startMs: number;
  durationMs: number;
  wallStartMs: number;
  speechRatio: number;
  audioFile?: string; // file name inside the meeting's audio dir
  text: string;
  status: SegmentStatus;
  error?: string;
}

export interface Marker {
  atMs: number;
  note: string;
}

export interface Attendee {
  name: string;
  email?: string;
  org?: string;
}

export type ActionStatus = 'open' | 'done';
export type ActionPriority = 'high' | 'medium' | 'low';

export interface ActionItem {
  id: string;
  task: string;
  owner?: string;
  /** What was said ("by Friday"), kept for traceability. */
  dueText?: string;
  /** Resolved calendar date, YYYY-MM-DD. */
  dueDate?: string;
  priority?: ActionPriority;
  status: ActionStatus;
  createdAt: number;
  completedAt?: number;
  calendarAdded?: boolean;
  /** Added or edited by the user — survives minutes regeneration. */
  manual?: boolean;
}

export interface Minutes {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
  generatedAt: number;
  model: string;
  /** True once the user has edited anything — regeneration then asks first. */
  edited: boolean;
}

export type MeetingSource = 'recording' | 'import';

export interface Meeting {
  schemaVersion: 1;
  id: string;
  title: string;
  client?: string;
  project?: string;
  location?: string;
  agenda?: string;
  attendees: Attendee[];
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  status: MeetingStatus;
  source: MeetingSource;
  language: string;
  sttModel?: string;
  segments: TranscriptSegment[];
  markers: Marker[];
  minutes?: Minutes;
  actionItems: ActionItem[];
  nextMeeting?: string;
  notes?: string;
  audioDeleted?: boolean;
  error?: string;
  updatedAt: number;
}

export interface MeetingIndexEntry {
  id: string;
  title: string;
  client?: string;
  startedAt: number;
  durationMs: number;
  status: MeetingStatus;
  openActions: number;
  totalActions: number;
  hasMinutes: boolean;
  updatedAt: number;
}

export interface Letterhead {
  companyName: string;
  preparedBy: string;
  contactLine: string;
  footerNote: string;
  accentColor: string;
}

export interface MeetingSettings {
  sttModel: string;
  /** Whisper language code, or 'auto'. */
  language: string;
  /** Whisper task: transcribe in source language or translate to English. */
  task: 'transcribe' | 'translate';
  /** Feed client/attendee names + previous segment tail as a Whisper prompt. */
  contextPrompting: boolean;
  /** Extra vocabulary (product names, jargon) used to bias transcription. */
  vocabulary: string;
  summaryModel: string;
  audioSource: 'voice_recognition' | 'mic' | 'voice_communication' | 'camcorder';
  keepAudio: boolean;
  autoGenerateMinutes: boolean;
  indexForChat: boolean;
  letterhead: Letterhead;
}

export interface RecorderSegmentEvent {
  index: number;
  path: string;
  startMs: number;
  durationMs: number;
  wallStartMs: number;
  speechRatio: number;
  meanDb: number;
}

export interface RecorderLevelEvent {
  db: number;
  elapsedMs: number;
  isSpeech: boolean;
}

export interface RecorderStateEvent {
  state: 'recording' | 'paused' | 'stopped';
  elapsedMs: number;
}
