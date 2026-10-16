import { useCallback, useEffect, useState } from 'react';
import { meetingStore } from './MeetingStore';
import { meetingSession, type LiveState } from './MeetingSession';
import { transcriber, type TranscriberStatus } from './Transcriber';
import type { Meeting, MeetingIndexEntry } from './types';

export function useMeetingList(): { meetings: MeetingIndexEntry[]; refresh: () => Promise<void> } {
  const [meetings, setMeetings] = useState<MeetingIndexEntry[]>([]);
  const refresh = useCallback(async () => setMeetings(await meetingStore.list()), []);
  useEffect(() => {
    refresh();
    return meetingStore.subscribe(() => { refresh(); });
  }, [refresh]);
  return { meetings, refresh };
}

/** Live meeting object; re-renders on every store write for that meeting. */
export function useMeeting(id: string | null): Meeting | null {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  useEffect(() => {
    if (!id) { setMeeting(null); return; }
    let alive = true;
    const load = async () => {
      const m = await meetingStore.get(id);
      // New object identity so React re-renders after in-place mutation.
      if (alive) setMeeting(m ? { ...m } : null);
    };
    load();
    const unsub = meetingStore.subscribe(load);
    return () => { alive = false; unsub(); };
  }, [id]);
  return meeting;
}

export function useLiveSession(): LiveState {
  const [s, setS] = useState<LiveState>(meetingSession.live);
  useEffect(() => meetingSession.subscribe(setS), []);
  return s;
}

export function useTranscriberStatus(): TranscriberStatus {
  const [s, setS] = useState<TranscriberStatus>(transcriber.getStatus());
  useEffect(() => transcriber.subscribe(setS), []);
  return s;
}
