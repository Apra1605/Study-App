import * as localDb from './document-db.js?v=20261102-1';
import * as drive from './drive-client.js?v=20261102-2';
import * as documentAI from './document-ai.js?v=20261102-3';
import * as documentStudy from './document-study.js?v=20261102-2';

const EXTRACTION_VERSION = 'pptx-xml-v1';
const BATCH_SIZE = 10;
const ANALYSIS_BATCH_SIZE = 20;
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const foldersBySubject = new Map();
let renderEpoch = 0;
let busy = false;
let filesPendingAssignment = [];
let activeProgressPercent = 0;
let watchedDocumentsUid = null;
let stopWatchingDocuments = null;
const legacyMigrationByUid = new Map();

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uiToast = message => window.studyspaceApp?.showToast?.(message) || console.info(message);
const appState = () => window.studyspaceApp?.getState?.();
const formatDate = value => value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fileStem = name => String(name || 'Presentation').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || 'Presentation';
const localKeyFor = (uid, documentId) => `${uid}:${documentId}`;

function selectedSubject() {
  const state = appState();
  return state?.subjects?.find(subject => subject.id === $('#driveImportSubject')?.value) || state?.subjects?.[0] || null;
}
function updateSubjectOptions() {
  const select = $('#driveImportSubject');
  if (!select) return;
  const previous = select.value;
  const subjects = appState()?.subjects || [];
  select.innerHTML = subjects.map(subject => `<option value="${esc(subject.id)}">${esc(subject.name)}</option>`).join('');
  if (subjects.some(subject => subject.id === previous)) select.value = previous;
}
function setStatus(message, kind = '') {
  const el = $('#driveImportStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = `drive-import-status${kind ? ` ${kind}` : ''}`;
}
function setActiveProgress(fileName, stage, percent, detail = '', kind = '') {
  const panel = $('#driveActiveProgress');
  if (!panel) return;
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  activeProgressPercent = value;
  panel.hidden = false;
  panel.classList.toggle('is-complete', value === 100 && !kind);
  panel.classList.toggle('is-error', Boolean(kind === 'error'));
  $('#driveProgressName').textContent = fileName || 'Presentation import';
  $('#driveProgressPercent').textContent = `${value}%`;
  $('#driveProgressStage').textContent = stage || '';
  $('#driveProgressDetail').textContent = detail || '';
  const track = panel.querySelector('[role="progressbar"]');
  track.setAttribute('aria-valuenow', String(value));
  track.setAttribute('aria-valuetext', `${value}% · ${stage || 'Importing'}`);
  $('#driveProgressFill').style.width = `${value}%`;
}
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function withTimeout(promise, milliseconds, operation) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation} timed out. Reconnect and resume to continue.`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
function refreshConnectionStatus(user) {
  const status = $('#driveConnectionStatus');
  if (!status) return;
  const connected = drive.isConnected(user?.uid);
  status.textContent = connected ? `Connected${user?.email ? ` · ${user.email}` : ''}` : 'Drive not connected';
  status.classList.toggle('connected', connected);
}
function showImportAssignments(files) {
  const subjects = appState()?.subjects || [];
  if (!subjects.length) return setStatus('Add a subject before importing a presentation.', 'error');
  const defaultSubject = selectedSubject()?.id || subjects[0].id;
  $('#driveImportAssignments').innerHTML = files.map((file, index) => `<div class="drive-import-assignment"><div><strong>${esc(file.name)}</strong><small>${file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : 'PowerPoint presentation'}</small></div><label>Destination subject<select data-file-subject="${index}">${subjects.map(subject => `<option value="${esc(subject.id)}" ${subject.id === defaultSubject ? 'selected' : ''}>${esc(subject.name)}</option>`).join('')}</select></label></div>`).join('');
  filesPendingAssignment = files;
  $('#driveImportReviewDialog').showModal();
}

function documentStatus(document) {
  if (document.processingStatus === 'ready') return { text: 'Ready for study tools', percent: 100 };
  if (document.processingStatus === 'extracting' || document.processingStatus === 'downloading') {
    const percent = document.totalSlides ? Math.round((document.processedSlides || 0) / document.totalSlides * 100) : (document.processingStatus === 'downloading' ? 4 : 0);
    return { text: document.processingStatus === 'downloading' ? 'Downloading from Drive' : `Extracted ${document.processedSlides || 0} of ${document.totalSlides || '…'} slides`, percent };
  }
  if (document.processingStatus === 'analyzing') return { text: `AI analysis ${document.aiProgress || 0}%`, percent: document.aiProgress || 0 };
  if (document.processingStatus === 'analysis_paused') return { text: 'Text saved · AI analysis paused', percent: 100, error: document.error };
  if (document.processingStatus === 'awaiting_ai') return { text: 'Text saved · AI analysis not started', percent: 100 };
  if (document.processingStatus === 'extracted') return { text: 'Slides extracted and saved', percent: 100, error: document.error };
  if (document.processingStatus === 'error') return { text: 'Needs attention · resume available', percent: document.extractionProgress || 0, error: document.error };
  return { text: 'Import queued', percent: 0 };
}
function renderDocumentCards(documents) {
  const list = $('#driveDocumentList');
  if (!list) return;
  if (!documents.length) {
    list.innerHTML = '<div class="drive-library-empty">Imported PowerPoint presentations will appear here.</div>';
    return;
  }
  list.innerHTML = documents.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || ''))).map(document => {
    const progress = documentStatus(document), isReady = document.processingStatus === 'ready' || document.processingStatus === 'extracted' || document.processingStatus === 'analysis_paused' || document.processingStatus === 'awaiting_ai';
    const topics = (document.topicOutline || []).slice(0, 8);
    const pageLink = document.extractedTextUrl || (document.extractedTextFileId ? `https://drive.google.com/file/d/${encodeURIComponent(document.extractedTextFileId)}/view` : '');
    const canResume = !['ready'].includes(document.processingStatus);
    return `<article class="drive-document-card" data-document-id="${esc(document.id)}">
      <div class="drive-document-state ${progress.error ? 'error' : ''}"><span>${esc(progress.text)}</span><span>${progress.percent}%</span></div>
      <div class="drive-document-progress" role="progressbar" aria-valuenow="${progress.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress.percent}%"></span></div>
      <h3>${esc(document.originalName || 'PowerPoint presentation')}</h3>
      <div class="drive-document-meta"><span>${esc(document.subjectName || 'Subject')}</span><span>${document.totalSlides || document.processedSlides || 0} slides</span><span>${formatDate(document.importedAt)}</span></div>
      ${progress.error ? `<p class="drive-document-error">${esc(progress.error)}</p>` : ''}
      ${document.syncError ? `<p class="drive-document-error">Realtime Database sync needs attention: ${esc(document.syncError)}</p>` : ''}
      <div class="drive-document-actions">
        ${canResume ? `<button class="button button-secondary" data-resume="${esc(document.id)}">${document.processingStatus === 'analysis_paused' || document.processingStatus === 'awaiting_ai' || document.processingStatus === 'extracted' ? 'Resume AI analysis' : 'Resume import'}</button>` : ''}
        ${isReady ? `<button class="button button-secondary" data-view-text="${esc(document.id)}">View extracted text</button><button class="button button-secondary" data-study-doc="${esc(document.id)}">Study this deck</button><button class="button button-secondary" data-quiz-doc="${esc(document.id)}">Make a quiz</button><button class="button button-secondary" data-cards-doc="${esc(document.id)}">Make flashcards</button>` : ''}
        ${pageLink ? `<a class="button button-secondary" href="${esc(pageLink)}" target="_blank" rel="noopener">Open Drive text</a>` : ''}
        ${document.syncError && document.totalSlides ? `<button class="button button-secondary" data-sync-doc="${esc(document.id)}">Retry cloud sync</button>` : ''}
      </div>
      <details class="drive-document-details"><summary>Presentation details</summary><p><strong>Status:</strong> ${esc(document.processingStatus || 'queued')} · <strong>Processed:</strong> ${formatDate(document.processedAt)}</p><p><strong>Original:</strong> ${esc(document.originalName || '')} · ${esc(document.originalFileId || '')}</p>${document.summary ? `<p><strong>Overview:</strong> ${esc(document.summary)}</p>` : ''}${topics.length ? `<p><strong>Topics:</strong> ${topics.map(esc).join(' · ')}</p>` : ''}${document.imageTextNote ? `<p>${esc(document.imageTextNote)}</p>` : ''}</details>
    </article>`;
  }).join('');
  bindDocumentCardActions(documents);
}
function bindDocumentCardActions(documents) {
  const list = $('#driveDocumentList');
  list.querySelectorAll('[data-resume]').forEach(button => button.onclick = async () => {
    const document = documents.find(item => item.id === button.dataset.resume);
    if (!document) return;
    if (document.processingStatus === 'extracted' || document.processingStatus === 'analysis_paused' || document.processingStatus === 'awaiting_ai') await resumeAnalysis(document);
    else await resumeImport(document);
  });
  list.querySelectorAll('[data-view-text]').forEach(button => button.onclick = () => viewExtractedText(documents.find(item => item.id === button.dataset.viewText)));
  list.querySelectorAll('[data-study-doc]').forEach(button => button.onclick = () => openStudy(documentFor(documents, button.dataset.studyDoc), 'tutor'));
  list.querySelectorAll('[data-quiz-doc]').forEach(button => button.onclick = () => openStudy(documentFor(documents, button.dataset.quizDoc), 'practice'));
  list.querySelectorAll('[data-cards-doc]').forEach(button => button.onclick = () => openStudy(documentFor(documents, button.dataset.cardsDoc), 'cards'));
  list.querySelectorAll('[data-sync-doc]').forEach(button => button.onclick = () => syncExistingDocument(documentFor(documents, button.dataset.syncDoc)));
}
function documentFor(documents, id) { return documents.find(item => item.id === id); }
function openStudy(document, action) {
  if (!document) return;
  documentStudy.setActiveDocument(document.id);
  const state = appState();
  const subject = state?.subjects?.find(item => item.id === document.subjectId);
  if (!subject) return uiToast('This presentation’s subject is no longer available. Reassign it by importing the presentation again.');
  if (action === 'tutor') {
    window.studyspaceApp?.openTutor?.(subject.id);
    window.setTimeout(() => { const input = $('#chatInput'); if (input) { input.value = `Help me study ${fileStem(document.originalName)}. Start with its main ideas and cite slide numbers.`; input.focus(); } }, 50);
  } else {
    const select = $('#practiceSubject'); if (select) select.value = subject.id;
    const topic = $('#practiceTopic'); if (topic) topic.value = fileStem(document.originalName);
    window.studyspaceApp?.navigate?.('practice');
    if (action === 'cards') window.setTimeout(() => $('#generateCards')?.click(), 50);
    else window.setTimeout(() => $('#generateQuiz')?.click(), 50);
  }
}

async function getFirebase() {
  const firebase = await window.studyspaceFirebaseReady;
  if (firebase.error) throw new Error(`Firebase did not initialize: ${firebase.error.message || firebase.error}`);
  const user = await firebase.currentUser();
  if (!user) throw new Error('Sign in with Google before importing presentations.');
  return { firebase, user };
}
async function tryWriteMetadata(firebase, documentId, metadata, job) {
  try {
    const saved = await withTimeout(firebase.writeDriveDocument(documentId, metadata), 8000, 'Firebase metadata sync');
    Object.assign(metadata, saved);
    job.metadata = { ...metadata };
    documentStudy.clearDocumentMetadataCache();
    return true;
  } catch (error) {
    throw new Error(`Could not save presentation progress to Realtime Database: ${error.message || error}`);
  }
}
async function loadDocumentCollection(firebase, user) {
  let cloudDocuments = [];
  let cloudError = '';
  try { cloudDocuments = await firebase.listDriveDocuments(); }
  catch (error) { cloudError = error.message || String(error); }
  return { documents: cloudDocuments, cloudError };
}
async function migrateLegacyDocumentCache(firebase, user) {
  const cached = (await localDb.listJobs()).filter(job => job.userId === user.uid && (job.documentId || job.firestoreId));
  for (const job of cached) {
    const documentId = job.documentId || job.firestoreId;
    const [cloudDocument, localSlides, localAnalysis, remoteChunks, remoteAnalysis] = await Promise.all([
      firebase.getDriveDocument(documentId), localDb.getSlides(job.id), localDb.getAnalysis(job.id),
      firebase.listDriveSlideChunks(documentId), firebase.listDriveAnalysis(documentId),
    ]);
    const localMetadata = job.metadata || {};
    const localTime = Date.parse(localMetadata.updatedAt || '') || 0;
    const cloudTime = Date.parse(cloudDocument?.updatedAt || '') || 0;
    const metadata = {
      ...(localTime > cloudTime ? cloudDocument || {} : localMetadata),
      ...(localTime > cloudTime ? localMetadata : cloudDocument || {}),
      documentId, syncError: '',
    };
    const remoteSlides = remoteChunks.flatMap(chunk => chunk.slides || []);
    const slidesByNumber = new Map(remoteSlides.map(slide => [Number(slide.slideNumber), slide]));
    for (const slide of localSlides) if (!slidesByNumber.has(Number(slide.slideNumber))) slidesByNumber.set(Number(slide.slideNumber), slide);
    const mergedSlides = [...slidesByNumber.values()].filter(slide => Number.isFinite(Number(slide.slideNumber))).sort((a, b) => a.slideNumber - b.slideNumber);
    if (mergedSlides.length > remoteSlides.length) await syncSlideChunks(firebase, documentId, mergedSlides);
    const analysisByIndex = new Map(remoteAnalysis.map(item => [Number(item.batchIndex), item]));
    for (const item of localAnalysis) if (!analysisByIndex.has(Number(item.batchIndex))) analysisByIndex.set(Number(item.batchIndex), item);
    for (const item of localAnalysis) {
      const current = analysisByIndex.get(Number(item.batchIndex));
      if (current === item) {
        const batchId = Number(item.batchIndex) >= 1_000_000 ? 'presentation_summary' : `batch_${String(item.batchIndex).padStart(5, '0')}`;
        await firebase.writeDriveAnalysis(documentId, batchId, item);
      }
    }
    if (mergedSlides.length) {
      metadata.totalSlides = Math.max(Number(metadata.totalSlides) || 0, mergedSlides.length);
      metadata.processedSlides = Math.max(Number(metadata.processedSlides) || 0, mergedSlides.length);
      metadata.extractionProgress = metadata.totalSlides ? Math.round(metadata.processedSlides / metadata.totalSlides * 100) : 100;
    }
    await firebase.writeDriveDocument(documentId, metadata);
    const totalSlides = Number(metadata.totalSlides) || 0;
    if (totalSlides > 0 && mergedSlides.length >= totalSlides) await localDb.deleteSource(job.id).catch(() => {});
    await localDb.deleteLegacyDocumentCache(job.id);
  }
}
async function ensureLegacyCacheMigrated(firebase, user) {
  if (legacyMigrationByUid.has(user.uid)) return legacyMigrationByUid.get(user.uid);
  const migration = migrateLegacyDocumentCache(firebase, user).catch(error => {
    legacyMigrationByUid.delete(user.uid);
    throw error;
  });
  legacyMigrationByUid.set(user.uid, migration);
  return migration;
}
async function refreshLibrary() {
  const epoch = ++renderEpoch;
  documentStudy.clearDocumentMetadataCache();
  try {
    updateSubjectOptions();
    const { firebase, user } = await getFirebase();
    if (epoch !== renderEpoch) return;
    refreshConnectionStatus(user);
    try { await ensureLegacyCacheMigrated(firebase, user); }
    catch (error) { setStatus(`Could not move this browser’s saved presentation data to Realtime Database yet: ${error.message || error}`, 'error'); }
    if (watchedDocumentsUid !== user.uid && firebase.watchDriveDocuments) {
      stopWatchingDocuments?.();
      watchedDocumentsUid = user.uid;
      stopWatchingDocuments = await firebase.watchDriveDocuments(user.uid, () => {
        documentStudy.clearDocumentMetadataCache();
        window.dispatchEvent(new Event('studyspace:presentations-changed'));
      }, error => console.warn('Realtime Database presentation listener failed.', error));
    }
    const { documents, cloudError } = await loadDocumentCollection(firebase, user);
    if (epoch !== renderEpoch) return;
    if (cloudError && !documents.length) setStatus(`Could not load your presentation library from Realtime Database. Reconnect and refresh. ${cloudError}`, 'error');
    else if (cloudError) setStatus(`Realtime Database could not load all imported files. ${cloudError}`, 'error');
    renderDocumentCards(documents);
    window.dispatchEvent(new Event('studyspace:presentations-changed'));
  } catch (error) {
    setStatus(error.message, 'error');
  }
}
function serializeSlides(originalName, fileId, importedAt, subjectName, slides) {
  const heading = [`PRESENTATION: ${originalName}`, `ORIGINAL DRIVE FILE ID: ${fileId}`, `IMPORTED: ${importedAt}`, `TOTAL SLIDES: ${slides.length}`, `SUBJECT: ${subjectName}`, `PROCESSING VERSION: ${EXTRACTION_VERSION}`, 'IMAGE TEXT: Slide image OCR was not run. Available PowerPoint image descriptions were extracted where present.', ''];
  const sections = slides.map(slide => {
    const lines = [`========== SLIDE ${slide.slideNumber} ==========`];
    lines.push(`TITLE: ${slide.title || '(No explicit title found)'}`);
    lines.push('TEXT:', slide.text || '(No text found)');
    if (slide.tables?.length) lines.push('TABLES:', ...slide.tables.map((table, index) => `Table ${index + 1}:\n${table.map(row => row.join(' | ')).join('\n')}`));
    if (slide.notes) lines.push('SPEAKER NOTES:', slide.notes);
    if (slide.imageDescriptions?.length) lines.push('IMAGE DESCRIPTIONS:', ...slide.imageDescriptions.map(text => `- ${text}`));
    if (slide.chartData?.length) lines.push('CHART TITLES, LABELS, AND VALUES:', ...slide.chartData.map(text => `- ${text}`));
    return lines.join('\n');
  });
  return `${heading.join('\n')}\n${sections.join('\n\n')}`;
}
function serializeStudyGuide(name, summary, analyses) {
  const lines = [`STUDY GUIDE: ${name}`, `GENERATED: ${new Date().toISOString()}`, '', 'OVERVIEW', summary.summary || '(No overview was generated.)', '', 'TABLE OF CONTENTS'];
  for (const item of summary.tableOfContents || []) lines.push(`${item.slides || 'Slides'} · ${item.title}`, `  ${item.summary}`);
  lines.push('', 'MAJOR THEMES', ...(summary.majorThemes || []).map(item => `- ${item}`), '', 'PREREQUISITES', ...(summary.prerequisites || []).map(item => `- ${item}`), '', 'EXAM TOPICS', ...(summary.examTopics || []).map(item => `- ${item}`), '', 'SECTION NOTES');
  for (const item of analyses) lines.push(`Section ${item.batchIndex + 1}: ${item.sectionTitle || 'Untitled'}`, item.sectionSummary || '', `Topics: ${(item.topics || []).join(', ')}`);
  return lines.join('\n');
}
async function restoreSlides(firebase, document, job) {
  const chunks = await withTimeout(firebase.listDriveSlideChunks(document.id), 8000, 'Realtime Database slide checkpoint lookup');
  return chunks.flatMap(chunk => chunk.slides || []).sort((a, b) => a.slideNumber - b.slideNumber);
}
async function syncSlideChunks(firebase, documentId, slides) {
  for (let start = 0; start < slides.length; start += BATCH_SIZE) {
    const batch = slides.slice(start, start + BATCH_SIZE);
    await firebase.writeDriveSlideChunks(documentId, [{ chunkIndex: Math.floor(start / BATCH_SIZE), slides: batch, extractionVersion: EXTRACTION_VERSION }]);
  }
}
async function syncExistingDocument(document) {
  if (!document || busy) return;
  busy = true; toggleButtons(true);
  try {
    const { firebase, user } = await getFirebase();
    const localKey = localKeyFor(user.uid, document.id);
    const job = { id: localKey, userId: user.uid, documentId: document.id, metadata: document };
    const slides = await restoreSlides(firebase, document, job);
    if (!slides.length) throw new Error('No extracted slide text is available in Realtime Database. Resume the import from Google Drive.');
    await syncSlideChunks(firebase, document.id, slides);
    job.syncError = ''; job.metadata = { ...job.metadata, syncError: '', updatedAt: new Date().toISOString() };
    await firebase.writeDriveDocument(document.id, job.metadata);
    setStatus(`Realtime Database synced ${slides.length} slides from ${document.originalName}.`);
  } catch (error) { setStatus(`Cloud sync paused: ${error.message}`, 'error'); }
  finally { busy = false; toggleButtons(false); documentStudy.clearDocumentMetadataCache(); await refreshLibrary(); }
}
function makeWorker(buffer, startIndex, onReady, onBatch) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./pptx-worker.js?v=20261101-1', import.meta.url), { type: 'module' }); }
    catch { reject(new Error('This browser could not start the PowerPoint parsing worker. Update your browser and try again.')); return; }
    let settled = false;
    const finish = error => { if (settled) return; settled = true; worker.terminate(); error ? reject(error) : resolve(); };
    worker.onerror = event => finish(new Error(event.message || 'The PowerPoint parsing worker stopped unexpectedly.'));
    worker.onmessage = async event => {
      const data = event.data || {};
      try {
        if (data.type === 'error') { finish(new Error(data.message)); return; }
        if (data.type === 'ready') {
          await onReady(data);
          worker.postMessage({ type: 'continue' });
          return;
        }
        if (data.type === 'batch' || data.type === 'finished') {
          await onBatch(data);
          if (data.type === 'finished') { finish(); return; }
          worker.postMessage({ type: 'continue' });
        }
      } catch (error) { finish(error); }
    };
    worker.postMessage({ type: 'start', source: buffer, startIndex, batchSize: BATCH_SIZE });
  });
}

async function importOne(file, subjectId, previousDocument = null) {
  activeProgressPercent = 0;
  setActiveProgress(file.name, 'Checking access to the selected Drive file', 1);
  let firebase, user;
  try { ({ firebase, user } = await getFirebase()); }
  catch (error) {
    setActiveProgress(file.name, 'Could not start the import', 1, error.message || String(error), 'error');
    throw error;
  }
  const subject = appState()?.subjects?.find(item => item.id === subjectId) || selectedSubject();
  if (!subject) throw new Error('Select a destination subject first.');
  try { file = { ...file, ...await drive.getPresentationMetadata(file.id) }; }
  catch (error) {
    setActiveProgress(file.name, 'Could not read the selected file', 1, error.message || String(error), 'error');
    throw error;
  }
  setActiveProgress(file.name, 'Creating import checkpoint', 3, `${formatBytes(file.size)} presentation`);
  const sourceFingerprint = `${file.md5Checksum || file.modifiedTime || 'unknown'}_${file.size || 0}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(-45) || 'selected';
  const documentId = `drive_${file.id}_${sourceFingerprint}`.slice(0, 240);
  if (previousDocument && previousDocument.id !== documentId) throw new Error('This Drive presentation changed after its checkpoint. Import it again from Drive to start a clean version; the previous checkpoint is preserved.');
  const localKey = localKeyFor(user.uid, documentId);
  setActiveProgress(file.name, 'Checking for a saved cloud checkpoint', 3, 'This may take a moment');
  const remoteExisting = previousDocument || await withTimeout(firebase.getDriveDocument(documentId), 8000, 'Realtime Database checkpoint lookup');
  if (!previousDocument && remoteExisting?.processingStatus === 'ready') {
    setStatus(`${file.name} is already imported for ${subject.name}.`);
    setActiveProgress(file.name, 'Already imported and ready', 100);
    return;
  }
  const importedAt = remoteExisting?.importedAt || new Date().toISOString();
  const metadata = {
    ...(remoteExisting || {}),
    documentId, originalFileId: file.id, originalName: file.name, subjectId: subject.id, subjectName: subject.name,
    fileSize: Number(file.size || remoteExisting?.fileSize || 0), modifiedTime: file.modifiedTime || remoteExisting?.modifiedTime || '',
    importedAt, extractionVersion: EXTRACTION_VERSION, processingStatus: remoteExisting?.processingStatus || 'downloading', processingStage: remoteExisting?.processingStage || 'Download from Google Drive',
    extractionProgress: Number(remoteExisting?.extractionProgress) || 0, error: '', syncError: '',
  };
  const job = { id: localKeyFor(user.uid, documentId), userId: user.uid, documentId, originalFileId: file.id, originalName: file.name, pickerFile: file, subjectId: subject.id, subjectName: subject.name, nextIndex: Number(metadata.processedSlides) || 0, totalSlides: Number(metadata.totalSlides) || 0, folders: metadata.driveFolders || null, metadata };
  setActiveProgress(file.name, 'Saving import checkpoint to Realtime Database', 4, 'Progress and extracted text sync to your account');
  await tryWriteMetadata(firebase, documentId, metadata, job);
  setStatus(`Preparing ${file.name}…`);
  setActiveProgress(file.name, 'Preparing Drive folders and checkpoints', 4, `Saving to ${subject.name}`);

  try {
    let folders = job.folders || foldersBySubject.get(subject.id);
    if (!folders) {
      folders = await drive.ensureSubjectFolders(subject.name);
      foldersBySubject.set(subject.id, folders);
    }
    job.folders = folders; metadata.driveFolders = folders;
    await tryWriteMetadata(firebase, documentId, metadata, job);
    try { await drive.createOriginalShortcut(file, folders.originalFolderId); } catch (error) { console.info('The original is untouched; its Drive shortcut could not be created.', error); }
    setActiveProgress(file.name, 'Drive folders ready', 6, 'Checking for a saved download in this browser');

    let slides = await restoreSlides(firebase, { ...metadata, id: documentId }, job);
    if (slides.length >= (job.totalSlides || metadata.totalSlides || Infinity) && slides.length) {
      job.nextIndex = slides.length;
    } else {
      metadata.processingStatus = 'downloading'; metadata.processingStage = 'Download from Google Drive';
      await tryWriteMetadata(firebase, documentId, metadata, job);
      let source = (await localDb.getSource(localKey))?.blob;
      if (!source) {
        setActiveProgress(file.name, 'Downloading presentation from Google Drive', 7, file.size ? `0 KB of ${formatBytes(file.size)}` : 'Receiving presentation data');
        source = await drive.downloadPresentation(file.id, ({ loaded, total }) => {
          const expected = total || Number(file.size) || 0;
          const fraction = expected ? Math.min(1, loaded / expected) : 0;
          const detail = expected ? `${formatBytes(loaded)} of ${formatBytes(expected)}` : `${formatBytes(loaded)} received`;
          setActiveProgress(file.name, 'Downloading presentation from Google Drive', 7 + fraction * 17, detail);
        });
        metadata.fileSize = source.size || metadata.fileSize;
        try { await localDb.putSource(localKey, source); }
        catch (error) { setStatus(`The file is open for processing, but this browser could not save its PowerPoint resume copy: ${error.message || error}`, 'error'); }
      } else setActiveProgress(file.name, 'Using saved presentation download', 24, `${formatBytes(source.size)} ready for extraction`);
      setActiveProgress(file.name, 'Download complete · starting slide extraction', 25, `${formatBytes(source.size)} received`);
      metadata.processingStatus = 'extracting'; metadata.processingStage = 'Extract slides in browser';
      job.metadata = metadata;
      await tryWriteMetadata(firebase, documentId, metadata, job);
      await makeWorker(source, slides.length, async info => {
        job.totalSlides = info.totalSlides; job.nextIndex = Math.min(slides.length, info.nextIndex);
        metadata.totalSlides = info.totalSlides; metadata.processedSlides = job.nextIndex; metadata.extractionProgress = info.totalSlides ? Math.round(job.nextIndex / info.totalSlides * 100) : 0;
        metadata.processingStatus = 'extracting'; metadata.processingStage = 'Extract slide text';
        await tryWriteMetadata(firebase, documentId, metadata, job);
        setStatus(`Extracting ${file.name}: ${job.nextIndex} of ${info.totalSlides} slides`);
        const fraction = info.totalSlides ? job.nextIndex / info.totalSlides : 0;
        setActiveProgress(file.name, 'Extracting slide text in your browser', 25 + fraction * 50, `${job.nextIndex} of ${info.totalSlides} slides`);
      }, async result => {
        const fraction = result.totalSlides ? result.nextIndex / result.totalSlides : 1;
        setActiveProgress(file.name, 'Checkpointing extracted slides', 25 + fraction * 50, `Saving slides ${Math.max(1, result.nextIndex - result.slides.length + 1)}–${result.nextIndex} of ${result.totalSlides}`);
        const chunkIndex = Math.floor((result.slides[0].slideNumber - 1) / BATCH_SIZE);
        setActiveProgress(file.name, 'Saving extracted slides to Realtime Database', 25 + fraction * 50, `${result.nextIndex} of ${result.totalSlides} slides`);
        await withTimeout(firebase.writeDriveSlideChunks(documentId, [{ chunkIndex, slides: result.slides, extractionVersion: EXTRACTION_VERSION }]), 15000, 'Realtime Database slide checkpoint save');
        job.nextIndex = result.nextIndex; job.totalSlides = result.totalSlides;
        metadata.totalSlides = result.totalSlides; metadata.processedSlides = result.nextIndex; metadata.extractionProgress = Math.round(result.nextIndex / result.totalSlides * 100);
        metadata.processingStatus = result.type === 'finished' ? 'extracted' : 'extracting';
        metadata.processingStage = result.type === 'finished' ? 'Save extracted text to Drive' : 'Checkpoint extracted slides';
        await tryWriteMetadata(firebase, documentId, metadata, job);
        setStatus(`Extracted ${result.nextIndex} of ${result.totalSlides} slides from ${file.name}.`);
        setActiveProgress(file.name, result.type === 'finished' ? 'Slide extraction complete' : 'Saving slide checkpoint', 25 + fraction * 50, `${result.nextIndex} of ${result.totalSlides} slides extracted`);
      });
      slides = await restoreSlides(firebase, { ...metadata, id: documentId }, job);
    }

    if (!slides.length) throw new Error('The presentation contained no slide text to save.');
    slides.sort((a, b) => a.slideNumber - b.slideNumber);
    if (!metadata.extractedTextFileId) {
      const content = serializeSlides(file.name, file.id, importedAt, subject.name, slides);
      setActiveProgress(file.name, 'Uploading extracted slide text to Drive', 78, `${slides.length} slides · preparing text file`);
      const savedText = await drive.saveTextFile(`${fileStem(file.name)} [${file.id.slice(0, 7)}] extracted.txt`, content, folders.extractedFolderId, ({ loaded, total }) => {
        const fraction = total ? Math.min(1, loaded / total) : 0;
        setActiveProgress(file.name, 'Uploading extracted slide text to Drive', 78 + fraction * 7, total ? `${formatBytes(loaded)} of ${formatBytes(total)} uploaded` : `${formatBytes(loaded)} uploaded`);
      });
      metadata.extractedTextFileId = savedText.id;
      metadata.extractedTextUrl = savedText.webViewLink || '';
    }
    setActiveProgress(file.name, 'Saving import progress and syncing slide data', 87, `${slides.length} slides extracted`);
    await localDb.deleteSource(localKey).catch(() => {});
    metadata.totalSlides = slides.length; metadata.processedSlides = slides.length; metadata.extractionProgress = 100;
    metadata.processedAt = new Date().toISOString(); metadata.processingStatus = 'extracted'; metadata.processingStage = 'Extracted text saved'; metadata.error = '';
    metadata.imageTextNote = 'PowerPoint alt-text descriptions were included when present. Screenshot/image OCR is not run in this browser-only build.';
    job.metadata = metadata; job.nextIndex = slides.length; job.totalSlides = slides.length;
    await tryWriteMetadata(firebase, documentId, metadata, job);
    window.studyspaceApp?.recordImportedDocument?.(subject.id, file.name, []);
    await refreshLibrary();
    if (documentAI.hasGroqKey()) await runAnalysis({ ...metadata, id: documentId }, job, slides, folders, firebase);
    else {
      metadata.processingStatus = 'awaiting_ai'; metadata.processingStage = 'AI analysis needs a Groq key';
      await tryWriteMetadata(firebase, documentId, metadata, job); await refreshLibrary();
      setStatus(`${file.name} is extracted and saved to your account. Configure Groq AI, then resume analysis.`);
      setActiveProgress(file.name, 'Presentation imported · AI analysis can be resumed later', 100, `${slides.length} slides saved to Drive`);
    }
  } catch (error) {
    metadata.error = error?.message || String(error);
    metadata.processingStatus = job.nextIndex ? 'error' : 'error';
    metadata.processingStage = 'Import paused';
    job.metadata = metadata;
    await tryWriteMetadata(firebase, documentId, metadata, job);
    await refreshLibrary();
    setActiveProgress(file.name, 'Import paused', activeProgressPercent, error?.message || String(error), 'error');
    throw error;
  }
}

async function loadAnalysisCache(firebase, documentId) {
  const remote = await firebase.listDriveAnalysis(documentId);
  const byIndex = new Map();
  for (const item of remote) if (Number.isFinite(Number(item.batchIndex))) byIndex.set(Number(item.batchIndex), item);
  return byIndex;
}
async function hashValue(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${documentAI.DOCUMENT_ANALYSIS_VERSION}\n${JSON.stringify(value)}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function runAnalysis(document, job, slides, folders, firebase) {
  const metadata = { ...job.metadata, processingStatus: 'analyzing', processingStage: 'Summarize slide groups', error: '' };
  setActiveProgress(document.originalName, 'Preparing AI analysis', Math.max(88, activeProgressPercent), `${slides.length} slides · grouping content for analysis`);
  job.metadata = metadata;
  await tryWriteMetadata(firebase, document.id, metadata, job); await refreshLibrary();
  const batchCount = Math.ceil(slides.length / ANALYSIS_BATCH_SIZE);
  const cache = await loadAnalysisCache(firebase, document.id);
  const analyses = [];
  try {
    for (let index = 0; index < batchCount; index++) {
      const sectionSlides = slides.slice(index * ANALYSIS_BATCH_SIZE, (index + 1) * ANALYSIS_BATCH_SIZE);
      const contentHash = await documentAI.hashSlides(sectionSlides);
      let item = cache.get(index);
      const hasAllSlides = Array.isArray(item?.slides) && item.slides.length === sectionSlides.length && sectionSlides.every(slide => item.slides.some(analysis => Number(analysis.slideNumber) === slide.slideNumber));
      if (!item || item.contentHash !== contentHash || item.analysisVersion !== documentAI.DOCUMENT_ANALYSIS_VERSION || !hasAllSlides) {
        const result = await documentAI.summarizeSlideBatch(sectionSlides, index);
        const returned = Array.isArray(result.slides) ? result.slides : [];
        if (returned.length !== sectionSlides.length || sectionSlides.some(slide => !returned.some(analysis => Number(analysis.slideNumber) === slide.slideNumber))) {
          throw new Error(`AI did not return analysis for every slide in section ${index + 1}. The extraction is saved; resume this section to try again.`);
        }
        item = {
          batchIndex: index, contentHash, analysisVersion: documentAI.DOCUMENT_ANALYSIS_VERSION,
          slideStart: sectionSlides[0]?.slideNumber || 0, slideEnd: sectionSlides.at(-1)?.slideNumber || 0,
          sectionTitle: String(result.sectionTitle || `Slides ${sectionSlides[0]?.slideNumber}–${sectionSlides.at(-1)?.slideNumber}`).slice(0, 120),
          sectionSummary: String(result.sectionSummary || '').slice(0, 600),
          topics: Array.isArray(result.topics) ? result.topics.slice(0, 5).map(topic => String(topic).slice(0, 100)) : [],
          slides: returned.slice(0, ANALYSIS_BATCH_SIZE).map(entry => ({ slideNumber: Number(entry.slideNumber) || 0, summary: String(entry.summary || '').slice(0, 240), concepts: Array.isArray(entry.concepts) ? entry.concepts.slice(0, 3).map(concept => String(concept).slice(0, 80)) : [] })),
        };
        await firebase.writeDriveAnalysis(document.id, `batch_${String(index).padStart(5, '0')}`, item);
        cache.set(index, item);
      }
      analyses.push(item);
      metadata.aiProgress = Math.round((index + 1) / batchCount * 92);
      metadata.processingStage = `AI slide analysis · section ${index + 1} of ${batchCount}`;
      metadata.analysisCompletedBatches = index + 1;
      job.metadata = metadata;
      await tryWriteMetadata(firebase, document.id, metadata, job);
      setStatus(`AI analysis for ${document.originalName}: section ${index + 1} of ${batchCount}. You can leave and resume from this checkpoint.`);
      setActiveProgress(document.originalName, `AI analysis · section ${index + 1} of ${batchCount}`, 88 + ((index + 1) / Math.max(1, batchCount)) * 9, `${Math.min((index + 1) * ANALYSIS_BATCH_SIZE, slides.length)} of ${slides.length} slides analyzed`);
      await refreshLibrary();
    }
    const summaryHash = await hashValue(analyses.map(item => ({ batchIndex: item.batchIndex, contentHash: item.contentHash, sectionSummary: item.sectionSummary, topics: item.topics })));
    const summaryCache = [...cache.values()].find(item => item.batchIndex === 1_000_000);
    let summary = summaryCache?.contentHash === summaryHash && summaryCache?.analysisVersion === documentAI.DOCUMENT_ANALYSIS_VERSION ? summaryCache : null;
    if (!summary) {
      setActiveProgress(document.originalName, 'Writing presentation overview', 98, 'Combining section summaries and study topics');
      summary = await documentAI.summarizePresentation(document.originalName, slides.length, analyses);
      summary = { ...summary, batchIndex: 1_000_000, contentHash: summaryHash, analysisVersion: documentAI.DOCUMENT_ANALYSIS_VERSION };
      await firebase.writeDriveAnalysis(document.id, 'presentation_summary', summary);
    }
    const guideText = serializeStudyGuide(document.originalName, summary, analyses);
    setActiveProgress(document.originalName, 'Uploading study guide to Drive', 99, 'Saving the final study guide');
    const savedGuide = await drive.saveTextFile(`${fileStem(document.originalName)} [${document.originalFileId.slice(0, 7)}] study guide.txt`, guideText, folders.summariesFolderId, ({ loaded, total }) => {
      const fraction = total ? Math.min(1, loaded / total) : 0;
      setActiveProgress(document.originalName, 'Uploading study guide to Drive', 99, `Study guide · ${Math.round(fraction * 100)}% uploaded`);
    });
    const outline = [...new Set([...(summary.majorThemes || []), ...(summary.examTopics || []), ...(summary.tableOfContents || []).map(section => section.title)])].slice(0, 60);
    metadata.summary = summary.summary;
    metadata.tableOfContents = summary.tableOfContents;
    metadata.majorThemes = summary.majorThemes;
    metadata.prerequisites = summary.prerequisites;
    metadata.examTopics = summary.examTopics;
    metadata.topicOutline = outline;
    metadata.summaryFileId = savedGuide.id; metadata.summaryFileUrl = savedGuide.webViewLink || '';
    metadata.aiStatus = 'complete'; metadata.aiProgress = 100; metadata.processingStatus = 'ready'; metadata.processingStage = 'Import complete'; metadata.processedAt = new Date().toISOString(); metadata.error = '';
    job.metadata = metadata;
    await tryWriteMetadata(firebase, document.id, metadata, job);
    window.studyspaceApp?.recordImportedDocument?.(metadata.subjectId, metadata.originalName, outline);
    documentStudy.clearDocumentMetadataCache();
    setStatus(`${document.originalName} is ready. Its extracted slides and study guide are saved in Google Drive.`);
    setActiveProgress(document.originalName, 'Import complete · slides and study guide are ready', 100, `${slides.length} slides processed`);
    await refreshLibrary();
  } catch (error) {
    metadata.processingStatus = 'analysis_paused'; metadata.aiStatus = 'paused'; metadata.processingStage = 'AI analysis paused'; metadata.error = error?.message || String(error);
    job.metadata = metadata;
    await tryWriteMetadata(firebase, document.id, metadata, job); await refreshLibrary();
    setStatus(`${document.originalName} text is safe in Drive. AI analysis paused: ${metadata.error}`, 'error');
    setActiveProgress(document.originalName, 'AI analysis paused · extracted slides are safe', activeProgressPercent, metadata.error, 'error');
  }
}

async function resumeAnalysis(document) {
  if (busy) return;
  activeProgressPercent = 87;
  setActiveProgress(document.originalName, 'Resuming saved presentation analysis', 87, 'Loading extracted slide checkpoints');
  busy = true; toggleButtons(true);
  try {
    const { firebase, user } = await getFirebase();
    const localKey = document.localKey || localKeyFor(user.uid, document.id);
    const job = { id: localKey, userId: user.uid, documentId: document.id, originalFileId: document.originalFileId, originalName: document.originalName, subjectId: document.subjectId, subjectName: document.subjectName, folders: document.driveFolders || null, nextIndex: document.processedSlides || 0, totalSlides: document.totalSlides || 0, metadata: document };
    if (!job.folders) job.folders = foldersBySubject.get(document.subjectId) || await drive.ensureSubjectFolders(document.subjectName || 'Other');
    let slides = await restoreSlides(firebase, document, job);
    if (!slides.length && job.nextIndex) job.nextIndex = 0;
    if (slides.length < (job.totalSlides || document.totalSlides || Infinity)) {
      await importOne(document.pickerFile || { id: document.originalFileId, name: document.originalName, size: document.fileSize, mimeType: MIME, modifiedTime: document.modifiedTime }, document.subjectId, document);
      return;
    }
    await runAnalysis(document, job, slides, job.folders, firebase);
  } catch (error) {
    setStatus(error.message, 'error');
    setActiveProgress(document.originalName, 'Resume paused', activeProgressPercent, error.message || String(error), 'error');
  }
  finally { busy = false; toggleButtons(false); await refreshLibrary(); }
}

async function resumeImport(document) {
  if (busy) return;
  busy = true;
  toggleButtons(true);
  try {
    const file = document.pickerFile || { id: document.originalFileId, name: document.originalName, size: document.fileSize, mimeType: MIME, modifiedTime: document.modifiedTime };
    await importOne(file, document.subjectId, document);
  } catch (error) {
    setStatus(`${document.originalName}: ${error.message || error}`, 'error');
    setActiveProgress(document.originalName, 'Resume paused', activeProgressPercent, error.message || String(error), 'error');
  } finally {
    busy = false;
    toggleButtons(false);
    await refreshLibrary();
  }
}

async function viewExtractedText(document) {
  if (!document) return;
  const dialog = $('#driveTextDialog');
  $('#driveTextTitle').textContent = document.originalName || 'Presentation text';
    $('#driveTextContent').textContent = 'Loading extracted slides from your account…';
  const link = $('#driveTextFileLink');
  if (document.extractedTextFileId) { link.href = document.extractedTextUrl || `https://drive.google.com/file/d/${encodeURIComponent(document.extractedTextFileId)}/view`; link.hidden = false; }
  else link.hidden = true;
  dialog.showModal();
  try {
    const { firebase, user } = await getFirebase();
    const key = document.localKey || localKeyFor(user.uid, document.id);
    const slides = await restoreSlides(firebase, document, { id: key });
    const text = serializeSlides(document.originalName, document.originalFileId, document.importedAt, document.subjectName, slides);
    $('#driveTextContent').textContent = text;
  } catch (error) { $('#driveTextContent').textContent = `Could not load the extracted transcript from Realtime Database. Reconnect and try again.\n\n${error.message}`; }
}
function toggleButtons(disabled) {
  $('#driveImportButton').disabled = disabled;
  document.querySelectorAll('[data-resume]').forEach(button => { button.disabled = disabled; });
}

$('#driveImportButton').addEventListener('click', async () => {
  if (busy) return;
  const subject = selectedSubject();
  if (!subject) return setStatus('Add a subject before importing a presentation.', 'error');
  if (!drive.isConfigured()) return setStatus('Google Drive credentials are missing from the site configuration.', 'error');
  busy = true; toggleButtons(true); setStatus('Opening Google Drive…');
  try {
    const files = await drive.pickPresentations();
    if (!files.length) { setStatus('No PowerPoint files selected.'); return; }
    showImportAssignments(files);
  } catch (error) { setStatus(error.message, 'error'); }
  finally { busy = false; toggleButtons(false); await refreshLibrary(); }
});
$('#confirmDriveImport').addEventListener('click', async () => {
  if (busy || !filesPendingAssignment.length) return;
  const files = filesPendingAssignment;
  const destinations = new Map([...$('#driveImportAssignments').querySelectorAll('[data-file-subject]')].map(select => [Number(select.dataset.fileSubject), select.value]));
  filesPendingAssignment = [];
  $('#driveImportReviewDialog').close();
  busy = true; toggleButtons(true);
  try {
    for (let index = 0; index < files.length; index++) {
      setStatus(`Importing presentation ${index + 1} of ${files.length}…`);
      try { await importOne(files[index], destinations.get(index)); }
      catch (error) {
        setStatus(`${files[index].name}: ${error.message}`, 'error');
        setActiveProgress(files[index].name, 'Import paused', activeProgressPercent, error.message || String(error), 'error');
      }
    }
  } finally { busy = false; toggleButtons(false); await refreshLibrary(); }
});
$('#cancelDriveImport').onclick = () => { filesPendingAssignment = []; $('#driveImportReviewDialog').close(); };
$('#cancelDriveImportButton').onclick = () => { filesPendingAssignment = []; $('#driveImportReviewDialog').close(); };
$('#driveReconnectButton').addEventListener('click', async () => {
  const button = $('#driveReconnectButton'); button.disabled = true;
  try { const email = await drive.connectDrive(); setStatus(`Google Drive connected as ${email}.`); await refreshLibrary(); }
  catch (error) { setStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#driveDisconnectButton').addEventListener('click', async () => {
  const { user } = await getFirebase().catch(() => ({ user: null }));
  drive.disconnectDrive(user?.uid);
  setStatus('Drive disconnected from this browser. Firebase sign-in and existing imports are unchanged.');
  refreshConnectionStatus(user);
});
$('#closeDriveText').onclick = () => $('#driveTextDialog').close();
$('#closeDriveTextButton').onclick = () => $('#driveTextDialog').close();
$('#driveTextDialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

window.studyDocumentLibrary = {
  contextForSubject: documentStudy.contextForSubject,
  topicsForSubject: documentStudy.topicsForSubject,
  setActiveDocument: documentStudy.setActiveDocument,
  clearActiveDocument: documentStudy.clearActiveDocument,
  refresh: refreshLibrary,
};
window.addEventListener('studyspace:subjects-changed', updateSubjectOptions);
window.addEventListener('studyspace:state-ready', () => { updateSubjectOptions(); refreshLibrary(); });
updateSubjectOptions();
if (window.studyspaceApp?.getState?.()?.subjects?.length) refreshLibrary();






