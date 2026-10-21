import { inflateRawSync, inflateSync } from 'node:zlib';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (unused, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (unused, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function paragraphText(xml) {
  const text = [...String(xml).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1])).join('');
  return text.replace(/\u00a0/g, ' ').trim();
}

function paragraphMarkdown(xml) {
  const text = paragraphText(String(xml).replace(/<w:(?:br|cr)(?:\s[^>]*)?\/?\s*>/g, '<w:t>\n</w:t>').replace(/<w:tab(?:\s[^>]*)?\/?\s*>/g, '<w:t>\t</w:t>'));
  if (!text) return '';
  const style = xml.match(/<w:pStyle(?:\s[^>]*)?w:val="([^"]+)"/i)?.[1] ?? '';
  const heading = style.match(/(?:Heading|标题)\s*([1-6])/i)?.[1];
  if (heading) return `${'#'.repeat(Number(heading))} ${text}`;
  if (/\bTitle\b|标题/i.test(style)) return `# ${text}`;
  if (/<w:numPr[\s>]/.test(xml)) return `- ${text}`;
  return text;
}

function tableMarkdown(xml) {
  const rows = [...String(xml).matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
    [...row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cell) => {
      const value = [...cell[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((part) => paragraphText(part[1])).filter(Boolean).join('<br>');
      return value.replace(/\|/g, '\\|');
    }),
  ).filter((row) => row.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalize = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
  const lines = [`| ${normalize(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(`| ${normalize(row).join(' | ')} |`);
  return lines.join('\n');
}

export function documentXmlToMarkdown(xml) {
  const body = String(xml ?? '').match(/<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/)?.[1] ?? String(xml ?? '');
  const blocks = [];
  for (const match of body.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const value = match[0].startsWith('<w:tbl') ? tableMarkdown(match[0]) : paragraphMarkdown(match[0]);
    if (value) blocks.push(value);
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function zipEntries(buffer, wanted) {
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('DOCX ZIP 目录缺失');
  const entries = Math.min(5000, buffer.readUInt16LE(eocd + 10));
  let offset = buffer.readUInt32LE(eocd + 16);
  const result = new Map();
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('DOCX ZIP 目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (wanted(name)) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX ZIP 文件头损坏');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      if (method === 0) result.set(name, compressed);
      else if (method === 8) result.set(name, inflateRawSync(compressed));
      else throw new Error(`Office 文件使用了不支持的压缩方式：${method}`);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return result;
}

export function isDocxAttachment(attachment) {
  return String(attachment?.type ?? '').toLowerCase() === DOCX_MIME || /\.docx$/i.test(String(attachment?.name ?? ''));
}

export function extractDocxMarkdown(attachment) {
  if (!isDocxAttachment(attachment)) return '';
  const match = String(attachment?.dataUrl ?? '').match(/^data:[^;,]*;base64,([a-z\d+/=]+)$/i);
  if (!match) return '';
  try {
    const xml = zipEntries(Buffer.from(match[1], 'base64'), (name) => name === 'word/document.xml').get('word/document.xml')?.toString('utf8');
    if (!xml) return '';
    return documentXmlToMarkdown(xml);
  } catch {
    return '';
  }
}

function attachmentBuffer(attachment) {
  const match = String(attachment?.dataUrl ?? '').match(/^data:[^;,]*;base64,([a-z\d+/=]+)$/i);
  return match ? Buffer.from(match[1], 'base64') : null;
}

export function isPptxAttachment(attachment) {
  return String(attachment?.type ?? '').toLowerCase() === PPTX_MIME || /\.pptx$/i.test(String(attachment?.name ?? ''));
}

export function extractPptxMarkdown(attachment) {
  if (!isPptxAttachment(attachment)) return '';
  const buffer = attachmentBuffer(attachment); if (!buffer) return '';
  try {
    const entries = zipEntries(buffer, (name) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/i.test(name));
    const numbers = [...entries.keys()].filter((name) => /ppt\/slides\/slide\d+\.xml$/i.test(name)).map((name) => Number(name.match(/slide(\d+)\.xml$/i)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
    return numbers.map((number) => {
      const slide = entries.get(`ppt/slides/slide${number}.xml`)?.toString('utf8') ?? '';
      const notes = entries.get(`ppt/notesSlides/notesSlide${number}.xml`)?.toString('utf8') ?? '';
      const lines = [...slide.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim()).filter(Boolean);
      const noteLines = [...notes.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim()).filter((text) => text && !/^\d+$/.test(text));
      const heading = lines.shift() || `幻灯片 ${number}`;
      return [`## 幻灯片 ${number}：${heading}`, ...lines.map((line) => `- ${line}`), ...(noteLines.length ? ['', '> 演讲者备注', ...noteLines.map((line) => `> ${line}`)] : [])].join('\n');
    }).join('\n\n').slice(0, 200000);
  } catch { return ''; }
}

export function isXlsxAttachment(attachment) {
  return String(attachment?.type ?? '').toLowerCase() === XLSX_MIME || /\.xlsx$/i.test(String(attachment?.name ?? ''));
}

function excelColumn(reference = '') {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function worksheetMarkdown(xml, shared, title) {
  const rows = [];
  for (const rowMatch of String(xml).matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c(?:\s([^>]*))?>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? ''; const cell = cellMatch[2];
      const column = excelColumn(attrs.match(/\br="([A-Z]+\d+)"/i)?.[1]);
      const type = attrs.match(/\bt="([^"]+)"/i)?.[1] ?? '';
      const raw = cell.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1]
        ?? cell.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/i)?.[1] ?? '';
      const value = type === 's' ? shared[Number(raw)] ?? '' : decodeXml(raw);
      while (row.length < column) row.push('');
      row[column] = String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    }
    if (row.some((value) => value !== '')) rows.push(row.slice(0, 40));
    if (rows.length >= 2000) break;
  }
  if (!rows.length) return `## ${title}\n\n（工作表为空）`;
  const width = Math.max(...rows.map((row) => row.length));
  const normalize = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
  return [`## ${title}`, '', `| ${normalize(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map((row) => `| ${normalize(row).join(' | ')} |`)].join('\n');
}

export function extractXlsxMarkdown(attachment) {
  if (!isXlsxAttachment(attachment)) return '';
  const buffer = attachmentBuffer(attachment); if (!buffer) return '';
  try {
    const entries = zipEntries(buffer, (name) => name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
    const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
    const shared = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((item) =>
      [...item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join(''),
    );
    const workbook = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
    const names = [...workbook.matchAll(/<sheet(?:\s[^>]*)?\bname="([^"]+)"[^>]*>/g)].map((match) => decodeXml(match[1]));
    const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1]) - Number(b.match(/sheet(\d+)/i)?.[1]));
    const body = sheets.map((name, index) => worksheetMarkdown(entries.get(name)?.toString('utf8') ?? '', shared, names[index] || `工作表 ${index + 1}`)).join('\n\n');
    return body ? `# ${String(attachment.name ?? 'Excel 笔记').replace(/\.xlsx$/i, '')}\n\n${body}`.slice(0, 200000) : '';
  } catch { return ''; }
}

function pdfString(value) {
  return String(value).replace(/\\([nrtbf()\\])/g, (unused, char) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[char] ?? char))
    .replace(/\\([0-7]{1,3})/g, (unused, octal) => String.fromCharCode(Number.parseInt(octal, 8))).replace(/\\\r?\n/g, '');
}

function pdfHex(value) {
  const bytes = Buffer.from(value.replace(/\s+/g, ''), 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = ''; for (let index = 2; index + 1 < bytes.length; index += 2) text += String.fromCharCode(bytes.readUInt16BE(index)); return text;
  }
  return bytes.toString('latin1');
}

function pdfOperators(text) {
  const out = [];
  for (const block of String(text).matchAll(/BT([\s\S]*?)ET/g)) {
    const source = block[1];
    for (const match of source.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|<([\da-f\s]+)>\s*Tj|\[((?:.|\r|\n)*?)\]\s*TJ/gi)) {
      if (match[0].startsWith('(')) out.push(pdfString(match[0].slice(1, match[0].lastIndexOf(')'))));
      else if (match[1]) out.push(pdfHex(match[1]));
      else for (const part of match[2].matchAll(/\((?:\\.|[^\\)])*\)|<([\da-f\s]+)>/gi)) out.push(part[0].startsWith('(') ? pdfString(part[0].slice(1, -1)) : pdfHex(part[1]));
    }
  }
  return out.join(' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '').replace(/[ \t]+/g, ' ').trim();
}

export function isPdfAttachment(attachment) {
  return String(attachment?.type ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(String(attachment?.name ?? ''));
}

export function extractPdfMarkdown(attachment) {
  if (!isPdfAttachment(attachment)) return '';
  const buffer = attachmentBuffer(attachment); if (!buffer) return '';
  try {
    const source = buffer.toString('latin1'); const chunks = [];
    // 自定义字体编码需要完整的 CMap 解码；把字形编号当 Latin-1 会生成乱码。
    // 这类文件保留原文件阅读，不能伪装成成功提取的正文。
    if (/\/ToUnicode\b|\/Subtype\s*\/Type0\b|\/Encoding\s*\/Identity-[HV]\b/.test(source)) return '';
    for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      const preceding = source.slice(0, match.index);
      const dictionary = preceding.slice(preceding.lastIndexOf('obj') + 3);
      if (/\/Subtype\s*\/(?:Image|OpenType)\b|\/FontFile[23]?\b/.test(dictionary)) continue;
      let bytes = Buffer.from(match[1], 'latin1');
      if (/\/FlateDecode\b/.test(dictionary)) { try { bytes = inflateSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }); } catch { continue; } }
      else if (/\/Filter\s*\//.test(dictionary)) continue;
      const text = pdfOperators(bytes.toString('latin1')); if (text) chunks.push(text);
    }
    const body = chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const invalid = [...body].filter((char) => /[\u007f-\u009f\ufffd]/.test(char)).length;
    if (invalid > Math.max(2, body.length * 0.01)) return '';
    return body ? `# ${String(attachment.name ?? 'PDF 笔记').replace(/\.pdf$/i, '')}\n\n${body}`.slice(0, 200000) : '';
  } catch { return ''; }
}

export function extractImportedDocument(attachment) {
  return extractDocxMarkdown(attachment) || extractPptxMarkdown(attachment) || extractXlsxMarkdown(attachment) || extractPdfMarkdown(attachment) || '';
}
