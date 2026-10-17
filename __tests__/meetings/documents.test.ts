import JSZip from 'jszip';

import {
  buildMinutesDocxBase64,
  buildMinutesHtml,
  buildMinutesMarkdown,
  exportFileName,
  type ExportOptions,
  fmtDue,
  shareBlurb,
} from '../../src/meetings/documents';
import type { Letterhead } from '../../src/meetings/types';
import { action, EMPTY_LETTERHEAD, makeMeeting, MEETING_TS, seg } from './fixtures';

const LH: Letterhead = {
  companyName: 'Thakkar Consulting',
  preparedBy: 'Kshitij',
  contactLine: 'hello@example.com',
  footerNote: 'Confidential',
  accentColor: '#112233',
};
const OPTS: ExportOptions = { format: 'pdf', includeTranscript: false, includeCompleted: true };

describe('fmtDue', () => {
  it('formats a resolved date as "D Mon YYYY" without time-zone drift', () => {
    expect(fmtDue(action({ task: 't', dueDate: '2026-10-23' }))).toBe('23 Oct 2026');
    expect(fmtDue(action({ task: 't', dueDate: '2027-01-01' }))).toBe('1 Jan 2027');
  });

  it('prefers the resolved date over the spoken phrase', () => {
    expect(fmtDue(action({ task: 't', dueDate: '2026-10-23', dueText: 'by Friday' }))).toBe(
      '23 Oct 2026',
    );
  });

  it('falls back to the spoken phrase, then an em dash', () => {
    expect(fmtDue(action({ task: 't', dueText: 'after the board meeting' }))).toBe(
      'after the board meeting',
    );
    expect(fmtDue(action({ task: 't' }))).toBe('—');
  });
});

describe('buildMinutesMarkdown', () => {
  it('renders all sections in order with the default LiquidChat brand', () => {
    const md = buildMinutesMarkdown(makeMeeting());
    expect(md.startsWith('# Acme kickoff\n*Minutes of Meeting — LiquidChat*')).toBe(true);
    expect(md).toContain('**Client:** Acme  ');
    expect(md).toContain('**Attendees:** Rahul Mehta (Acme), Priya  ');
    expect(md).toContain('**Duration:** 45 min  ');
    const order = [
      '## Summary',
      '## Key discussion points',
      '## Decisions',
      '## Action items',
      '## Open questions',
      '## Next steps',
    ].map(h => md.indexOf(h));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain('| 1 | Send revised proposal | Priya | 23 Oct 2026 | Open |');
    expect(md).toContain('| 2 | Book follow-up call | Rahul Mehta | — | Done |');
    expect(md.trimEnd()).toMatch(
      /!\[LiquidChat\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\) \*\*LiquidChat\*\* · Generated using LiquidChat$/,
    );
  });

  it('never mentions TraceVerse', () => {
    expect(buildMinutesMarkdown(makeMeeting(), LH)).not.toMatch(/traceverse/i);
  });

  it('uses the letterhead brand, prepared-by and footer pieces', () => {
    const md = buildMinutesMarkdown(makeMeeting(), LH);
    expect(md).toContain('*Minutes of Meeting — Thakkar Consulting*');
    expect(md).toContain('**Prepared by:** Kshitij  ');
    expect(md).toContain('_Confidential · hello@example.com_');
    expect(md).toContain('**LiquidChat** · Generated using LiquidChat');
  });

  it('escapes table pipes in action text', () => {
    const md = buildMinutesMarkdown(
      makeMeeting({ actionItems: [action({ task: 'Compare A | B options' })] }),
    );
    expect(md).toContain('| 1 | Compare A / B options | — | — | Open |');
  });

  it('filters completed actions when includeCompleted is false', () => {
    const md = buildMinutesMarkdown(makeMeeting(), undefined, {
      includeTranscript: false,
      includeCompleted: false,
    });
    expect(md).toContain('Send revised proposal');
    expect(md).not.toContain('Book follow-up call');
  });

  it('appends the transcript and next meeting when present', () => {
    const md = buildMinutesMarkdown(
      makeMeeting({ nextMeeting: 'Tue 20 Oct, 11:00', markers: [{ atMs: 0, note: 'Start' }] }),
      undefined,
      { includeTranscript: true, includeCompleted: true },
    );
    expect(md).toContain('**Next meeting:** Tue 20 Oct, 11:00');
    expect(md).toContain('## Transcript');
    expect(md).toContain('[00:30] Priya: I will send the revised proposal by Friday.  ');
    expect(md).toContain('★ FLAGGED BY USER: Start');
  });

  it('omits empty sections for a meeting without minutes', () => {
    const md = buildMinutesMarkdown(
      makeMeeting({ minutes: undefined, actionItems: [], attendees: [], client: undefined }),
    );
    for (const h of ['## Summary', '## Decisions', '## Action items', '## Transcript', 'Client']) {
      expect(md).not.toContain(h);
    }
    expect(md).toContain('**LiquidChat** · Generated using LiquidChat');
  });

  it('formats durations of an hour or more as "h min"', () => {
    expect(buildMinutesMarkdown(makeMeeting({ durationMs: 95 * 60_000 }))).toContain(
      '**Duration:** 1 h 35 min',
    );
    expect(buildMinutesMarkdown(makeMeeting({ durationMs: 0 }))).not.toContain('Duration');
  });
});

describe('buildMinutesHtml', () => {
  const evil = makeMeeting({
    title: '<script>alert("x")</script> & Co',
    client: 'Acme <b>Corp</b>',
    attendees: [{ name: '<img src=x onerror=alert(1)>', org: 'O"rg' }],
    actionItems: [action({ task: 'Fix <a href="javascript:x">link</a>', owner: '<i>me</i>' })],
    minutes: {
      summary: 'Summary with <iframe>',
      keyPoints: ['<style>body{}</style>'],
      decisions: ['A & B'],
      openQuestions: [],
      nextSteps: [],
      generatedAt: MEETING_TS,
      model: 'm',
      edited: false,
    },
    nextMeeting: '<marquee>',
  });

  it('HTML-escapes the title and every piece of user content', () => {
    const html = buildMinutesHtml(evil, { ...LH, companyName: '<Evil Inc>' }, OPTS);
    expect(html).toContain(
      '<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co</title>',
    );
    expect(html).toContain('<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co</h1>');
    expect(html).not.toMatch(/<script/i);
    // The only image is the template's own embedded logo.
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('<img src="data:image/png;base64,');
    for (const raw of ['<img src=x', '<iframe', '<marquee', '<i>me', '<b>Corp', '<a href']) {
      expect(html).not.toContain(raw);
    }
    expect(html.match(/<style>/g)).toHaveLength(1); // only the template's own stylesheet
    expect(html).toContain('&lt;Evil Inc&gt;');
    expect(html).toContain('Acme &lt;b&gt;Corp&lt;/b&gt;');
    expect(html).toContain('O&quot;rg');
    expect(html).toContain('<li>A &amp; B</li>');
  });

  it('ignores an unsafe accent colour (CSS injection) and falls back to the default', () => {
    const html = buildMinutesHtml(
      makeMeeting(),
      { ...LH, accentColor: 'red;}</style><script>alert(1)</script>' },
      OPTS,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('border-top: 5px solid #3A8FB7');
    expect(buildMinutesHtml(makeMeeting(), LH, OPTS)).toContain('border-top: 5px solid #112233');
  });

  it('has the LiquidChat footer and never TraceVerse', () => {
    const html = buildMinutesHtml(makeMeeting(), EMPTY_LETTERHEAD, OPTS);
    expect(html).toContain('<b>LiquidChat</b><span> · Generated using LiquidChat</span>');
    expect(html).toMatch(
      /<div class="lc"><img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="LiquidChat"\/>/,
    );
    expect(html).not.toContain('class="note"'); // blank letterhead: no empty org line
    expect(html).toContain('<td class="brand">LiquidChat</td>');
    expect(html).not.toMatch(/traceverse/i);
  });

  it('renders the action table with status pills and an optional transcript appendix', () => {
    const html = buildMinutesHtml(makeMeeting(), LH, { ...OPTS, includeTranscript: true });
    expect(html).toContain('<span class="pill open">Open</span>');
    expect(html).toContain('<span class="pill done">Done</span>');
    expect(html).toContain('<td class="nowrap">23 Oct 2026</td>');
    expect(html).toContain('Appendix — Transcript');
    expect(buildMinutesHtml(makeMeeting(), LH, OPTS)).not.toContain('Appendix');
  });
});

describe('buildMinutesDocxBase64', () => {
  async function unzip(b64: string) {
    const zip = await JSZip.loadAsync(b64, { base64: true });
    const read = (p: string) => zip.file(p)!.async('string');
    return { zip, read };
  }

  it('produces a valid OOXML package with the expected parts', async () => {
    const { zip } = await unzip(await buildMinutesDocxBase64(makeMeeting(), LH, OPTS));
    const files = Object.values(zip.files)
      .filter(f => !f.dir)
      .map(f => f.name)
      .sort();
    expect(files).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'word/_rels/document.xml.rels',
        'word/_rels/footer1.xml.rels',
        'word/media/liquidchat.png',
        'word/document.xml',
        'word/footer1.xml',
        'word/numbering.xml',
        'word/styles.xml',
      ].sort(),
    );
  });

  it('document.xml contains the title, sections and action items', async () => {
    const { read } = await unzip(await buildMinutesDocxBase64(makeMeeting(), LH, OPTS));
    const doc = await read('word/document.xml');
    expect(doc).toContain('>Acme kickoff</w:t>');
    expect(doc).toContain('>Send revised proposal</w:t>');
    expect(doc).toContain('>Book follow-up call</w:t>');
    expect(doc).toContain('>23 Oct 2026</w:t>');
    expect(doc).toContain('>Action items</w:t>');
    expect(doc).toContain('>Go with the fixed-price model</w:t>');
    expect(doc).toContain('<w:shd w:val="clear" w:color="auto" w:fill="112233"/>');
    expect(doc).toContain('THAKKAR CONSULTING');
    expect(doc).not.toMatch(/traceverse/i);
  });

  it('XML-escapes user content and strips illegal control characters', async () => {
    const m = makeMeeting({
      title: 'R&D <Q4> "plan"\u0007',
      actionItems: [action({ task: 'Review <draft> & sign\u0001', owner: 'A&B' })],
    });
    const { read } = await unzip(await buildMinutesDocxBase64(m, LH, OPTS));
    const doc = await read('word/document.xml');
    expect(doc).toContain('>R&amp;D &lt;Q4&gt; &quot;plan&quot;</w:t>');
    expect(doc).toContain('>Review &lt;draft&gt; &amp; sign</w:t>');
    expect(doc).toContain('>A&amp;B</w:t>');
    expect(doc).not.toContain('<Q4>');
    // eslint-disable-next-line no-control-regex
    expect(doc).not.toMatch(/[\u0001\u0007]/);
    const core = await read('docProps/core.xml');
    expect(core).toContain('<dc:title>R&amp;D &lt;Q4&gt; &quot;plan&quot;</dc:title>');
    expect(core).toContain('<dc:description>Generated using LiquidChat</dc:description>');
    expect(core).toContain(`${new Date(MEETING_TS).toISOString().replace(/\.\d+Z$/, 'Z')}`);
  });

  it('footer carries the LiquidChat attribution', async () => {
    const { read } = await unzip(
      await buildMinutesDocxBase64(makeMeeting(), EMPTY_LETTERHEAD, OPTS),
    );
    const footer = await read('word/footer1.xml');
    expect(footer).toContain('Generated using LiquidChat');
    expect(footer).toContain(' LiquidChat</w:t>');
    expect(footer).toContain('<a:blip r:embed="rIdLogo"/>');
    expect(await read('word/_rels/footer1.xml.rels')).toContain('Target="media/liquidchat.png"');
    expect(await read('[Content_Types].xml')).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
  });

  it('keeps the LiquidChat footer even with a custom organisation letterhead', async () => {
    const { read } = await unzip(await buildMinutesDocxBase64(makeMeeting(), LH, OPTS));
    const footer = await read('word/footer1.xml');
    expect(footer).toContain('Generated using LiquidChat');
    expect(footer).toContain('Confidential · hello@example.com');
    expect(buildMinutesHtml(makeMeeting(), LH, OPTS)).toContain('Generated using LiquidChat');
  });

  it('adds a transcript appendix only on request and drops done items when asked', async () => {
    const m = makeMeeting();
    const withT = await unzip(
      await buildMinutesDocxBase64(m, LH, {
        ...OPTS,
        includeTranscript: true,
        includeCompleted: false,
      }),
    );
    const doc = await withT.read('word/document.xml');
    expect(doc).toContain('Appendix — Transcript');
    expect(doc).toContain('<w:pageBreakBefore/>');
    expect(doc).not.toContain('Book follow-up call');
    const plain = await (
      await unzip(await buildMinutesDocxBase64(m, LH, OPTS))
    ).read('word/document.xml');
    expect(plain).not.toContain('Appendix');
  });
});

describe('exportFileName', () => {
  it('builds MoM_<date>_<client>_<title>.<ext>', () => {
    expect(exportFileName(makeMeeting(), 'pdf')).toBe('MoM_2026-10-16_Acme_Acme_kickoff.pdf');
    expect(exportFileName(makeMeeting({ client: undefined, title: 'Weekly sync' }), 'docx')).toBe(
      'MoM_2026-10-16_Weekly_sync.docx',
    );
  });

  it('removes path separators and other unsafe characters', () => {
    const name = exportFileName(
      makeMeeting({ client: 'A/B: Co.', title: 'Q4 \\ review? <draft> *final* | "v2"' }),
      'md',
    );
    expect(name).toBe('MoM_2026-10-16_AB_Co_Q4_review_draft_final_v2.md');
    expect(name).toMatch(/^[\w.-]+$/);
  });

  it('keeps Devanagari and truncates long names to 60 chars', () => {
    expect(exportFileName(makeMeeting({ client: undefined, title: 'बैठक सारांश' }), 'txt')).toBe(
      'MoM_2026-10-16_बैठक_सारांश.txt',
    );
    const long = exportFileName(makeMeeting({ client: undefined, title: 'x'.repeat(200) }), 'pdf');
    expect(long).toBe(`MoM_2026-10-16_${'x'.repeat(60)}.pdf`);
  });

  it('falls back to "Meeting" when nothing safe is left', () => {
    expect(exportFileName(makeMeeting({ client: undefined, title: '<<>>/??' }), 'pdf')).toBe(
      'MoM_2026-10-16_Meeting.pdf',
    );
  });
});

describe('shareBlurb', () => {
  // ICU versions differ on "16 Oct 2026" vs "16 Oct, 2026" for en-IN.
  const HEADER = /^Minutes: Acme kickoff \(Fri, 16 Oct,? 2026\)$/;

  it('lists the summary and open action items with owner and due', () => {
    const lines = shareBlurb(makeMeeting()).split('\n');
    expect(lines[0]).toMatch(HEADER);
    expect(lines.slice(1)).toEqual([
      '',
      'Kickoff of the Acme engagement.',
      '',
      'Action items:',
      '• Send revised proposal — Priya (23 Oct 2026)',
      '',
      '— Generated using LiquidChat',
    ]);
  });

  it('caps the list at 8 open items and omits empty parts', () => {
    const many = Array.from({ length: 10 }, (_, i) => action({ task: `Task ${i}` }));
    const blurb = shareBlurb(makeMeeting({ minutes: undefined, actionItems: many }));
    expect(blurb.split('\n').filter(l => l.startsWith('•'))).toHaveLength(8);
    expect(blurb).toContain('• Task 0');
    expect(blurb).not.toContain('Task 8');
    expect(shareBlurb(makeMeeting({ minutes: undefined, actionItems: [] })).split('\n')).toEqual([
      expect.stringMatching(HEADER),
      '',
      '— Generated using LiquidChat',
    ]);
  });

  it('shows the spoken due phrase when no date was resolved', () => {
    const blurb = shareBlurb(
      makeMeeting({ actionItems: [action({ task: 'Call back', dueText: 'after lunch' })] }),
    );
    expect(blurb).toContain('• Call back (after lunch)');
  });

  it('works for imported untimed transcripts too (segments are not used)', () => {
    const blurb = shareBlurb(makeMeeting({ segments: [seg(0, 'x', -1)] }));
    expect(blurb.startsWith('Minutes: Acme kickoff')).toBe(true);
  });
});
