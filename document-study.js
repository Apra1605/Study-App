let activeDocumentId = null;
let cachedDocuments;

export function setActiveDocument(documentId) { activeDocumentId = documentId || null; }
export function clearActiveDocument() { activeDocumentId = null; }
export function getActiveDocumentId() { return activeDocumentId; }

async function loadDocuments() {
  if (cachedDocuments) return cachedDocuments;
  const firebase = await window.studyspaceFirebaseReady;
  const user = await firebase.currentUser();
  if (!user) return [];
  cachedDocuments = await firebase.listDriveDocuments();
  return cachedDocuments;
}
export function clearDocumentMetadataCache() { cachedDocuments = null; }

export async function availableDocuments() {
  const available = new Set(['ready', 'extracted', 'analysis_paused', 'analyzing', 'awaiting_ai']);
  return (await loadDocuments())
    .filter(document => document.originalFileId && available.has(document.processingStatus))
    .sort((a, b) => String(a.originalName || '').localeCompare(String(b.originalName || '')));
}

async function loadSlides(document) {
  const firebase = await window.studyspaceFirebaseReady;
  const chunks = await firebase.listDriveSlideChunks(document.id);
  const slides = chunks.flatMap(chunk => chunk.slides || []).sort((a, b) => a.slideNumber - b.slideNumber);
  const analysis = await firebase.listDriveAnalysis(document.id);
  const cachedSlideSummaryCount = analysis.reduce((sum, item) => sum + (item.slides?.length || 0), 0);
  if (cachedSlideSummaryCount < slides.length) {
    console.info('Some presentation slide summaries are not available in Realtime Database yet.');
  }
  const summaries = new Map(analysis.flatMap(batch => (batch.slides || []).map(item => [Number(item.slideNumber), item])));
  return slides.map(slide => ({ ...slide, aiSummary: summaries.get(slide.slideNumber)?.summary || '', concepts: summaries.get(slide.slideNumber)?.concepts || [] }));
}
function tokens(text) { return new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 100)); }
function slideText(slide) {
  return [slide.title && `Title: ${slide.title}`, slide.aiSummary && `Slide summary: ${slide.aiSummary}`, slide.concepts?.length && `Key concepts: ${slide.concepts.join(', ')}`, slide.text && `Text: ${slide.text}`, slide.tables?.length && `Tables: ${slide.tables.map(table => table.map(row => row.join(' | ')).join(' / ')).join('; ')}`, slide.notes && `Speaker notes: ${slide.notes}`, slide.imageDescriptions?.length && `Image descriptions: ${slide.imageDescriptions.join('; ')}`, slide.chartData?.length && `Chart: ${slide.chartData.join('; ')}`].filter(Boolean).join('\n');
}

export async function contextForSubject(subjectId, query, limit = 5, requestedDocumentId) {
  const docs = (await loadDocuments()).filter(document => document.originalFileId && ['ready', 'extracted', 'analysis_paused', 'analyzing', 'awaiting_ai'].includes(document.processingStatus));
  let selectedDocumentId = requestedDocumentId === undefined ? activeDocumentId : requestedDocumentId;
  let scoped = selectedDocumentId ? docs.filter(document => document.id === selectedDocumentId) : docs.filter(document => document.subjectId === subjectId);
  if (selectedDocumentId && !scoped.length) {
    if (requestedDocumentId === undefined) activeDocumentId = null;
    selectedDocumentId = null;
    scoped = docs.filter(document => document.subjectId === subjectId);
  }
  if (!scoped.length) return '';
  const queryWords = tokens(query);
  const requestedSlide = String(query).match(/\bslides?\s*(\d{1,4})\b/i)?.[1];
  const titleWords = selectedDocumentId ? tokens(scoped[0].originalName || '') : new Set();
  const titleMatches = [...titleWords].filter(word => queryWords.has(word)).length;
  const fullDeckReview = Boolean(selectedDocumentId && (/(whole|entire|all slides|full presentation|full deck|presentation review|study this deck)/i.test(String(query)) || (titleWords.size > 0 && titleMatches >= Math.min(2, titleWords.size))));
  if (fullDeckReview && scoped[0].summary) {
    const document = scoped[0];
    const sections = (document.tableOfContents || []).slice(0, 40).map(section => `[Source: ${document.originalName}, slides ${section.slides || '?'}] ${String(section.title || 'Section').slice(0, 35)} — ${String(section.summary || '').replace(/\s+/g, ' ').slice(0, 45)}`);
    const themes = (document.majorThemes || []).slice(0, 6).map(theme => String(theme).slice(0, 50));
    return `[Full-presentation review: cover every listed section and spread questions across the deck. Cite the source slide ranges.]\n[Source: ${document.originalName}, entire presentation] Overview: ${String(document.summary).slice(0, 500)}\nMajor themes: ${themes.join('; ')}\n${sections.join('\n')}`.slice(0, 3050);
  }
  const ranked = [];
  for (const document of scoped) {
    let slides;
    try { slides = await loadSlides(document); } catch (error) { console.warn('Could not load imported slide text', error); continue; }
    const docTokens = tokens(`${document.originalName || ''} ${(document.topicOutline || []).join(' ')}`);
    let slideRanking = slides.map(slide => {
      const text = slideText(slide), slideWords = tokens(text);
      let score = 0;
      if (requestedSlide && slide.slideNumber === Number(requestedSlide)) score += 1000;
      for (const word of queryWords) {
        if (slideWords.has(word)) score += 2;
        if (docTokens.has(word) && (slide.title || '').toLowerCase().includes(word)) score += 1;
      }
      if (!queryWords.size) score = slides.length - slide.slideNumber + 1;
      return { slide, text, score };
    }).filter(item => item.score > 0 || !queryWords.size).sort((a, b) => b.score - a.score || a.slide.slideNumber - b.slide.slideNumber);
    if (selectedDocumentId && !slideRanking.length) slideRanking = slides.slice(0, limit).map((slide, index) => ({ slide, text: slideText(slide), score: 0 - index }));
    for (const item of slideRanking.slice(0, limit)) ranked.push({ ...item, document });
  }
  ranked.sort((a, b) => b.score - a.score || a.slide.slideNumber - b.slide.slideNumber);
  let output = '';
  const overviewUsed = new Set();
  for (const item of ranked.slice(0, limit)) {
    const doc = item.document;
    const cite = `[Source: ${doc.originalName || 'Presentation'}, slide ${item.slide.slideNumber}]`;
    const excerpt = item.text.slice(0, 850);
    const overview = doc.summary && !overviewUsed.has(doc.id) && (queryWords.size === 0 || (doc.topicOutline || []).some(topic => [...queryWords].some(word => topic.toLowerCase().includes(word))))
      ? `Presentation overview (${doc.originalName}): ${String(doc.summary).slice(0, 500)}\n` : '';
    overviewUsed.add(doc.id);
    output += `${overview}${cite}\n${excerpt}\n\n`;
  }
  return output.slice(0, 4800).trim();
}

export async function topicsForSubject(subjectId) {
  const docs = (await loadDocuments()).filter(document => document.subjectId === subjectId && (document.topicOutline || []).length && ['ready', 'extracted', 'analysis_paused', 'analyzing', 'awaiting_ai'].includes(document.processingStatus));
  return [...new Set(docs.flatMap(document => document.topicOutline || []))].slice(0, 100);
}

