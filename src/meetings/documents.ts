import * as RNFS from '@dr.pogodin/react-native-fs';
import JSZip from 'jszip';

import { meetingStore } from './MeetingStore';
import { formatClock, transcriptLines } from './MinutesGenerator';
import { Docs } from './native';
import { getMeetingSettings } from './settings';
import type { ActionItem, Letterhead, Meeting } from './types';

/**
 * Client-ready MoM documents. Layout is deterministic and identical across
 * formats: header, meeting details, summary, discussion, decisions, action
 * items table, open questions, next steps, (optional) transcript appendix.
 */

export type ExportFormat = 'pdf' | 'docx' | 'md' | 'txt';

export interface ExportOptions {
  format: ExportFormat;
  includeTranscript: boolean;
  includeCompleted: boolean; // done action items
}

const BRAND = 'LiquidChat';
const GENERATED_BY = 'Generated on-device by LiquidChat';

const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  txt: 'text/plain',
};

// ---------------------------------------------------------------------------
// Shared view model

interface DocModel {
  title: string;
  brand: string;
  details: [string, string][];
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actions: ActionItem[];
  openQuestions: string[];
  nextSteps: string[];
  nextMeeting?: string;
  transcript: string[];
  footer: string;
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(ms: number) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}
export function fmtDue(a: ActionItem): string {
  if (a.dueDate) {
    const [y, m, d] = a.dueDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  return a.dueText ?? '—';
}

function model(
  m: Meeting,
  lh: Letterhead,
  opts: Pick<ExportOptions, 'includeTranscript' | 'includeCompleted'>,
): DocModel {
  const details: [string, string][] = [
    ['Date', fmtDate(m.startedAt)],
    ['Time', `${fmtTime(m.startedAt)}${m.endedAt ? ` – ${fmtTime(m.endedAt)}` : ''}`],
  ];
  if (m.durationMs > 0) details.push(['Duration', fmtDuration(m.durationMs)]);
  if (m.client) details.push(['Client', m.client]);
  if (m.project) details.push(['Project', m.project]);
  if (m.location) details.push(['Location', m.location]);
  if (m.attendees.length) {
    details.push([
      'Attendees',
      m.attendees.map(a => (a.org ? `${a.name} (${a.org})` : a.name)).join(', '),
    ]);
  }
  if (m.agenda) details.push(['Agenda', m.agenda]);
  if (lh.preparedBy) details.push(['Prepared by', lh.preparedBy]);

  const mn = m.minutes;
  return {
    title: m.title,
    brand: lh.companyName.trim() || BRAND,
    details,
    summary: mn?.summary ?? '',
    keyPoints: mn?.keyPoints ?? [],
    decisions: mn?.decisions ?? [],
    actions: m.actionItems.filter(a => opts.includeCompleted || a.status === 'open'),
    openQuestions: mn?.openQuestions ?? [],
    nextSteps: mn?.nextSteps ?? [],
    nextMeeting: m.nextMeeting,
    transcript: opts.includeTranscript ? transcriptLines(m) : [],
    footer: [lh.footerNote, lh.contactLine, GENERATED_BY].filter(Boolean).join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Markdown / plain text

export function buildMinutesMarkdown(
  m: Meeting,
  lh?: Letterhead,
  opts = { includeTranscript: false, includeCompleted: true },
): string {
  const d = model(
    m,
    lh ?? { companyName: '', preparedBy: '', contactLine: '', footerNote: '', accentColor: '' },
    opts,
  );
  const out: string[] = [`# ${d.title}`, `*Minutes of Meeting — ${d.brand}*`, ''];
  for (const [k, v] of d.details) out.push(`**${k}:** ${v}  `);
  const list = (h: string, xs: string[]) => {
    if (xs.length) out.push('', `## ${h}`, ...xs.map(x => `- ${x}`));
  };
  if (d.summary) out.push('', '## Summary', d.summary);
  list('Key discussion points', d.keyPoints);
  list('Decisions', d.decisions);
  if (d.actions.length) {
    out.push(
      '',
      '## Action items',
      '| # | Action | Owner | Due | Status |',
      '|---|---|---|---|---|',
    );
    d.actions.forEach((a, i) =>
      out.push(
        `| ${i + 1} | ${a.task.replace(/\|/g, '/')} | ${a.owner ?? '—'} | ${fmtDue(a)} | ${a.status === 'done' ? 'Done' : 'Open'} |`,
      ),
    );
  }
  list('Open questions', d.openQuestions);
  list('Next steps', d.nextSteps);
  if (d.nextMeeting) out.push('', `**Next meeting:** ${d.nextMeeting}`);
  if (d.transcript.length) out.push('', '## Transcript', ...d.transcript.map(l => `${l}  `));
  out.push('', '---', `_${d.footer}_`);
  return out.join('\n');
}

function buildPlainText(m: Meeting, lh: Letterhead, opts: ExportOptions): string {
  return buildMinutesMarkdown(m, lh, opts)
    .replace(/^#+ /gm, '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/^\|[-| ]+\|$/gm, '')
    .replace(/^\| /gm, '')
    .replace(/ \|$/gm, '')
    .replace(/ \| /g, ' — ');
}

/** Short message body for WhatsApp/email when sharing the file. */
export function shareBlurb(m: Meeting): string {
  const open = m.actionItems.filter(a => a.status === 'open');
  const lines = [`Minutes: ${m.title} (${fmtDate(m.startedAt)})`];
  if (m.minutes?.summary) lines.push('', m.minutes.summary);
  if (open.length) {
    lines.push('', 'Action items:');
    open
      .slice(0, 8)
      .forEach(a =>
        lines.push(
          `• ${a.task}${a.owner ? ` — ${a.owner}` : ''}${a.dueDate || a.dueText ? ` (${fmtDue(a)})` : ''}`,
        ),
      );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML (for PDF)

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeColor(c: string) {
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3A8FB7';
}

export function buildMinutesHtml(m: Meeting, lh: Letterhead, opts: ExportOptions): string {
  const d = model(m, lh, opts);
  const accent = safeColor(lh.accentColor);
  const list = (h: string, xs: string[]) =>
    xs.length ? `<h2>${esc(h)}</h2><ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const actions = d.actions.length
    ? `<h2>Action items</h2><table class="actions"><thead><tr><th>#</th><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${d.actions
        .map(
          (a, i) =>
            `<tr class="${a.status}"><td>${i + 1}</td><td>${esc(a.task)}</td><td>${esc(a.owner ?? '—')}</td><td class="nowrap">${esc(fmtDue(a))}</td><td><span class="pill ${a.status}">${a.status === 'done' ? 'Done' : 'Open'}</span></td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  const transcript = d.transcript.length
    ? `<div class="pagebreak"></div><h2>Appendix — Transcript</h2><div class="transcript">${d.transcript
        .map(l => `<p>${esc(l)}</p>`)
        .join('')}</div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Roboto', 'Noto Sans', 'Noto Sans Devanagari', Arial, sans-serif; color: #1f2328; font-size: 10.5pt; line-height: 1.45; margin: 0; }
  .band { width: 100%; border-collapse: collapse; border-top: 5px solid ${accent}; }
  .band td { padding-top: 10px; vertical-align: baseline; }
  .brand { font-weight: 700; font-size: 11pt; color: ${accent}; letter-spacing: .3px; }
  .doctype { text-align: right; font-size: 9pt; color: #6b7280; text-transform: uppercase; letter-spacing: 1.2px; }
  h1 { font-size: 19pt; margin: 10px 0 12px; line-height: 1.2; }
  h2 { font-size: 12pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e5e7eb; color: #111827; page-break-after: avoid; }
  table.meta { width: 100%; border-collapse: collapse; background: #f8fafc; border: 1px solid #e5e7eb; }
  table.meta td { padding: 5px 9px; vertical-align: top; border-bottom: 1px solid #eef0f3; }
  table.meta td.k { width: 22%; color: #6b7280; font-weight: 600; white-space: nowrap; }
  p.summary { margin: 4px 0 0; }
  ul { margin: 4px 0 0 18px; padding: 0; } li { margin: 2px 0; }
  table.actions { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 10pt; }
  table.actions th { background: ${accent}; color: #fff; text-align: left; padding: 6px 8px; font-weight: 600; }
  table.actions td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.actions tr { page-break-inside: avoid; }
  table.actions td:first-child { width: 26px; color: #6b7280; }
  .nowrap { white-space: nowrap; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 8.5pt; font-weight: 600; }
  .pill.open { background: #fff4e5; color: #b45309; } .pill.done { background: #e7f6ec; color: #15803d; }
  tr.done td { color: #6b7280; }
  .next { margin-top: 14px; padding: 8px 10px; border-left: 3px solid ${accent}; background: #f8fafc; }
  .transcript p { margin: 2px 0; font-size: 9pt; color: #374151; }
  .pagebreak { page-break-before: always; }
  .footer { margin-top: 26px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 8pt; color: #6b7280; }
</style></head><body>
<table class="band"><tr><td class="brand">${esc(d.brand)}</td><td class="doctype">Minutes of Meeting</td></tr></table>
<h1>${esc(d.title)}</h1>
<table class="meta">${d.details.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${d.summary ? `<h2>Summary</h2><p class="summary">${esc(d.summary)}</p>` : ''}
${list('Key discussion points', d.keyPoints)}
${list('Decisions', d.decisions)}
${actions}
${list('Open questions', d.openQuestions)}
${list('Next steps', d.nextSteps)}
${d.nextMeeting ? `<div class="next"><b>Next meeting:</b> ${esc(d.nextMeeting)}</div>` : ''}
${transcript}
<div class="footer">${esc(d.footer)}</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// DOCX (WordprocessingML, built by hand — no native deps)

const x = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip characters illegal in XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function run(text: string, props = ''): string {
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
}
function para(content: string, style?: string, extra = ''): string {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${content}</w:p>`;
}
function bullet(text: string): string {
  return para(run(text), 'ListBullet');
}
function cell(content: string, widthTw: number, shade?: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTw}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}</w:tcPr>${content}</w:tc>`;
}
function table(rows: string[][], widths: number[], headerFill?: string): string {
  const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const body = rows
    .map((r, ri) => {
      const isHead = ri === 0 && !!headerFill;
      return `<w:tr>${isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${r
        .map((c, ci) =>
          cell(
            para(run(c, isHead ? '<w:b/><w:color w:val="FFFFFF"/>' : ''), 'TableText'),
            widths[ci],
            isHead ? headerFill : undefined,
          ),
        )
        .join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="LCTable"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

export async function buildMinutesDocxBase64(
  m: Meeting,
  lh: Letterhead,
  opts: ExportOptions,
): Promise<string> {
  const d = model(m, lh, opts);
  const accent = safeColor(lh.accentColor).replace('#', '').slice(0, 6).toUpperCase();
  const parts: string[] = [];
  parts.push(
    para(
      run(d.brand.toUpperCase(), `<w:b/><w:color w:val="${accent}"/><w:sz w:val="18"/>`) +
        run('   ·   MINUTES OF MEETING', '<w:color w:val="6B7280"/><w:sz w:val="18"/>'),
    ),
  );
  parts.push(para(run(d.title), 'Title'));
  parts.push(
    table(
      d.details.map(([k, v]) => [k, v]),
      [2200, 7438],
    ),
  );

  const section = (h: string, xs: string[]) => {
    if (!xs.length) return;
    parts.push(para(run(h), 'Heading1'));
    xs.forEach(t => parts.push(bullet(t)));
  };
  if (d.summary) {
    parts.push(para(run('Summary'), 'Heading1'));
    parts.push(para(run(d.summary)));
  }
  section('Key discussion points', d.keyPoints);
  section('Decisions', d.decisions);
  if (d.actions.length) {
    parts.push(para(run('Action items'), 'Heading1'));
    parts.push(
      table(
        [
          ['#', 'Action', 'Owner', 'Due', 'Status'],
          ...d.actions.map((a, i) => [
            String(i + 1),
            a.task,
            a.owner ?? '—',
            fmtDue(a),
            a.status === 'done' ? 'Done' : 'Open',
          ]),
        ],
        [500, 4938, 1700, 1500, 1000],
        accent,
      ),
    );
  }
  section('Open questions', d.openQuestions);
  section('Next steps', d.nextSteps);
  if (d.nextMeeting) parts.push(para(run('Next meeting: ', '<w:b/>') + run(d.nextMeeting)));
  if (d.transcript.length) {
    parts.push(para('', undefined, '<w:pageBreakBefore/>'));
    parts.push(para(run('Appendix — Transcript'), 'Heading1'));
    d.transcript.forEach(l => parts.push(para(run(l, '<w:sz w:val="18"/>'))));
  }

  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${parts.join('')}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${W}>${para(run(d.footer, '<w:color w:val="6B7280"/><w:sz w:val="16"/>') + run('   Page ', '<w:color w:val="6B7280"/><w:sz w:val="16"/>') + '<w:r><w:rPr><w:color w:val="6B7280"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')}</w:ftr>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Mangal" w:eastAsia="Calibri"/><w:sz w:val="21"/><w:color w:val="1F2328"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="E5E7EB"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/><w:color w:val="111827"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="LCTable"><w:name w:val="LiquidChat Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E5E7EB"/><w:left w:val="single" w:sz="4" w:color="E5E7EB"/><w:bottom w:val="single" w:sz="4" w:color="E5E7EB"/><w:right w:val="single" w:sz="4" w:color="E5E7EB"/><w:insideH w:val="single" w:sz="4" w:color="E5E7EB"/><w:insideV w:val="single" w:sz="4" w:color="E5E7EB"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(d.title)}</dc:title><dc:creator>${x(lh.preparedBy || BRAND)}</dc:creator><dc:description>${x(GENERATED_BY)}</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(m.startedAt).toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
  );
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/numbering.xml', numberingXml);
  zip.file('word/footer1.xml', footerXml);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// Export + delivery

export function exportFileName(m: Meeting, format: ExportFormat): string {
  const d = new Date(m.startedAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const slug = (m.client ? `${m.client} ` : '') + m.title;
  const safe =
    slug
      .replace(/[^\wऀ-ॿ -]+/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'Meeting';
  return `MoM_${date}_${safe}.${format}`;
}

/** Writes the document to the meeting's exports folder and returns its path. */
export async function exportMinutes(
  meetingId: string,
  opts: ExportOptions,
): Promise<{ path: string; mime: string; name: string }> {
  const m = await meetingStore.get(meetingId);
  if (!m) throw new Error('Meeting not found');
  const { letterhead } = await getMeetingSettings();
  const dir = meetingStore.exportsDir(meetingId);
  await RNFS.mkdir(dir);
  const name = exportFileName(m, opts.format);
  const path = `${dir}/${name}`;

  switch (opts.format) {
    case 'pdf':
      await Docs.renderPdf(buildMinutesHtml(m, letterhead, opts), path);
      break;
    case 'docx':
      await RNFS.writeFile(path, await buildMinutesDocxBase64(m, letterhead, opts), 'base64');
      break;
    case 'md':
      await RNFS.writeFile(path, buildMinutesMarkdown(m, letterhead, opts), 'utf8');
      break;
    case 'txt':
      await RNFS.writeFile(path, buildPlainText(m, letterhead, opts), 'utf8');
      break;
  }
  return { path, mime: MIME[opts.format], name };
}

export async function shareMinutes(
  meetingId: string,
  opts: ExportOptions,
  email = false,
): Promise<void> {
  const m = await meetingStore.get(meetingId);
  if (!m) throw new Error('Meeting not found');
  const file = await exportMinutes(meetingId, opts);
  const emails = m.attendees.map(a => a.email).filter((e): e is string => !!e && /@/.test(e));
  await Docs.shareFile(file.path, {
    mime: file.mime,
    subject: `Minutes of Meeting — ${m.title} (${fmtDate(m.startedAt)})`,
    text: shareBlurb(m),
    emails: email ? emails : undefined,
    emailOnly: email,
    chooserTitle: email ? 'Email minutes' : 'Share minutes',
  });
}

export async function saveMinutesToDownloads(
  meetingId: string,
  opts: ExportOptions,
): Promise<string> {
  const file = await exportMinutes(meetingId, opts);
  await Docs.saveToDownloads(file.path, file.name, file.mime);
  return `Downloads/LiquidChat/${file.name}`;
}

export { formatClock };
