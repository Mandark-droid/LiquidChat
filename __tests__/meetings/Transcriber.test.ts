import {
  buildWhisperPrompt,
  cleanTranscript,
  isWhisperModel,
  type TranscribeJob,
} from '../../src/meetings/Transcriber';
import { runSourceInChild } from './fixtures';

/** Runs cleanTranscript in a child process so an infinite loop cannot hang Jest. */
function cleanTranscriptIsolated(inputs: string[]): string[] | null {
  const r = runSourceInChild({
    file: 'src/meetings/Transcriber.ts',
    body: `return ${JSON.stringify(inputs)}.map(i => mod.cleanTranscript(i));`,
    timeoutMs: 1500,
  });
  return r.ok ? (r.value as string[]) : null;
}

describe('cleanTranscript', () => {
  it('strips decoder-stall punctuation runs but keeps normal punctuation', () => {
    expect(cleanTranscript(',,,,,,,,,,,,, Good morning everyone. This is the sync, Rahul.')).toBe(
      'Good morning everyone. This is the sync, Rahul.',
    );
    expect(cleanTranscript(',,,,,,,,,,,,,,,,,, ,, , , . .')).toBe('');
  });

  it('isolated runner works for non-empty input (sanity check of the harness)', () => {
    expect(cleanTranscriptIsolated(['hello  world', '[BLANK_AUDIO]'])).toEqual(['hello world', '']);
  });

  // Regression (fixed; src/meetings/Transcriber.ts:69-75, collapseRepeats): for an empty
  // string (or whitespace / special-token-only output such as "<|endoftext|>")
  // `words` is [''], the n-gram is '' and slicing past the end also yields '',
  // so `while (... === gram) reps++` never terminates. cleanTranscript hangs the
  // JS thread — reachable from Transcriber.run (line 230) whenever Whisper
  // returns nothing, and from useVoiceInput.ts:190 (`result.response ?? ''`).
  // Run in a child process with a timeout so the suite cannot hang.
  it('returns "" for empty / blank / token-only output instead of looping forever', () => {
    expect(cleanTranscriptIsolated(['', '   ', '<|endoftext|>'])).toEqual(['', '', '']);
  });

  it('trims and collapses whitespace', () => {
    expect(cleanTranscript('  Hello \n\n  world\t again  ')).toBe('Hello world again');
  });

  it('removes stray Whisper special tokens', () => {
    expect(cleanTranscript('<|en|><|transcribe|> Send the deck <|endoftext|>')).toBe(
      'Send the deck',
    );
  });

  it.each([
    '[BLANK_AUDIO]',
    ' [BLANK_AUDIO] ',
    '[Music]',
    '[ Silence ]',
    '(music)',
    '(upbeat music playing)',
    '♪♪♪',
    '...',
    '…',
    ' - ',
    'Thank you.',
    'Thanks!',
    'thank you so much for watching!',
    'Thank you for watching.',
    'you',
    'Bye.',
    'Okay!',
    'Please subscribe to my channel',
    'Subtitles by the Amara.org community',
  ])('treats silence hallucination %p as empty', raw => {
    expect(cleanTranscript(raw)).toBe('');
  });

  it.each([
    'Thank you for the update on the budget.',
    'Okay, let us move to item two.',
    'You will send the SOW tomorrow.',
    'Bye for now, talk Friday.',
  ])('keeps real speech that merely starts like a hallucination: %p', raw => {
    expect(cleanTranscript(raw)).toBe(raw);
  });

  it('collapses decoder loops to two copies (single words and phrases)', () => {
    expect(cleanTranscript('the the the the the plan')).toBe('the the plan');
    expect(cleanTranscript('we will we will we will we will we will ship it')).toBe(
      'we will we will ship it',
    );
    expect(
      cleanTranscript(
        'Send it today. ' + 'and then we review '.repeat(6) + 'the numbers on Monday.',
      ),
    ).toBe('Send it today. and then we review and then we review the numbers on Monday.');
  });

  it('drops a whole-segment decoder loop, including hyphen-joined ones (Whisper on noise)', () => {
    expect(cleanTranscript('spea-' + 'courge-'.repeat(60) + 'c')).toBe('');
    expect(cleanTranscript('okay '.repeat(40))).toBe('');
    const real =
      'We agreed the budget is twenty lakh and Priya will send the revised proposal on Friday, ' +
      'then Rahul confirms the launch date with the client team next week.';
    expect(cleanTranscript(real)).toBe(real);
  });

  it('collapses repeats case-insensitively', () => {
    expect(cleanTranscript('Yes yes YES yes yes agreed')).toBe('Yes yes agreed');
  });

  it('leaves up to three natural repeats alone', () => {
    expect(cleanTranscript('no no no, that is wrong')).toBe('no no no, that is wrong');
    expect(cleanTranscript('very very very important')).toBe('very very very important');
  });

  it('a looped hallucination collapses to two copies (not filtered as a whole)', () => {
    expect(cleanTranscript('Thank you. Thank you. Thank you. Thank you. Thank you.')).toBe(
      'Thank you. Thank you.',
    );
  });

  // GAP (src/meetings/Transcriber.ts:46-54): hallucination/artifact filters only
  // match the WHOLE segment, so an artifact embedded in real speech survives and
  // ends up in the minutes ("Hello everyone. [BLANK_AUDIO] Let us begin.").
  it('strips [BLANK_AUDIO] / (music) markers embedded in speech', () => {
    expect(cleanTranscript('Hello everyone. [BLANK_AUDIO] Let us begin. (music)')).toBe(
      'Hello everyone. Let us begin.',
    );
  });
});

describe('isWhisperModel', () => {
  it.each([
    ['whisper-small', true],
    ['whisper-medium', true],
    ['whisper', true],
    ['moonshine-base', false],
    ['parakeet-tdt-0.6b', false],
    ['', false],
    ['openai-whisper', false],
  ])('%p -> %p', (slug, expected) => {
    expect(isWhisperModel(slug)).toBe(expected);
  });
});

describe('buildWhisperPrompt', () => {
  const job = (over: Partial<TranscribeJob> = {}): TranscribeJob => ({
    audioPath: '/tmp/seg_00001.wav',
    speechRatio: 0.7,
    glossary: 'Acme Corp, Rahul Mehta, Priya Shah, SOW',
    previousText: 'we agreed that the pilot starts next month',
    language: 'en',
    task: 'transcribe',
    contextPrompting: true,
    ...over,
  });
  const HEAD_EN = '<|startoftranscript|><|en|><|transcribe|><|notimestamps|>';

  it('without context prompting returns only the decoder header', () => {
    expect(buildWhisperPrompt(job({ contextPrompting: false }))).toBe(HEAD_EN);
  });

  it('omits the language token for auto-detect and honours translate', () => {
    expect(buildWhisperPrompt(job({ contextPrompting: false, language: 'auto' }))).toBe(
      '<|startoftranscript|><|transcribe|><|notimestamps|>',
    );
    expect(
      buildWhisperPrompt(job({ contextPrompting: false, language: 'hi', task: 'translate' })),
    ).toBe('<|startoftranscript|><|hi|><|translate|><|notimestamps|>');
  });

  it('includes client/attendee names and the previous tail before the header', () => {
    const p = buildWhisperPrompt(job());
    expect(p.startsWith('<|startofprev|> ')).toBe(true);
    expect(p.endsWith(HEAD_EN)).toBe(true);
    for (const name of ['Acme Corp', 'Rahul Mehta', 'Priya Shah']) expect(p).toContain(name);
    expect(p).toContain('we agreed that the pilot starts next month');
    expect(p.indexOf('Acme Corp')).toBeLessThan(p.indexOf('we agreed'));
  });

  it('falls back to the bare header when there is no context', () => {
    expect(buildWhisperPrompt(job({ glossary: '   ', previousText: '' }))).toBe(HEAD_EN);
  });

  it('uses whichever context part is present', () => {
    expect(buildWhisperPrompt(job({ previousText: '' }))).toBe(
      `<|startofprev|> Acme Corp, Rahul Mehta, Priya Shah, SOW${HEAD_EN}`,
    );
    expect(buildWhisperPrompt(job({ glossary: '' }))).toBe(
      `<|startofprev|> we agreed that the pilot starts next month${HEAD_EN}`,
    );
  });

  it('keeps only the last 240 chars of the previous segment', () => {
    const prev = 'x'.repeat(500) + ' TAIL-MARKER';
    const p = buildWhisperPrompt(job({ glossary: '', previousText: prev }));
    const ctx = p.slice('<|startofprev|> '.length, -HEAD_EN.length);
    expect(ctx.length).toBe(240);
    expect(ctx.endsWith('TAIL-MARKER')).toBe(true);
  });

  it('bounds the whole context to 400 chars, favouring the most recent text', () => {
    const glossary = Array.from({ length: 80 }, (_, i) => `Name${i}`).join(', ');
    const prev = 'y'.repeat(300) + ' latest words';
    const p = buildWhisperPrompt(job({ glossary, previousText: prev }));
    const ctx = p.slice('<|startofprev|> '.length, -HEAD_EN.length);
    expect(ctx.length).toBe(400);
    expect(p.length).toBe('<|startofprev|> '.length + 400 + HEAD_EN.length);
    expect(ctx.endsWith('latest words')).toBe(true);
  });
});
