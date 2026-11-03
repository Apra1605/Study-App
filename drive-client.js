const CONNECTED_PREFIX = 'studyspace.drive.connected.';
const DEFAULT_CONFIG = Object.freeze({
  clientId: '729887055897-0f5v31821mi0ai6b27gst7oeaddoe8p1.apps.googleusercontent.com',
  apiKey: 'AIzaSyCwDxYwRmt6b_spP2HvfRdDi4rlgao0p5A',
  projectNumber: '729887055897',
});
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const USERINFO_SCOPE = 'email';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
let tokenClient;
let accessToken = '';
let tokenExpiry = 0;
let authEmail = '';
let pickerReady;
let gisReady;

export function getConfig() {
  return { ...DEFAULT_CONFIG };
}
export function isConfigured() {
  const config = getConfig();
  return Boolean(config.clientId && config.apiKey && config.projectNumber);
}
export function isConnected(uid) { return Boolean(uid && localStorage.getItem(`${CONNECTED_PREFIX}${uid}`) === '1'); }

async function verifyConnectedAccount() {
  const firebase = await window.studyspaceFirebaseReady;
  if (firebase.error) throw new Error('Firebase sign-in is unavailable. Sign in again before connecting Google Drive.');
  const user = await firebase.currentUser();
  if (!user) throw new Error('Sign in with Google before connecting Google Drive.');
  const firebaseEmail = (user.email || '').toLowerCase();
  if (firebaseEmail && authEmail && firebaseEmail !== authEmail.toLowerCase()) {
    accessToken = ''; tokenExpiry = 0;
    throw new Error(`Drive is connected as ${authEmail}, but this Studyspace account is ${user.email}. Reconnect with the same Google account for both.`);
  }
  localStorage.setItem(`${CONNECTED_PREFIX}${user.uid}`, '1');
}

function loadScript(src, isReady, setReady) {
  if (isReady) return isReady;
  const existing = [...document.scripts].find(script => script.src === src);
  const promise = new Promise((resolve, reject) => {
    if (existing?.dataset.loaded === 'true') { resolve(); return; }
    const script = existing || Object.assign(document.createElement('script'), { src, async: true, defer: true });
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error('Google Drive could not load. Check your connection or browser content blockers.'));
    if (!existing) document.head.append(script);
  });
  setReady(promise);
  return promise;
}
async function loadGis() {
  await loadScript('https://accounts.google.com/gsi/client', gisReady, value => { gisReady = value; });
  if (!window.google?.accounts?.oauth2) throw new Error('Google Drive authorization did not load. Refresh the page and try again.');
}
async function getAccessToken({ prompt = '' } = {}) {
  if (!isConfigured()) throw new Error('Add the Google Drive OAuth client ID and Picker API key in the Study materials setup panel first.');
  if (accessToken && Date.now() < tokenExpiry - 60_000) {
    await verifyConnectedAccount();
    return accessToken;
  }
  await loadGis();
  const config = getConfig();
  if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: config.clientId,
    scope: `openid ${USERINFO_SCOPE} ${DRIVE_SCOPE}`,
    callback: () => {},
    error_callback: error => console.warn('Drive OAuth popup error', error),
  });
  const response = await new Promise((resolve, reject) => {
    tokenClient.callback = result => {
      if (result?.error) { reject(new Error(`Google Drive authorization failed: ${result.error_description || result.error}`)); return; }
      if (!result?.access_token) { reject(new Error('Google Drive did not return an access token. Try reconnecting.')); return; }
      resolve(result);
    };
    tokenClient.error_callback = error => reject(new Error(`Google Drive authorization failed: ${error?.message || 'The authorization window was closed.'}`));
    tokenClient.requestAccessToken({ prompt });
  });
  accessToken = response.access_token;
  tokenExpiry = Date.now() + Math.max(60, Number(response.expires_in) || 3600) * 1000;
  const who = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!who.ok) { accessToken = ''; throw new Error('Could not confirm which Google account was connected. Reconnect and try again.'); }
  authEmail = (await who.json()).email || '';
  await verifyConnectedAccount();
  return accessToken;
}

export async function connectDrive() {
  accessToken = ''; tokenExpiry = 0;
  await getAccessToken({ prompt: 'consent select_account' });
  return authEmail;
}
export function disconnectDrive(uid) {
  if (uid) localStorage.removeItem(`${CONNECTED_PREFIX}${uid}`);
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = ''; tokenExpiry = 0; authEmail = '';
}
async function driveFetch(path, options = {}, retry = true) {
  const token = await getAccessToken();
  const response = await fetch(path.startsWith('http') ? path : `${DRIVE_API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (response.status === 401 && retry) {
    accessToken = ''; tokenExpiry = 0;
    return driveFetch(path, options, false);
  }
  if (!response.ok) {
    let reason = '';
    try { const body = await response.json(); reason = body?.error?.message || ''; } catch { /* response may not be JSON */ }
    if (response.status === 401 || response.status === 403 && /insufficient.*permission|invalid credentials|invalid_grant/i.test(reason)) {
      accessToken = ''; tokenExpiry = 0;
      throw new Error('Google Drive needs to be reconnected. Use the Reconnect Drive button, then resume this import.');
    }
    if (response.status === 403 && /quota|storage/i.test(reason)) throw new Error(`Google Drive quota blocked this operation: ${reason}`);
    throw new Error(`Google Drive request failed (${response.status})${reason ? `: ${reason}` : ''}`);
  }
  return response;
}

function xhrUpload(url, { method = 'POST', headers = {}, body }, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.onprogress = event => onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : Number(body?.size || 0) });
    request.onerror = () => reject(new Error('Network error while uploading to Google Drive.'));
    request.onabort = () => reject(new Error('Google Drive upload was cancelled.'));
    request.onload = () => resolve({
      ok: request.status >= 200 && request.status < 300,
      status: request.status,
      headers: { get: name => request.getResponseHeader(name) },
      json: async () => JSON.parse(request.responseText || '{}'),
      text: async () => request.responseText || '',
    });
    request.send(body);
  });
}

async function driveUpload(path, options, onProgress, retry = true) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${DRIVE_API}${path}`;
  const response = await xhrUpload(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  }, onProgress);
  if (response.status === 401 && retry) {
    accessToken = ''; tokenExpiry = 0;
    return driveUpload(path, options, onProgress, false);
  }
  if (!response.ok) {
    let reason = '';
    try { reason = (await response.json())?.error?.message || ''; } catch { /* response may not be JSON */ }
    throw new Error(`Google Drive upload failed (${response.status})${reason ? `: ${reason}` : ''}`);
  }
  return response;
}

async function loadPicker() {
  if (pickerReady) return pickerReady;
  pickerReady = (async () => {
    await loadScript('https://apis.google.com/js/api.js', null, () => {});
    await new Promise((resolve, reject) => {
      if (!window.gapi?.load) { reject(new Error('Google Picker could not load.')); return; }
      gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Picker failed to load.')) });
    });
    if (!google?.picker) throw new Error('Google Picker did not initialize.');
  })();
  return pickerReady;
}
export async function pickPresentations() {
  const firebase = await window.studyspaceFirebaseReady;
  const user = await firebase.currentUser();
  const firstConnection = !isConnected(user?.uid);
  const token = await getAccessToken({ prompt: firstConnection ? 'consent select_account' : '' });
  await loadPicker();
  const config = getConfig();
  return new Promise((resolve, reject) => {
    const picker = new google.picker.PickerBuilder()
      .addView(new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes(PPTX_MIME)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false))
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.projectNumber)
      .setOrigin(window.location.origin)
      .setCallback(response => {
        if (response.action === google.picker.Action.CANCEL) { resolve([]); return; }
        if (response.action !== google.picker.Action.PICKED) return;
        const files = (response.docs || []).filter(file => file.mimeType === PPTX_MIME).map(file => ({
          id: file.id, name: file.name, mimeType: file.mimeType, size: Number(file.sizeBytes || file.size || 0),
          modifiedTime: file.lastEditedUtc || '', url: file.url || '',
        }));
        resolve(files);
      })
      .build();
    picker.setVisible(true);
  });
}

export async function downloadPresentation(fileId, onProgress) {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader) {
    const blob = await response.blob();
    onProgress?.({ loaded: blob.size, total: total || blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  return new Blob(chunks, { type: response.headers.get('content-type') || 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
export async function getPresentationMetadata(fileId) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,size,modifiedTime,md5Checksum,webViewLink', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`);
  const file = await response.json();
  if (file.mimeType !== PPTX_MIME) throw new Error('Choose a Microsoft PowerPoint .pptx file. Google Slides and older .ppt files are not supported.');
  return { ...file, size: Number(file.size || 0) };
}

async function listChildren(parentId, name, mimeType) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = `'${parentId}' in parents and name = '${escaped}' and mimeType = '${mimeType}' and trashed = false`;
  const params = new URLSearchParams({ q: query, pageSize: '100', fields: 'files(id,name,mimeType,shortcutDetails)', orderBy: 'name' });
  const response = await driveFetch(`/files?${params}`);
  return (await response.json()).files || [];
}
async function createFolder(name, parentId) {
  const response = await driveFetch('/files?fields=id,name,mimeType', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  return response.json();
}
async function ensureFolder(name, parentId) {
  const existing = await listChildren(parentId, name, FOLDER_MIME);
  return existing[0] || createFolder(name, parentId);
}
export async function ensureSubjectFolders(subjectName) {
  const rootFolders = await listChildren('root', 'AI Study Platform', FOLDER_MIME);
  const appFolder = rootFolders[0] || await createFolder('AI Study Platform', null);
  const subjects = await ensureFolder('Subjects', appFolder.id);
  const subject = await ensureFolder(subjectName.slice(0, 100), subjects.id);
  const [originals, extracted, summaries] = await Promise.all([
    ensureFolder('Original Documents', subject.id),
    ensureFolder('Extracted Text', subject.id),
    ensureFolder('Summaries', subject.id),
  ]);
  return { appFolderId: appFolder.id, subjectsFolderId: subjects.id, subjectFolderId: subject.id, originalFolderId: originals.id, extractedFolderId: extracted.id, summariesFolderId: summaries.id };
}
export async function createOriginalShortcut(file, folderId) {
  const existing = await listChildren(folderId, file.name, SHORTCUT_MIME);
  if (existing.some(item => item.shortcutDetails?.targetId === file.id)) return existing.find(item => item.shortcutDetails?.targetId === file.id);
  const response = await driveFetch('/files?fields=id,name,mimeType,shortcutDetails', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType: SHORTCUT_MIME, parents: [folderId], shortcutDetails: { targetId: file.id } }),
  });
  return response.json();
}
export async function saveTextFile(fileName, content, folderId, onProgress) {
  const existing = await listChildren(folderId, fileName, 'text/plain');
  const target = existing[0];
  const metadata = target ? { name: fileName } : { name: fileName, mimeType: 'text/plain', parents: [folderId] };
  const media = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const filePath = target ? `/files/${encodeURIComponent(target.id)}` : '/files';
  if (media.size > 4 * 1024 * 1024) {
    const start = await driveFetch(`${DRIVE_UPLOAD}${filePath}?uploadType=resumable&fields=id,name,webViewLink`, {
      method: target ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'text/plain;charset=utf-8', 'X-Upload-Content-Length': String(media.size) },
      body: JSON.stringify(metadata),
    });
    const sessionUrl = start.headers.get('Location');
    if (!sessionUrl) throw new Error('Google Drive did not return a resumable upload session. Try again.');
    onProgress?.({ phase: 'uploading', loaded: 0, total: media.size });
    const response = await driveUpload(sessionUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: media }, onProgress);
    if (!response.ok) throw new Error(`Google Drive could not save the extracted text (${response.status}). Try reconnecting and resuming.`);
    return response.json();
  }
  const boundary = `studyspace_${crypto.randomUUID().replaceAll('-', '')}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
    media,
    `\r\n--${boundary}--`,
  ], { type: `multipart/related; boundary=${boundary}` });
  const response = await driveUpload(`${DRIVE_UPLOAD}${filePath}?uploadType=multipart&fields=id,name,webViewLink`, { method: target ? 'PATCH' : 'POST', headers: { 'Content-Type': body.type }, body }, onProgress);
  return response.json();
}

