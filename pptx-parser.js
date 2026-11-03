const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const decoder = new TextDecoder('utf-8');

function findEndRecord(view) {
  const lower = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= lower; offset--) if (view.getUint32(offset, true) === 0x06054b50) return offset;
  throw new Error('This file is not a readable PowerPoint ZIP archive.');
}

async function readZipDirectory(blob) {
  if (!(blob instanceof Blob)) throw new Error('The downloaded PowerPoint data is not a browser Blob.');
  const tailStart = Math.max(0, blob.size - 65557);
  const tail = await blob.slice(tailStart).arrayBuffer();
  const tailView = new DataView(tail), endInTail = findEndRecord(tailView), end = tailStart + endInTail;
  const count = tailView.getUint16(endInTail + 10, true), directorySize = tailView.getUint32(endInTail + 12, true), directoryOffset = tailView.getUint32(endInTail + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('This PowerPoint uses ZIP64, which this browser parser does not support yet.');
  if (directoryOffset + directorySize > end || directoryOffset < 0 || directorySize > 64 * 1024 * 1024) throw new Error('The PowerPoint archive index is invalid or too large.');
  const directoryBuffer = directoryOffset >= tailStart && directoryOffset + directorySize <= tailStart + tail.byteLength
    ? tail.slice(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
    : await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer();
  const view = new DataView(directoryBuffer);
  const files = new Map();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > view.byteLength) throw new Error('The PowerPoint archive index is truncated.');
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('The PowerPoint archive index is damaged.');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true), uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = new Uint8Array(directoryBuffer, cursor + 46, nameLength);
    const name = decoder.decode(nameBytes);
    files.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { blob, files };
}

async function readEntry(blob, zip, name) {
  const entry = zip.files.get(name);
  if (!entry) return null;
  if (entry.flags & 1) throw new Error(`The encrypted PowerPoint entry ${name} cannot be read.`);
  if (entry.uncompressedSize > 10 * 1024 * 1024) throw new Error(`The PowerPoint XML entry ${name} is unusually large to safely parse.`);
  const offset = entry.localOffset;
  const localHeader = await blob.slice(offset, offset + 30).arrayBuffer();
  const view = new DataView(localHeader);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error(`The PowerPoint entry ${name} is damaged.`);
  const start = offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const compressed = new Uint8Array(await blob.slice(start, start + entry.compressedSize).arrayBuffer());
  if (entry.method === 0) return decoder.decode(compressed);
  if (entry.method !== 8) throw new Error(`The compression type used by ${name} is not supported.`);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress PowerPoint files. Update Chrome, Edge, or Firefox and try again.');
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return decoder.decode(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error(`The browser could not decompress ${name}. The file may use an unsupported compression method.`);
  }
}

function decodeXmlText(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
  });
}
class XmlElement {
  constructor(qualifiedName, namespaceURI, attributes, namespaces) {
    const colon = qualifiedName.indexOf(':');
    this.nodeName = qualifiedName;
    this.localName = colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1);
    this.namespaceURI = namespaceURI || '';
    this.namespaces = namespaces;
    this.children = [];
    this.parentNode = null;
    this.text = '';
    this.attributes = attributes;
  }
  getAttribute(name) { return this.attributes.get(name)?.value || ''; }
  getAttributeNS(namespace, localName) {
    for (const attribute of this.attributes.values()) if (attribute.localName === localName && attribute.namespaceURI === namespace) return attribute.value;
    return '';
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  getElementsByTagNameNS(namespace, localName) {
    const found = [];
    const visit = parent => { for (const child of parent.children) { if ((namespace === '*' || child.namespaceURI === namespace) && (localName === '*' || child.localName === localName)) found.push(child); visit(child); } };
    visit(this);
    return found;
  }
}
class XmlDocument {
  constructor(root) { this.documentElement = root; }
  getElementsByTagNameNS(namespace, localName) { return this.documentElement.getElementsByTagNameNS(namespace, localName); }
  querySelector() { return null; }
}
function parseXml(xml, name) {
  if (!xml) return null;
  const tokens = xml.match(/<!--(?:.|\n|\r)*?-->|<!\[CDATA\[(?:.|\n|\r)*?\]\]>|<\?(?:.|\n|\r)*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g) || [];
  const rootNamespaces = { xml: 'http://www.w3.org/XML/1998/namespace' };
  const stack = [];
  let root = null;
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?') || /^<!DOCTYPE/i.test(token)) continue;
    if (token.startsWith('<![CDATA[')) { if (stack.length) stack.at(-1).text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      const closing = token.slice(2, -1).trim();
      if (!stack.length || stack.at(-1).nodeName !== closing) throw new Error(`The PowerPoint contains malformed XML in ${name}.`);
      stack.pop(); continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const inside = token.slice(1, selfClosing ? token.lastIndexOf('/') : -1).trim();
      const nameMatch = inside.match(/^([^\s/>]+)/);
      if (!nameMatch) continue;
      const qualifiedName = nameMatch[1], rawAttributes = new Map();
      const attributeSource = inside.slice(nameMatch[0].length);
      const attrPattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let match;
      while ((match = attrPattern.exec(attributeSource))) {
        const qName = match[1], colon = qName.indexOf(':');
        rawAttributes.set(qName, { value: decodeXmlText(match[2] ?? match[3] ?? ''), localName: colon < 0 ? qName : qName.slice(colon + 1), prefix: colon < 0 ? '' : qName.slice(0, colon) });
      }
      const namespaces = { ...(stack.at(-1)?.namespaces || rootNamespaces) };
      for (const [key, value] of rawAttributes) {
        if (key === 'xmlns') namespaces[''] = value.value;
        else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value.value;
      }
      const prefix = qualifiedName.includes(':') ? qualifiedName.split(':', 1)[0] : '';
      const attributes = new Map();
      for (const [key, value] of rawAttributes) {
        const attrNamespace = value.prefix && value.prefix !== 'xmlns' ? namespaces[value.prefix] || '' : '';
        attributes.set(key, { ...value, namespaceURI: attrNamespace });
      }
      const element = new XmlElement(qualifiedName, namespaces[prefix] || '', attributes, namespaces);
      if (stack.length) { element.parentNode = stack.at(-1); stack.at(-1).children.push(element); }
      else if (!root) root = element;
      else throw new Error(`The PowerPoint contains more than one XML root in ${name}.`);
      if (!selfClosing) stack.push(element);
      continue;
    }
    if (stack.length) stack.at(-1).text += decodeXmlText(token);
  }
  if (!root || stack.length) throw new Error(`The PowerPoint contains incomplete XML in ${name}.`);
  return new XmlDocument(root);
}
const descendants = (node, namespace, tag) => [...(node?.getElementsByTagNameNS(namespace, tag) || [])];
const childElements = node => [...(node?.children || [])];
function normalizePath(path) {
  const stack = [];
  for (const segment of path.replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop(); else stack.push(segment);
  }
  return stack.join('/');
}
function resolveTarget(basePath, target) {
  if (target.startsWith('/')) return normalizePath(target);
  return normalizePath(`${basePath}/${target}`);
}
function relationshipMap(doc) {
  return new Map([...doc?.getElementsByTagNameNS('*', 'Relationship') || []].map(rel => [rel.getAttribute('Id'), rel]));
}
function shapeText(shape) {
  const txBody = descendants(shape, P_NS, 'txBody')[0];
  if (!txBody) return '';
  const paragraphs = descendants(txBody, A_NS, 'p');
  return paragraphs.map(paragraph => {
    const content = descendants(paragraph, A_NS, 't').map(item => item.textContent || '').join('').trim();
    if (!content) return '';
    const props = childElements(paragraph).find(child => child.localName === 'pPr');
    const isBullet = props && childElements(props).some(child => ['buChar', 'buAutoNum'].includes(child.localName));
    return `${isBullet ? '• ' : ''}${content}`;
  }).filter(Boolean).join('\n');
}
function extractTitle(slideDoc, shapes) {
  for (const shape of shapes) {
    const placeholder = descendants(shape, P_NS, 'ph')[0];
    if (['title', 'ctrTitle'].includes(placeholder?.getAttribute('type'))) {
      const title = shapeText(shape).split('\n').find(Boolean);
      if (title) return title;
    }
  }
  return shapes.map(shapeText).find(Boolean)?.split('\n').find(Boolean) || '';
}
function extractTables(slideDoc) {
  const tables = [];
  for (const table of descendants(slideDoc, A_NS, 'tbl')) {
    const rows = childElements(table).filter(node => node.localName === 'tr').map(row =>
      childElements(row).filter(node => node.localName === 'tc').map(cell => descendants(cell, A_NS, 't').map(t => t.textContent || '').join('').trim())
    ).filter(row => row.some(Boolean));
    if (rows.length) tables.push(rows);
  }
  return tables;
}
function extractImageDescriptions(slideDoc) {
  return descendants(slideDoc, P_NS, 'pic').map(pic => descendants(pic, P_NS, 'cNvPr')[0])
    .map(properties => properties?.getAttribute('descr') || properties?.getAttribute('title') || '')
    .map(text => text.trim()).filter(Boolean);
}
function extractChartReferences(slideDoc) {
  return [...(slideDoc?.getElementsByTagNameNS('*', 'chart') || [])].map(chart => chart.getAttributeNS(R_NS, 'id')).filter(Boolean);
}
function extractChartText(chartDoc) {
  if (!chartDoc) return '';
  const strings = descendants(chartDoc, A_NS, 't').map(node => node.textContent || '').filter(Boolean);
  const numbers = descendants(chartDoc, 'http://schemas.openxmlformats.org/drawingml/2006/chart', 'v').map(node => node.textContent || '').filter(Boolean);
  return [...new Set([...strings, ...numbers])].join(' · ');
}
function extractNotesText(notesDoc) {
  if (!notesDoc) return '';
  return descendants(notesDoc, P_NS, 'sp').map(shape => {
    const placeholder = descendants(shape, P_NS, 'ph')[0];
    if (['sldNum', 'dt', 'hdr', 'ftr', 'sldImg'].includes(placeholder?.getAttribute('type'))) return '';
    return shapeText(shape);
  }).filter(Boolean).join('\n').trim();
}

function limitTableText(tables, maxChars = 1200) {
  let remaining = maxChars;
  const limited = [];
  for (const table of tables.slice(0, 3)) {
    const rows = [];
    for (const row of table.slice(0, 20)) {
      if (remaining <= 0) break;
      const cells = [];
      for (const cell of row.slice(0, 12)) {
        if (remaining <= 0) break;
        const value = String(cell).slice(0, Math.min(180, remaining));
        cells.push(value);
        remaining -= value.length;
      }
      rows.push(cells);
    }
    if (rows.length) limited.push(rows);
    if (remaining <= 0) break;
  }
  return limited;
}

export async function inspectPptx(buffer) {
  const zip = await readZipDirectory(buffer);
  const presentation = parseXml(await readEntry(buffer, zip, 'ppt/presentation.xml'), 'presentation.xml');
  const presentationRels = parseXml(await readEntry(buffer, zip, 'ppt/_rels/presentation.xml.rels'), 'presentation relationships');
  if (!presentation || !presentationRels) throw new Error('This file does not contain a PowerPoint presentation.');
  const relationships = relationshipMap(presentationRels);
  const slideList = descendants(presentation, P_NS, 'sldIdLst')[0];
  const slideEntries = childElements(slideList).map(item => relationships.get(item.getAttributeNS(R_NS, 'id'))).filter(Boolean)
    .map(rel => resolveTarget('ppt', rel.getAttribute('Target')));
  if (!slideEntries.length) throw new Error('No slides were found in this presentation.');
  return { zip, slideEntries };
}

export async function extractPptxBatch(buffer, inspection, startIndex, batchSize = 10) {
  const { zip, slideEntries } = inspection;
  const slides = [];
  const end = Math.min(slideEntries.length, startIndex + batchSize);
  for (let index = startIndex; index < end; index++) {
    const path = slideEntries[index], xml = await readEntry(buffer, zip, path), slideDoc = parseXml(xml, path);
    const shapes = descendants(slideDoc, P_NS, 'sp');
    const blocks = shapes.map(shapeText).filter(Boolean);
    const title = extractTitle(slideDoc, shapes);
    const tables = limitTableText(extractTables(slideDoc));
    const imageDescriptions = extractImageDescriptions(slideDoc);
    const relPath = path.replace(/([^/]+\.xml)$/, '_rels/$1.rels');
    const slideRelsDoc = parseXml(await readEntry(buffer, zip, relPath), relPath);
    const slideRels = relationshipMap(slideRelsDoc);
    let notes = '';
    const notesRel = [...slideRels.values()].find(rel => (rel.getAttribute('Type') || '').endsWith('/notesSlide'));
    if (notesRel) {
      const notesPath = resolveTarget(path.slice(0, path.lastIndexOf('/')), notesRel.getAttribute('Target'));
      notes = extractNotesText(parseXml(await readEntry(buffer, zip, notesPath), notesPath));
    }
    const chartData = [];
    for (const chartId of extractChartReferences(slideDoc)) {
      const chartRel = slideRels.get(chartId);
      if (!chartRel) continue;
      const chartPath = resolveTarget(path.slice(0, path.lastIndexOf('/')), chartRel.getAttribute('Target'));
      const chartText = extractChartText(parseXml(await readEntry(buffer, zip, chartPath), chartPath));
      if (chartText) chartData.push(chartText);
    }
    slides.push({
      slideNumber: index + 1,
      title: title.slice(0, 300),
      text: blocks.join('\n').slice(0, 4200),
      tables,
      notes: notes.slice(0, 900),
      imageDescriptions: imageDescriptions.slice(0, 8).map(text => text.slice(0, 120)),
      chartData: chartData.slice(0, 3).map(text => text.slice(0, 260)),
      extractedAt: new Date().toISOString(),
    });
  }
  return { slides, nextIndex: end, totalSlides: slideEntries.length };
}

export { PPTX_MIME };
