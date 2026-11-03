const app = window.studyspaceApp;
import { scoreRubricCriteria, scoreWeightedCriteria } from './study-mode-core.js?v=20261102-1';
const $ = selector => document.querySelector(selector);
const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const rich = value => app.renderRichText(String(value ?? ''));
const id = () => crypto.randomUUID();
let documentsApi;
let availableDocs = [];
let activeFrq = null;
let activeRecall = null;
let modeTimer = null;
let grading = false;

function subjectFor(selector) { return (app.getState().subjects || []).find(item => String(item.id) === $(selector)?.value); }
function selectedDocuments(selector) { return Array.from($(selector)?.selectedOptions || []).map(option => option.value).filter(Boolean); }
function ensureArrays(subject) {
  subject.frqRubrics ||= [];
  subject.frqAttempts ||= [];
  subject.frqSessions ||= [];
  subject.recallSessions ||= [];
  subject.recallMastery ||= {};
  subject.topics ||= [];
}
function fillSubjects() {
  const state = app.getState();
  for (const selector of ['#frqSubject', '#recallSubject']) {
    const element = $(selector); if (!element) continue;
    const selected = element.value;
    const subjects = Array.isArray(state.subjects) ? state.subjects.filter(subject => subject?.id) : [];
    element.innerHTML = subjects.length
      ? subjects.map(subject => `<option value="${h(subject.id)}">${h(subject.name || 'Untitled course')}</option>`).join('')
      : '<option value="" disabled selected>No courses available</option>';
    if (subjects.some(subject => String(subject.id) === selected)) element.value = selected;
    else if (subjects.length) element.selectedIndex = 0;
  }
  for (const subject of state.subjects || []) ensureArrays(subject);
  refreshDocs();
}
function repairCourseOptions() {
  const courses = (app.getState().subjects || []).filter(subject => subject?.id);
  const select = $('#frqSubject');
  if (!select) return;
  const optionsMatch = select.options.length === courses.length && courses.every((subject, index) =>
    select.options[index]?.value === String(subject.id) && select.options[index]?.textContent === String(subject.name || 'Untitled course'));
  if (!optionsMatch || select.selectedIndex < 0) fillSubjects();
}
async function refreshDocs() {
  try {
    documentsApi ||= await import('./document-study.js?v=20261102-1');
    availableDocs = await documentsApi.availableDocuments();
  } catch { availableDocs = []; }
  for (const [selectId, subjectId] of [['frqSources', 'frqSubject'], ['recallSources', 'recallSubject']]) {
    const select = $(`#${selectId}`); if (!select) continue;
    const prior = new Set(Array.from(select.selectedOptions).map(option => option.value));
    const subject = subjectFor(`#${subjectId}`);
    const docs = availableDocs.filter(doc => !subject || doc.subjectId === subject.id);
    select.innerHTML = docs.length
      ? docs.map(doc => `<option value="${h(doc.id)}">${h(doc.originalName || 'Imported presentation')}${doc.subjectName ? ` · ${h(doc.subjectName)}` : ''}</option>`).join('')
      : '<option value="" disabled>No processed presentations for this subject yet</option>';
    for (const option of select.options) option.selected = prior.has(option.value);
  }
}
function report(error) { app.showToast(error?.message || String(error)); }
function topicFor(unitSelector, topicSelector) {
  return [$(unitSelector)?.value.trim(), $(topicSelector)?.value.trim()].filter(Boolean).join(' · ');
}
function setModeBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) { button.dataset.oldText = button.textContent; button.textContent = label; }
  else if (button.dataset.oldText) { button.textContent = button.dataset.oldText; delete button.dataset.oldText; }
}
function citationsMarkup(citations = []) {
  return citations.length ? `<div class="mode-citations"><span>Sources</span>${citations.map(item => `<small>${rich(item)}</small>`).join('')}</div>` : '';
}
function subjectById(subjectId) { return app.getState().subjects.find(subject => subject.id === subjectId); }
function showEmpty(stage, icon, title, description) {
  stage.innerHTML = `<div class="empty-state"><span>${icon}</span><strong>${h(title)}</strong><p>${h(description)}</p></div>`;
}

// AP FRQ practice. Each generated rubric is saved verbatim before the prompt is rendered.
function normalizeFrqQuestion(question, index) {
  const prompt = String(question?.prompt || question?.question || '').slice(0, 2400);
  const parts = Array.isArray(question?.parts) ? question.parts.slice(0, 8).map((part, partIndex) => ({ label: String(part.label || String.fromCharCode(97 + partIndex)).slice(0, 8), prompt: String(part.prompt || '').slice(0, 700), points: Math.max(1, Number(part.points) || 1) })) : [];
  let criteria = Array.isArray(question?.rubric?.criteria) ? question.rubric.criteria.slice(0, 12).map((rawCriterion, criterionIndex) => {
    const criterion = rawCriterion || {};
    return {
    id: String(criterion.id || `c${criterionIndex + 1}`).slice(0, 36),
    part: String(criterion.part || '').slice(0, 12),
    name: String(criterion.name || `Scoring point ${criterionIndex + 1}`).slice(0, 120),
    points: Math.max(1, Math.min(2, Math.round(Number(criterion.points) || 1))),
    requiredEvidence: String(criterion.requiredEvidence || criterion.evidence || parts.find(part => part.label === criterion.part)?.prompt || criterion.name || '').slice(0, 420),
    acceptableAlternatives: Array.isArray(criterion.acceptableAlternatives) ? criterion.acceptableAlternatives.slice(0, 5).map(value => String(value).slice(0, 180)) : [],
    cannotAwardIf: Array.isArray(criterion.cannotAwardIf) ? criterion.cannotAwardIf.slice(0, 5).map(value => String(value).slice(0, 180)) : [],
    commonMisconceptions: Array.isArray(criterion.commonMisconceptions) ? criterion.commonMisconceptions.slice(0, 5).map(value => String(value).slice(0, 160)) : [],
  };
  }) : [];
  if (!criteria.length) {
    const evidenceItems = parts.length ? parts : [{ label: '', prompt }];
    criteria = evidenceItems.slice(0, 3).map((part, criterionIndex) => ({ id: `fallback-${index + 1}-${criterionIndex + 1}`, part: part.label, name: part.label ? `Answer part ${part.label}` : 'Answer the task using correct course reasoning', points: 1, requiredEvidence: part.prompt || prompt, acceptableAlternatives: [], cannotAwardIf: [], commonMisconceptions: [] }));
  }
  const exemplar = String(question?.rubric?.exemplar || question?.exemplar || '').slice(0, 3000)
    || `A full-credit response should include: ${criteria.map(criterion => criterion.requiredEvidence).filter(Boolean).join('; ')}`.slice(0, 1200);
  return {
    id: String(question?.id || id()), rubricId: String(question?.rubric?.id || `practice-${Date.now()}-${index}`).slice(0, 80),
    rubricVersion: String(question?.rubric?.version || '1.0').slice(0, 24), topic: String(question?.topic || '').slice(0, 150),
    type: String(question?.type || 'multipart').slice(0, 80), prompt, parts,
    rubric: { id: String(question?.rubric?.id || `practice-${Date.now()}-${index}`).slice(0, 80), version: String(question?.rubric?.version || '1.0').slice(0, 24), criteria, exemplar },
    citations: Array.isArray(question?.citations) ? question.citations.slice(0, 8).map(value => String(value).slice(0, 200)) : [],
    response: '', attempts: [], result: null, submitted: false,
  };
}
function saveFrqSession() {
  if (!activeFrq) return;
  const subject = subjectById(activeFrq.subjectId); if (!subject) return;
  subject.frqActive = activeFrq; app.save();
}
function persistRubrics(subject, session) {
  for (const question of session.questions) {
    subject.frqRubrics.unshift({ id: question.rubricId, version: question.rubricVersion, questionId: question.id, course: subject.name, unit: session.unit, topic: question.topic, createdAt: session.createdAt, criteria: question.rubric.criteria, exemplar: question.rubric.exemplar });
  }
  subject.frqRubrics = subject.frqRubrics.slice(0, 100);
}
async function startFrq() {
  const button = $('#startFrq'), subject = subjectFor('#frqSubject');
  if (activeFrq && !activeFrq.completed) return report('Finish or save your current FRQ session before starting another.');
  if (!subject) return report('Choose a course first.');
  const unit = $('#frqUnit').value.trim(), topic = $('#frqTopic').value.trim(), focus = [unit, topic].filter(Boolean).join(' · ');
  const mode = $('#frqMode').value, count = Number($('#frqCount').value), difficulty = $('#frqDifficulty').value;
  setModeBusy(button, true, 'Preparing fixed rubric…');
  try {
    const sourceIds = selectedDocuments('#frqSources');
    const data = await app.generate('frq', subject, focus || subject.name, count, difficulty, '', sourceIds.length ? sourceIds : null, { questionType: $('#frqQuestionType').value, includeStimulus: $('#frqStimulus').checked });
    if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('The AI could not prepare an FRQ and fixed rubric. Try a narrower course topic.');
    const questions = data.questions.slice(0, count).map(normalizeFrqQuestion);
    if (!questions.length || questions.some(question => !question.prompt || !question.rubric.criteria.length)) throw new Error('Groq did not return a usable question. Try again with a shorter topic or select one question.');
    if (questions.length < count) app.showToast(`Opened ${questions.length} complete question${questions.length === 1 ? '' : 's'} to keep the response within Groq’s limit.`);
    const maxScore = question => question.rubric.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
    const now = new Date().toISOString();
    activeFrq = { id: id(), title: String(data.title || focus || subject.name).slice(0, 160), subjectId: subject.id, unit, topic, difficulty, mode, questions, currentIndex: 0, createdAt: now, startedAt: Date.now(), durationSeconds: mode === 'timed' || mode === 'simulation' ? Number($('#frqMinutes').value) * 60 : null, deadline: mode === 'timed' || mode === 'simulation' ? Date.now() + Number($('#frqMinutes').value) * 60000 : null, completed: false, grading: false, scoreTotal: questions.reduce((sum, question) => sum + maxScore(question), 0), sourceIds };
    questions[0].timeStartedAt = activeFrq.startedAt;
    ensureArrays(subject); persistRubrics(subject, activeFrq); subject.frqActive = activeFrq;
    await app.saveNow(); // Fixed rubric is committed to the user's RTDB record before the question is shown.
    renderFrq(); app.navigate('frq'); window.scrollTo({ top: 0, behavior: 'smooth' }); if (activeFrq.deadline) startTimer();
  } catch (error) { report(error); }
  finally { setModeBusy(button, false); }
}
function renderFrqHistory(subject) {
  const box = $('#frqHistory'); if (!box) return;
  const rows = (subject?.frqAttempts || []).slice(0, 8);
  box.innerHTML = `<div class="mode-history-head"><div><span class="section-kicker">SAVED ATTEMPTS</span><h2>FRQ history</h2></div><span>${rows.length}</span></div>${rows.length ? `<div class="mode-history-list">${rows.map(attempt => `<article><strong>${h(attempt.course || '')}${attempt.unit ? ` · ${h(attempt.unit)}` : ''}${attempt.topic ? ` · ${h(attempt.topic)}` : ''}</strong><span>${h(attempt.earned)}/${h(attempt.available)} points${attempt.improvementPoints === null || attempt.improvementPoints === undefined ? '' : ` · ${attempt.improvementPoints > 0 ? '+' : ''}${h(attempt.improvementPoints)} vs. prior`}</span><small>${new Date(attempt.submittedAt).toLocaleString()} · ${h(attempt.questionType || 'FRQ')} · rubric ${h(attempt.rubricVersion)}</small></article>`).join('')}</div>` : '<p class="mode-muted">Your FRQ scores and rubric versions will be saved here.</p>'}`;
}
function renderFrq() {
  $('#view-frq')?.classList.toggle('frq-taking', Boolean(activeFrq));
  const box = $('#frqStage'); if (!box) return;
  const subject = activeFrq && subjectById(activeFrq.subjectId);
  if (!activeFrq) {
    showEmpty(box, '✎', 'Your next FRQ starts here.', 'Choose a course and generate an original, rubric-scored response question.');
    renderFrqHistory(subjectFor('#frqSubject'));
    return;
  }
  if (activeFrq.completed) {
    const total = activeFrq.questions.reduce((sum, question) => ({ earned: sum.earned + (question.result?.earned || 0), available: sum.available + (question.result?.available || 0) }), { earned: 0, available: 0 });
    box.innerHTML = `<div class="mode-session-head"><div><span class="section-kicker">PRACTICE COMPLETE · FIXED RUBRICS</span><h2>${h(activeFrq.title)}</h2><p>${h(subject?.name || '')} · ${h(activeFrq.mode)}</p></div><div class="mode-score"><strong>${total.earned} / ${total.available}</strong><span>practice points</span></div></div>${activeFrq.questions.map((question, index) => `<article class="completed-frq"><h3>Question ${index + 1} · ${question.result?.earned || 0}/${question.result?.available || 0}</h3>${renderFrqFeedback(question, question.result || { earned: 0, available: 0, criteria: [], confidence: 0, summary: 'No response was submitted.', exemplar: question.rubric.exemplar, improvement: '' })}</article>`).join('')}<button class="button button-primary" id="frqDone">Return to FRQ practice</button><p class="mode-disclaimer">This is AI-assisted practice feedback, not official College Board scoring.</p>`;
    $('#frqDone').onclick = () => { activeFrq = null; renderFrq(); renderModeProgress(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    renderFrqHistory(subject);
    return;
  }
  const session = activeFrq, index = session.currentIndex, question = session.questions[index];
  const blind = session.mode === 'simulation' || session.mode === 'timed';
  const result = question.result;
  const timer = session.deadline ? `<span class="mode-timer" id="frqClock">--:--</span>` : '';
  const parts = question.parts.map(part => `<div class="frq-part"><strong>Part (${h(part.label)}) · ${h(part.points)} pt${part.points === 1 ? '' : 's'}</strong><div>${rich(part.prompt)}</div></div>`).join('');
  const feedback = result && !blind ? renderFrqFeedback(question, result) : '';
  box.innerHTML = `<div class="mode-session-head"><div><span class="section-kicker">${h(session.mode.toUpperCase())} · ${h(session.difficulty)}</span><h2>${h(session.title)}</h2><p>${h(subject?.name || '')}${session.unit ? ` · ${h(session.unit)}` : ''}${question.topic ? ` · ${h(question.topic)}` : ''}</p></div><div>${timer}<button class="text-button" id="stopFrq">Save & exit</button></div></div><div class="mode-progress"><span>QUESTION ${index + 1} / ${session.questions.length}</span><i><b style="width:${(index + 1) / session.questions.length * 100}%"></b></i><small>Fixed rubric ${h(question.rubricVersion)} · ${question.rubric.criteria.reduce((sum, criterion) => sum + criterion.points, 0)} points</small></div><article class="frq-prompt"><div>${rich(question.prompt)}</div>${parts}${citationsMarkup(question.citations)}</article>${blind ? '' : `<details class="frq-rubric-preview"><summary>View fixed scoring criteria</summary><ul>${question.rubric.criteria.map(criterion => `<li><strong>${h(criterion.name)} · ${criterion.points} pt${criterion.points === 1 ? '' : 's'}</strong><span>${rich(criterion.requiredEvidence)}</span></li>`).join('')}</ul></details>`}<label class="mode-answer-label">${blind ? 'Your exam response' : 'Your response'}<textarea id="frqResponse" rows="9" maxlength="14000" placeholder="Answer each part. Show evidence, reasoning, calculations, and units where they are relevant." ${result && !question.retrying ? 'disabled' : ''}>${h(question.response)}</textarea></label><div class="mode-actions">${session.mode === 'guided' && !result ? '<button class="button button-secondary" id="frqHint">Give me a hint</button>' : ''}${result && !blind && !question.retrying ? `<button class="button button-secondary" id="frqRetry">Retry this question</button><button class="button button-secondary" id="frqChallenge">Challenge grading</button><button class="button button-primary" id="frqNext">${index + 1 === session.questions.length ? 'Finish practice' : 'Next question'}</button>` : `<button class="button button-primary" id="frqSubmit" ${session.grading ? 'disabled' : ''}>${session.grading ? 'Grading…' : blind ? (index + 1 === session.questions.length ? 'Submit section' : 'Save & continue') : 'Submit for rubric feedback'}</button>`}</div>${result && !blind ? feedback : session.completedResult ? renderFrqSectionResults(session) : ''}<p class="mode-disclaimer">Practice feedback only. AI scoring is not official College Board scoring.</p>`;
  $('#frqResponse').oninput = event => { question.response = event.target.value; question.retrying = Boolean(result); saveFrqSession(); };
  $('#stopFrq').onclick = async () => { if (confirm('Save this unfinished response and leave practice?')) { saveFrqSession(); activeFrq = null; await app.saveNow(); stopModeTimerIfIdle(); renderFrq(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  $('#frqHint')?.addEventListener('click', requestFrqHint);
  $('#frqSubmit')?.addEventListener('click', submitFrq);
  $('#frqRetry')?.addEventListener('click', () => { question.retrying = true; renderFrq(); $('#frqResponse').focus(); });
  $('#frqChallenge')?.addEventListener('click', challengeFrqGrade);
  $('#frqNext')?.addEventListener('click', nextFrqQuestion);
  renderFrqHistory(subject);
}
function renderFrqFeedback(question, result) {
  return `<section class="mode-feedback"><div class="mode-score"><strong>${h(result.earned)} / ${h(result.available)}</strong><span>${h(result.confidence)}% confidence · practice estimate</span></div><h3>Rubric, point by point</h3>${question.rubric.criteria.map(criterion => {
    const scored = result.criteria.find(item => item.id === criterion.id) || { earned: 0, reason: 'No evaluation returned for this fixed criterion.', missing: criterion.requiredEvidence };
    return `<article class="criterion-result ${scored.earned >= criterion.points ? 'earned' : scored.uncertain ? 'uncertain' : 'missed'}"><div><strong>${h(criterion.name)}</strong><span>${h(scored.earned)} / ${h(criterion.points)} points${scored.uncertain ? ' · uncertain' : ''}</span></div><p>${rich(scored.reason)}</p>${scored.missing ? `<small>Missing or incorrect: ${rich(scored.missing)}</small>` : ''}${scored.nextTime ? `<small>To earn it next time: ${rich(scored.nextTime)}</small>` : ''}</article>`;
  }).join('')}<p>${rich(result.summary)}</p><details><summary>Full-credit sample and comparison</summary><div class="mode-comparison"><article><h4>Your response</h4><div>${rich(question.response || '(No response submitted)')}</div></article><article><h4>Full-credit sample</h4><div>${rich(result.exemplar || question.rubric.exemplar)}</div></article></div><p>${rich(result.improvement || '')}</p>${citationsMarkup(result.citations || question.citations)}</details>${result.reevaluations?.length ? `<details open><summary>Second evaluation against the same rubric</summary><p>${rich(result.reevaluations.at(-1).summary)}</p><strong>${h(result.reevaluations.at(-1).earned)} / ${h(result.reevaluations.at(-1).available)}</strong></details>` : ''}</section>`;
}
function normalizeFrqGrade(raw, question) {
  const criteria = scoreRubricCriteria(question.rubric.criteria, raw?.criteria).map(item => ({ ...item, reason: item.reason.slice(0, 600), missing: item.missing.slice(0, 400), nextTime: item.nextTime.slice(0, 400) }));
  return { criteria, earned: criteria.reduce((sum, item) => sum + item.earned, 0), available: criteria.reduce((sum, item) => sum + item.available, 0), confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 50)), summary: String(raw.summary || 'Review the criterion feedback below.').slice(0, 1400), exemplar: String(raw.exemplar || question.rubric.exemplar).slice(0, 3000), improvement: String(raw.improvement || '').slice(0, 900), citations: Array.isArray(raw.citations) ? raw.citations.slice(0, 8).map(String) : [], reevaluations: [] };
}
async function gradeFrq(question, challenge = false) {
  const subject = subjectById(activeFrq.subjectId);
  const result = await app.generate('frq-grade', subject, question.topic || activeFrq.topic, 1, activeFrq.difficulty, '', activeFrq.sourceIds, { evaluation: { question: question.prompt, parts: question.parts, rubric: question.rubric, response: question.response, task: challenge ? 'Re-evaluate the original response neutrally against exactly the same rubric. Do not see the earlier score.' : 'Score each point.' } });
  const normalized = normalizeFrqGrade(result, question);
  return normalized;
}
async function requestFrqHint() {
  const question = activeFrq.questions[activeFrq.currentIndex], button = $('#frqHint');
  setModeBusy(button, true, 'Thinking…');
  try {
    const subject = subjectById(activeFrq.subjectId);
    const data = await app.generate('frq-hint', subject, question.topic || activeFrq.topic, 1, activeFrq.difficulty, JSON.stringify({ prompt: question.prompt, parts: question.parts }), activeFrq.sourceIds);
    $('#frqHint')?.insertAdjacentHTML('afterend', `<div class="mode-hint">Hint · ${rich(data.hint || 'Identify the rule or evidence the question asks you to use.')}</div>`);
    if ($('#frqHint')) $('#frqHint').remove();
  } catch (error) { report(error); }
  finally { setModeBusy(button, false); }
}
async function submitFrq() {
  if (grading || !activeFrq) return;
  const question = activeFrq.questions[activeFrq.currentIndex];
  question.response = $('#frqResponse').value;
  if (!question.response.trim()) return report('Write a response before submitting.');
  const blind = activeFrq.mode === 'simulation' || activeFrq.mode === 'timed';
  if (blind) {
    question.submitted = true; question.retrying = false; saveFrqSession();
    if (activeFrq.currentIndex + 1 < activeFrq.questions.length) { activeFrq.currentIndex++; renderFrq(); }
    else await finishFrqSection();
    return;
  }
  grading = true; activeFrq.grading = true; renderFrq();
  try {
    const result = await gradeFrq(question);
    question.attempts ||= [];
    const previousAttempt = question.attempts.at(-1);
    const attempt = { id: id(), sessionId: activeFrq.id, questionId: question.id, rubricId: question.rubricId, rubricVersion: question.rubricVersion, course: subjectById(activeFrq.subjectId)?.name, unit: activeFrq.unit, topic: question.topic || activeFrq.topic, questionType: question.type, response: question.response, ...result, submittedAt: new Date().toISOString(), timeSpentSeconds: Math.max(0, Math.round((Date.now() - (question.timeStartedAt || activeFrq.startedAt)) / 1000)), previousEarned: previousAttempt?.earned ?? null, improvementPoints: previousAttempt ? result.earned - previousAttempt.earned : null, rechecks: [] };
    question.attempts.push(attempt); question.result = result; question.retrying = false; question.currentAttemptId = attempt.id;
    recordFrqAttempt(activeFrq, question, attempt);
    saveFrqSession(); await app.saveNow();
  } catch (error) { report(error); }
  finally { grading = false; if (activeFrq) activeFrq.grading = false; renderFrq(); }
}
function recordFrqAttempt(session, question, attempt) {
  const subject = subjectById(session.subjectId); ensureArrays(subject);
  subject.frqAttempts.unshift({ ...attempt, response: attempt.response.slice(0, 12000) }); subject.frqAttempts = subject.frqAttempts.slice(0, 200);
  const state = app.getState(); state.activity ||= [];
  state.activity.unshift({ type: 'ap-frq', subject: subject.name, topic: attempt.topic, score: Math.round(attempt.earned / Math.max(1, attempt.available) * 100), date: attempt.submittedAt }); state.activity = state.activity.slice(0, 500);
  app.renderStudyRhythm();
  if (question.topic) subject.topics = [...new Set([...subject.topics, question.topic])].slice(0, 100);
  if (attempt.earned < attempt.available) {
    subject.mistakes ||= [];
    for (const criterion of attempt.criteria.filter(item => item.earned < item.available)) {
      const fixed = question.rubric.criteria.find(item => item.id === criterion.id);
      subject.mistakes.unshift({ id: id(), question: `${question.prompt}\n${question.parts.map(part => `(${part.label}) ${part.prompt}`).join('\n')}`, studentAnswer: attempt.response, correctAnswer: attempt.exemplar, explanation: `${fixed?.name}: ${criterion.reason} ${criterion.missing} ${criterion.nextTime}`, topic: question.topic || session.topic || 'AP FRQ', category: 'AP FRQ · rubric feedback', date: attempt.submittedAt, resolved: false, rubricId: question.rubricId, rubricVersion: question.rubricVersion });
    }
    subject.mistakes = subject.mistakes.slice(0, 250);
  }
}
async function challengeFrqGrade() {
  if (grading || !activeFrq) return;
  const question = activeFrq.questions[activeFrq.currentIndex], button = $('#frqChallenge');
  const attempt = question.attempts?.find(item => item.id === question.currentAttemptId);
  if (!attempt) return report('Submit an answer before requesting a second rubric review.');
  grading = true; setModeBusy(button, true, 'Rechecking…');
  try {
    const reevaluation = await gradeFrq(question, true);
    attempt.rechecks ||= []; attempt.rechecks.push({ ...reevaluation, submittedAt: new Date().toISOString() });
    question.result.reevaluations ||= []; question.result.reevaluations.push(reevaluation);
    app.save(); renderFrq();
  } catch (error) { report(error); }
  finally { grading = false; }
}
function nextFrqQuestion() {
  if (!activeFrq) return;
  const session = activeFrq, subject = subjectById(session.subjectId);
  if (session.currentIndex + 1 < session.questions.length) { session.currentIndex++; session.questions[session.currentIndex].timeStartedAt = Date.now(); saveFrqSession(); renderFrq(); return; }
  session.completed = true; session.completedAt = new Date().toISOString(); subject.frqSessions.unshift({ id: session.id, title: session.title, unit: session.unit, topic: session.topic, mode: session.mode, difficulty: session.difficulty, questionCount: session.questions.length, createdAt: session.createdAt, completedAt: session.completedAt }); subject.frqSessions = subject.frqSessions.slice(0, 100); subject.frqActive = null; activeFrq = session; stopModeTimerIfIdle(); app.save(); renderFrq(); renderModeProgress();
}
async function finishFrqSection() {
  if (!activeFrq || grading) return;
  grading = true; activeFrq.grading = true; renderFrq();
  try {
    for (const question of activeFrq.questions) {
      if (question.result) continue;
      question.result = await gradeFrq(question);
      const attempt = { id: id(), sessionId: activeFrq.id, questionId: question.id, rubricId: question.rubricId, rubricVersion: question.rubricVersion, course: subjectById(activeFrq.subjectId)?.name, unit: activeFrq.unit, topic: question.topic || activeFrq.topic, response: question.response || '', ...question.result, submittedAt: new Date().toISOString(), timeSpentSeconds: Math.max(0, Math.round((Date.now() - activeFrq.startedAt) / 1000)), rechecks: [] };
      question.attempts = [attempt]; question.currentAttemptId = attempt.id; recordFrqAttempt(activeFrq, question, attempt);
      saveFrqSession(); await app.saveNow();
    }
    activeFrq.completedResult = true; activeFrq.completed = true;
    const subject = subjectById(activeFrq.subjectId); subject.frqActive = null;
    subject.frqSessions.unshift({ id: activeFrq.id, title: activeFrq.title, unit: activeFrq.unit, topic: activeFrq.topic, mode: activeFrq.mode, difficulty: activeFrq.difficulty, questionCount: activeFrq.questions.length, createdAt: activeFrq.createdAt, completedAt: new Date().toISOString() });
    await app.saveNow(); stopModeTimerIfIdle(); renderFrq(); renderModeProgress();
  } catch (error) { report(error); }
  finally { grading = false; if (activeFrq) activeFrq.grading = false; renderFrq(); }
}
function renderFrqSectionResults(session) {
  return `<section class="mode-feedback"><h3>Section submitted · rubric results</h3>${session.questions.map((question, index) => `<article><strong>Question ${index + 1}: ${h(question.result?.earned || 0)} / ${h(question.result?.available || 0)}</strong>${renderFrqFeedback(question, question.result || { earned: 0, available: 0, criteria: [], confidence: 0, summary: '', exemplar: '', improvement: '' })}</article>`).join('')}<button class="button button-primary" id="frqDone">Finish review</button></section>`;
}
function stopModeTimerIfIdle() {
  const frqTimed = Boolean(activeFrq?.deadline && !activeFrq.completed);
  const recallTimed = Boolean(activeRecall?.deadline && !activeRecall.completed);
  if (!frqTimed && !recallTimed) { clearInterval(modeTimer); modeTimer = null; }
}
function startTimer() {
  if (modeTimer) return;
  modeTimer = setInterval(() => {
    if (activeFrq?.deadline && !activeFrq.completed) {
      const left = Math.max(0, activeFrq.deadline - Date.now());
      const clock = $('#frqClock'); if (clock) clock.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      if (!left && !activeFrq.timerExpired) { activeFrq.timerExpired = true; if (activeFrq.mode === 'timed' || activeFrq.mode === 'simulation') finishFrqSection(); }
    }
    if (activeRecall?.deadline && !activeRecall.completed) {
      const left = Math.max(0, activeRecall.deadline - Date.now());
      const clock = $('#recallClock'); if (clock) clock.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      if (!left && !activeRecall.timerExpired) { activeRecall.timerExpired = true; const prompt = activeRecall.prompts[activeRecall.currentIndex]; if (prompt.response.trim() || prompt.drawing) submitRecall(); else finishRecallSession(); }
    }
  }, 1000);
}

// Active recall. The prompt, concept checklist, and source reference are stored before the answer is requested.
function normalizeRecallPrompt(prompt, index) {
  const criteria = Array.isArray(prompt?.criteria) ? prompt.criteria.slice(0, 8).map((item, i) => ({ id: String(item.id || `r${i + 1}`).slice(0, 32), concept: String(item.concept || '').slice(0, 130), evidence: String(item.evidence || '').slice(0, 350), weight: Math.max(1, Math.min(3, Number(item.weight) || 1)) })) : [];
  return { id: String(prompt?.id || id()), conceptId: String(prompt?.conceptId || prompt?.topic || `concept-${index}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 90), topic: String(prompt?.topic || '').slice(0, 150), type: String(prompt?.type || 'explain'), prompt: String(prompt?.prompt || '').slice(0, 1800), referenceAnswer: String(prompt?.referenceAnswer || '').slice(0, 2600), criteria, citations: Array.isArray(prompt?.citations) ? prompt.citations.slice(0, 8).map(value => String(value).slice(0, 200)) : [], simplerFollowup: String(prompt?.simplerFollowup || '').slice(0, 600), response: '', result: null, attempts: [] };
}
async function startRecall() {
  const button = $('#startRecall'), subject = subjectFor('#recallSubject');
  if (activeRecall && !activeRecall.completed) return report('Finish or save your current recall session before starting another.');
  if (!subject) return report('Choose a course first.');
  const unit = $('#recallUnit').value.trim(), topic = $('#recallTopic').value.trim(), focus = [unit, topic].filter(Boolean).join(' · ');
  setModeBusy(button, true, 'Preparing recall prompts…');
  try {
    const sourceIds = selectedDocuments('#recallSources');
    const count = Number($('#recallCount').value), minutes = $('#recallMinutes').value === 'custom' ? 0 : Number($('#recallMinutes').value);
    const data = await app.generate('recall', subject, focus || subject.name, count, $('#recallDifficulty').value, '', sourceIds.length ? sourceIds : null, { recallType: $('#recallType').value });
    if (!Array.isArray(data.prompts) || !data.prompts.length) throw new Error('No recall prompts were generated. Try choosing a narrower topic.');
    const prompts = data.prompts.slice(0, count).map(normalizeRecallPrompt);
    if (prompts.some(prompt => !prompt.prompt || !prompt.referenceAnswer || !prompt.criteria.length)) throw new Error('The recall checklist was incomplete. Try generating the session again.');
    activeRecall = { id: id(), subjectId: subject.id, title: String(data.title || focus || subject.name).slice(0, 140), unit, topic, difficulty: $('#recallDifficulty').value, recallType: $('#recallType').value, adaptive: $('#recallAdaptive')?.checked !== false, prompts, currentIndex: 0, startedAt: Date.now(), deadline: minutes ? Date.now() + minutes * 60000 : null, completed: false, sourceIds };
    ensureArrays(subject); subject.recallActive = activeRecall; await app.saveNow(); renderRecall(); if (activeRecall.deadline) startTimer();
  } catch (error) { report(error); }
  finally { setModeBusy(button, false); }
}
function saveRecallSession() {
  if (!activeRecall) return;
  const subject = subjectById(activeRecall.subjectId); if (!subject) return;
  subject.recallActive = activeRecall; app.save();
}
function renderRecall() {
  const box = $('#recallStage'); if (!box) return;
  if (!activeRecall) { showEmpty(box, '⟳', 'Recall without looking.', 'Pick a topic or course source, then explain what you remember.'); renderRecallHistory(subjectFor('#recallSubject')); return; }
  const session = activeRecall, index = session.currentIndex, prompt = session.prompts[index];
  if (!prompt) return;
  const result = prompt.result;
  const typeLabel = ({ explain: 'Explain from memory', blank: 'Blank-page recall', steps: 'Reconstruct the steps', formula: 'Formula recall', relationship: 'Concept relationships', compare: 'Compare and contrast', application: 'Apply to a new scenario', diagram: 'Diagram reconstruction' })[prompt.type] || prompt.type;
  box.innerHTML = `<div class="mode-session-head"><div><span class="section-kicker">ACTIVE RECALL · ${h(typeLabel)}${session.adaptive ? ' · ADAPTIVE' : ''}</span><h2>${h(session.title)}</h2><p>${h(subjectById(session.subjectId)?.name || '')}${prompt.topic ? ` · ${h(prompt.topic)}` : ''}</p></div><div>${session.deadline ? '<span class="mode-timer" id="recallClock">--:--</span>' : ''}<button class="text-button" id="stopRecall">Save & exit</button></div></div><div class="mode-progress"><span>PROMPT ${index + 1} / ${session.prompts.length}</span><i><b style="width:${(index + 1) / session.prompts.length * 100}%"></b></i><small>Try from memory first; your notes stay hidden until you submit.</small></div><article class="frq-prompt recall-prompt">${rich(prompt.prompt)}${citationsMarkup(prompt.citations)}</article>${prompt.type === 'diagram' ? '<div class="recall-sketch"><div><strong>Diagram workspace</strong><button type="button" class="text-button" id="clearRecallSketch">Clear drawing</button></div><canvas id="recallSketch" width="900" height="320" aria-label="Draw your recalled diagram"></canvas><small>Your diagram is included in the recall review.</small></div>' : ''}<label class="mode-answer-label">${result ? 'Your response' : 'Write or explain from memory'}<textarea id="recallResponse" rows="8" maxlength="10000" placeholder="${prompt.type === 'blank' ? 'Use this blank page to reconstruct everything you remember…' : 'Explain your reasoning in your own words…'}" ${result ? 'disabled' : ''}>${h(prompt.response)}</textarea></label>${result ? renderRecallFeedback(prompt, result) : ''}<div class="mode-actions">${!result ? `<button class="button button-primary" id="recallSubmit">Evaluate recall</button>` : `<button class="button button-secondary" id="recallCompare">${prompt.comparisonOpen ? 'Hide comparison' : 'Reveal notes & compare'}</button><button class="button button-primary" id="recallNext">${index + 1 === session.prompts.length ? 'Finish session' : 'Next recall prompt'}</button>`}</div>${result && prompt.comparisonOpen ? renderRecallComparison(prompt) : ''}<p class="mode-disclaimer">Recall scores are learning estimates based on the saved concept checklist.</p>`;
  $('#recallResponse').oninput = event => { prompt.response = event.target.value; saveRecallSession(); };
  $('#stopRecall').onclick = async () => { if (!confirm('Save this unfinished recall session and leave?')) return; activeRecall = null; stopModeTimerIfIdle(); await app.saveNow(); renderRecall(); };
  $('#recallSubmit')?.addEventListener('click', submitRecall);
  $('#recallNext')?.addEventListener('click', nextRecall);
  $('#recallCompare')?.addEventListener('click', () => { prompt.comparisonOpen = !prompt.comparisonOpen; renderRecall(); });
  if (prompt.type === 'diagram' && !result) setupRecallSketch(prompt);
  renderRecallHistory(subjectById(session.subjectId));
}
function setupRecallSketch(prompt) {
  const canvas = $('#recallSketch'); if (!canvas) return;
  const context = canvas.getContext('2d'), image = prompt.drawing;
  context.fillStyle = '#173129'; context.fillRect(0, 0, canvas.width, canvas.height);
  if (image) { const bitmap = new Image(); bitmap.onload = () => context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.src = image; }
  context.strokeStyle = '#f7f4e8'; context.lineWidth = 4; context.lineCap = 'round'; context.lineJoin = 'round';
  let drawing = false;
  const point = event => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; };
  canvas.onpointerdown = event => { drawing = true; canvas.setPointerCapture(event.pointerId); const p = point(event); context.beginPath(); context.moveTo(p.x, p.y); };
  canvas.onpointermove = event => { if (!drawing) return; const p = point(event); context.lineTo(p.x, p.y); context.stroke(); prompt.drawing = canvas.toDataURL('image/jpeg', .55); saveRecallSession(); };
  canvas.onpointerup = () => { drawing = false; prompt.drawing = canvas.toDataURL('image/jpeg', .55); saveRecallSession(); };
  $('#clearRecallSketch').onclick = () => { context.fillStyle = '#173129'; context.fillRect(0, 0, canvas.width, canvas.height); prompt.drawing = canvas.toDataURL('image/jpeg', .55); saveRecallSession(); };
}
function renderRecallFeedback(prompt, result) {
  const list = (items, cls) => items?.length ? `<ul class="recall-${cls}">${items.map(item => `<li>${rich(item)}</li>`).join('')}</ul>` : '<p>None identified.</p>';
  return `<section class="mode-feedback recall-feedback"><div class="mode-score"><strong>${h(result.score)} / 100</strong><span>${h(result.confidence)}% confidence · weighted concept points</span></div><div class="recall-criteria">${(result.scoredCriteria || []).map(item => `<article><strong>${item.earned >= item.weight ? '✓' : '○'} ${h(item.concept)}</strong><span>${h(item.earned)} / ${h(item.weight)} · ${rich(item.reason)}</span></article>`).join('')}</div><div class="recall-feedback-grid"><article><h3>Remembered</h3>${list(result.remembered, 'remembered')}</article><article><h3>Missing</h3>${list(result.missing, 'missing')}</article><article><h3>Incorrect</h3>${list(result.incorrect, 'incorrect')}</article></div><p>${rich(result.explanation)}</p><p><strong>Review next:</strong> ${rich(result.review)}</p><p><strong>Follow-up:</strong> ${rich(result.followup || prompt.simplerFollowup)}</p></section>`;
}
function renderRecallComparison(prompt) {
  const source = [prompt.referenceAnswer, ...(prompt.citations || []).map(item => `Source: ${item}`)].filter(Boolean).join('\n\n');
  return `<section class="recall-comparison"><article><h3>Your response</h3><div>${rich(prompt.response || '(No response)')}</div></article><article><h3>Reference and source</h3><div>${rich(source)}</div></article></section>`;
}
async function submitRecall() {
  if (!activeRecall || grading) return;
  const prompt = activeRecall.prompts[activeRecall.currentIndex];
  if ($('#recallResponse')) prompt.response = $('#recallResponse').value;
  if (!prompt.response.trim() && !prompt.drawing) return report('Add a response or diagram before submitting.');
  const subject = subjectById(activeRecall.subjectId), evaluation = { prompt: prompt.prompt, type: prompt.type, criteria: prompt.criteria, referenceAnswer: prompt.referenceAnswer, response: prompt.response, task: 'Score only against the concept checklist. Accept correct ideas in different wording.' };
  grading = true; renderRecall();
  try {
    const data = await app.generate('recall-grade', subject, prompt.topic || activeRecall.topic, 1, activeRecall.difficulty, '', activeRecall.sourceIds, { evaluation, image: prompt.drawing || undefined });
    const weighted = scoreWeightedCriteria(prompt.criteria, data.scoredCriteria);
    const scoredCriteria = weighted.criteria.map(item => ({ ...item, reason: item.reason.slice(0, 400) }));
    // The prepared concept checklist is the scoring authority; missing criterion IDs earn no points.
    const score = weighted.score;
    const result = { score, scoredCriteria, remembered: Array.isArray(data.remembered) ? data.remembered.slice(0, 8).map(String) : [], missing: Array.isArray(data.missing) ? data.missing.slice(0, 8).map(String) : [], incorrect: Array.isArray(data.incorrect) ? data.incorrect.slice(0, 8).map(String) : [], extra: Array.isArray(data.extra) ? data.extra.slice(0, 8).map(String) : [], explanation: String(data.explanation || 'Compare your answer with the reference checklist.').slice(0, 1300), review: String(data.review || 'Review the missing ideas, then retrieve them again tomorrow.').slice(0, 700), followup: String(data.followup || prompt.simplerFollowup).slice(0, 700), confidence: Math.max(0, Math.min(100, Number(data.confidence) || 50)), criterionWeight: weighted.available, evaluatedAt: new Date().toISOString() };
    prompt.result = result; prompt.attempts ||= []; prompt.attempts.push({ response: prompt.response, score, evaluatedAt: result.evaluatedAt });
    recordRecallResult(activeRecall, prompt, result); saveRecallSession(); await app.saveNow(); renderRecall(); renderModeProgress();
  } catch (error) { report(error); renderRecall(); }
  finally { grading = false; }
}
function recordRecallResult(session, prompt, result) {
  const subject = subjectById(session.subjectId); ensureArrays(subject);
  const current = subject.recallMastery[prompt.conceptId] || { conceptId: prompt.conceptId, topic: prompt.topic || session.topic || 'Course concepts', successes: 0, failures: 0, recalls: 0, intervalDays: 0, successfulSessionIds: [], successfulTypes: [] };
  current.recalls++; current.lastScore = result.score; current.lastReviewAt = result.evaluatedAt; current.lastType = prompt.type;
  current.successfulSessionIds ||= []; current.successfulTypes ||= [];
  if (result.score >= 80) {
    current.successes++;
    current.successfulSessionIds = [...new Set([...current.successfulSessionIds, session.id])].slice(-12);
    current.successfulTypes = [...new Set([...current.successfulTypes, prompt.type])].slice(-12);
    const retrievalMastered = current.successfulSessionIds.length >= 2 && current.successfulTypes.length >= 2;
    current.intervalDays = !retrievalMastered ? 1 : current.successfulSessionIds.length === 2 ? 3 : Math.min(60, Math.max(4, current.intervalDays * 2));
  }
  else { current.failures++; current.intervalDays = result.score < 55 ? 1 : 2; }
  const variedRetrieval = Math.min(1, (current.successfulSessionIds.length / 2), (current.successfulTypes.length / 2));
  current.retentionEstimate = Math.max(0, Math.min(100, Math.round(result.score * variedRetrieval)));
  current.nextReviewAt = new Date(Date.now() + current.intervalDays * 86400000).toISOString();
  subject.recallMastery[prompt.conceptId] = current;
  subject.flashcards ||= [];
  let card = subject.flashcards.find(item => item.recallConceptId === prompt.conceptId);
  if (!card) {
    card = { id: id(), front: prompt.prompt, back: prompt.referenceAnswer, topic: prompt.topic || session.topic, interval: current.intervalDays, dueAt: current.nextReviewAt, reviews: 0, recallConceptId: prompt.conceptId };
    subject.flashcards.unshift(card);
  } else {
    card.front = prompt.prompt; card.back = prompt.referenceAnswer; card.topic = prompt.topic || session.topic;
    card.interval = current.intervalDays; card.dueAt = current.nextReviewAt; card.reviews = Math.max(card.reviews || 0, current.recalls);
  }
  subject.flashcards = subject.flashcards.slice(0, 500);
  const state = app.getState(); state.activity ||= [];
  state.activity.unshift({ type: 'active-recall', subject: subject.name, topic: prompt.topic, score: result.score, date: result.evaluatedAt }); state.activity = state.activity.slice(0, 500);
  app.renderStudyRhythm();
  subject.topics = [...new Set([...subject.topics, prompt.topic || session.topic].filter(Boolean))].slice(0, 100);
  const history = subject.recallSessions || [];
  const saved = history.find(item => item.id === session.id);
  if (!saved) history.unshift({ id: session.id, subject: subject.name, title: session.title, unit: session.unit, topic: session.topic, startedAt: new Date(session.startedAt).toISOString(), results: [] });
  const target = history.find(item => item.id === session.id); target.results ||= []; target.results.push({ promptId: prompt.id, conceptId: prompt.conceptId, topic: prompt.topic, type: prompt.type, score: result.score, at: result.evaluatedAt, nextReviewAt: current.nextReviewAt });
  subject.recallSessions = history.slice(0, 100);
  if (result.score < 70) {
    subject.mistakes ||= [];
    subject.mistakes.unshift({ id: id(), question: prompt.prompt, studentAnswer: prompt.response, correctAnswer: prompt.referenceAnswer, explanation: `Recall score ${result.score}/100. Missing: ${result.missing.join('; ')}. Incorrect: ${result.incorrect.join('; ')}. ${result.review}`, topic: prompt.topic || session.topic, category: 'Active recall', date: result.evaluatedAt, resolved: false });
    subject.mistakes = subject.mistakes.slice(0, 250);
  }
}
async function nextRecall() {
  if (!activeRecall) return;
  const session = activeRecall, subject = subjectById(session.subjectId), previous = session.prompts[session.currentIndex], nextIndex = session.currentIndex + 1;
  if (session.timerExpired) {
    session.completed = true; session.completedAt = new Date().toISOString(); subject.recallActive = null; activeRecall = null; stopModeTimerIfIdle(); await app.saveNow(); renderRecall(); renderModeProgress(); return;
  }
  if (session.adaptive && previous.result && (previous.result.score < 60 || previous.result.score >= 85)) {
    const button = $('#recallNext'); setModeBusy(button, true, 'Preparing a varied follow-up…');
    try {
      const previousPerformance = { previousPrompt: previous.prompt, previousAnswer: previous.response.slice(0, 1800), score: previous.result.score, missing: previous.result.missing, topic: previous.topic, direction: previous.result.score < 60 ? 'simpler scaffolding and same concept' : 'more difficult novel application or connection' };
      const data = await app.generate('recall-followup', subject, previous.topic || session.topic, 1, previous.result.score < 60 ? 'Easy' : 'Hard', JSON.stringify(previousPerformance), session.sourceIds);
      const next = data.prompts?.[0];
      if (next?.prompt && next.referenceAnswer && next.criteria?.length) {
        const followup = normalizeRecallPrompt(next, nextIndex);
        if (nextIndex < session.prompts.length) session.prompts[nextIndex] = followup;
        else session.prompts.push(followup);
      }
    } catch (error) { console.warn('Adaptive recall prompt could not be prepared; using the saved session prompt.', error); }
  }
  if (nextIndex >= session.prompts.length) {
    session.completed = true; session.completedAt = new Date().toISOString(); subject.recallActive = null; activeRecall = null; stopModeTimerIfIdle(); await app.saveNow(); renderRecall(); renderModeProgress(); return;
  }
  session.currentIndex++; saveRecallSession(); renderRecall();
}
function renderRecallHistory(subject) {
  const box = $('#recallHistory'); if (!box) return;
  const sessions = subject?.recallSessions || [], mastery = Object.values(subject?.recallMastery || {});
  const due = mastery.filter(item => !item.nextReviewAt || new Date(item.nextReviewAt) <= new Date()).length;
  const weakest = [...mastery].sort((a, b) => (a.retentionEstimate || 0) - (b.retentionEstimate || 0)).slice(0, 5);
  box.innerHTML = `<div class="mode-history-head"><div><span class="section-kicker">SPACED RETRIEVAL</span><h2>Recall progress</h2></div><span>${due} due</span></div>${weakest.length ? `<div class="recall-mastery-grid">${weakest.map(item => `<article><strong>${h(item.topic)}</strong><span>${h(item.retentionEstimate || 0)}% retention estimate</span><small>${h(item.successes || 0)} successful · ${h(item.failures || 0)} missed · next ${item.nextReviewAt ? new Date(item.nextReviewAt).toLocaleDateString() : 'due now'}</small><button class="text-button" data-recall-topic="${h(item.topic)}">Practice this topic →</button></article>`).join('')}</div>` : '<p class="mode-muted">Recall accuracy, repeated successes, and review dates appear here as you practice.</p>'}${sessions.length ? `<div class="mode-history-list">${sessions.slice(0, 6).map(item => `<article><strong>${h(item.topic || item.title || 'Recall session')}</strong><span>${item.results?.length || 0} prompt${item.results?.length === 1 ? '' : 's'} · ${Math.round((item.results || []).reduce((sum, result) => sum + result.score, 0) / Math.max(1, item.results?.length || 1))}% avg</span><small>${new Date(item.startedAt).toLocaleString()}</small></article>`).join('')}</div>` : ''}`;
  box.querySelectorAll('[data-recall-topic]').forEach(button => button.onclick = () => { $('#recallTopic').value = button.dataset.recallTopic; $('#recallType').value = 'mixed'; $('#recallCount').value = '3'; app.navigate('recall'); });
}
function finishRecallSession() {
  if (!activeRecall) return;
  const subject = subjectById(activeRecall.subjectId); if (subject) subject.recallActive = null;
  activeRecall.completed = true; activeRecall = null; stopModeTimerIfIdle(); app.save(); renderRecall(); renderModeProgress();
}
function renderModeProgress() {
  const box = $('#studyModeProgress'); if (!box) return;
  const subjects = app.getState().subjects;
  const frqs = subjects.flatMap(subject => subject.frqAttempts || []), recall = subjects.flatMap(subject => subject.recallSessions || []), mastery = subjects.flatMap(subject => Object.values(subject.recallMastery || {}));
  const points = frqs.reduce((total, attempt) => ({ earned: total.earned + attempt.earned, available: total.available + attempt.available }), { earned: 0, available: 0 });
  const weak = [...mastery].sort((a, b) => (a.retentionEstimate || 0) - (b.retentionEstimate || 0)).slice(0, 5);
  const missedPoints = new Map();
  for (const attempt of frqs) for (const criterion of (attempt.criteria || []).filter(item => item.earned < item.available)) missedPoints.set(criterion.name, (missedPoints.get(criterion.name) || 0) + 1);
  const common = [...missedPoints].sort((a, b) => b[1] - a[1]).slice(0, 5);
  box.innerHTML = `<section class="panel mode-progress-dashboard"><div class="mode-history-head"><div><span class="section-kicker">EXTENDED RESPONSE & RETENTION</span><h2>AP readiness practice</h2></div><button class="text-button" data-open="frq">Practice an FRQ →</button></div><div class="mode-stat-grid"><article><span>FRQ attempts</span><strong>${frqs.length}</strong></article><article><span>Rubric points</span><strong>${points.available ? `${points.earned}/${points.available}` : '—'}</strong></article><article><span>Recall sessions</span><strong>${recall.length}</strong></article><article><span>Tracked concepts</span><strong>${mastery.length}</strong></article></div>${common.length ? `<h3>Rubric criteria to strengthen</h3><div class="mode-weak-topics">${common.map(([name, count]) => `<article><strong>${h(name)}</strong><span>${count} attempt${count === 1 ? '' : 's'} missed a point</span></article>`).join('')}</div>` : ''}${weak.length ? `<h3>Topics to practice again</h3><div class="mode-weak-topics">${weak.map(item => `<article><strong>${h(item.topic)} · ${h(item.retentionEstimate || 0)}%</strong><div><button class="text-button" data-progress-recall="${h(item.topic)}">Active recall</button><button class="text-button" data-progress-frq="${h(item.topic)}">FRQ practice</button></div></article>`).join('')}</div>` : '<p class="mode-muted">Complete FRQs and recall sessions to build a topic-level readiness view.</p>'}</section>`;
  if (frqs.length) {
    const breakdown = new Map();
    for (const attempt of frqs) {
      const key = [attempt.course || 'Course', attempt.unit || 'Unit not tagged', attempt.questionType || 'FRQ'].join(' · ');
      const row = breakdown.get(key) || { earned: 0, available: 0, count: 0 };
      row.earned += attempt.earned || 0; row.available += attempt.available || 0; row.count++; breakdown.set(key, row);
    }
    const breakdownView = document.createElement('section'); breakdownView.className = 'mode-breakdown-wrap';
    breakdownView.innerHTML = `<h3>FRQ results by course, unit & type</h3><div class="mode-breakdown">${[...breakdown].slice(0, 8).map(([key, row]) => `<article><strong>${h(key)}</strong><span>${row.earned}/${row.available} points · ${row.count} attempt${row.count === 1 ? '' : 's'}</span></article>`).join('')}</div>`;
    box.querySelector('.mode-stat-grid')?.insertAdjacentElement('afterend', breakdownView);
  }
  box.querySelector('[data-open]')?.addEventListener('click', () => app.navigate('frq'));
  box.querySelectorAll('[data-progress-recall]').forEach(button => button.onclick = () => { $('#recallTopic').value = button.dataset.progressRecall; app.navigate('recall'); });
  box.querySelectorAll('[data-progress-frq]').forEach(button => button.onclick = () => { $('#frqTopic').value = button.dataset.progressFrq; app.navigate('frq'); });
}

async function restoreActiveSession() {
  fillSubjects();
  const subjects = app.getState().subjects;
  const frqSubject = subjects.find(subject => subject.frqActive && !subject.frqActive.completed);
  if (frqSubject) { ensureArrays(frqSubject); activeFrq = frqSubject.frqActive; renderFrq(); if (activeFrq.deadline) startTimer(); }
  const recallSubject = subjects.find(subject => subject.recallActive && !subject.recallActive.completed);
  if (recallSubject) { ensureArrays(recallSubject); activeRecall = recallSubject.recallActive; renderRecall(); if (activeRecall.deadline) startTimer(); }
  renderFrqHistory(subjectFor('#frqSubject')); renderRecallHistory(subjectFor('#recallSubject'));
}

for (const [selector, subjectSelector] of [['#frqSubject', '#frqSources'], ['#recallSubject', '#recallSources']]) $(selector)?.addEventListener('change', refreshDocs);
$('#frqSubject')?.addEventListener('focus', repairCourseOptions);
$('#frqSubject')?.addEventListener('pointerdown', repairCourseOptions);
$('#startFrq')?.addEventListener('click', startFrq);
$('#startRecall')?.addEventListener('click', startRecall);
$('#frqMode')?.addEventListener('change', () => { $('#frqMinutesLabel').hidden = !['timed', 'simulation'].includes($('#frqMode').value); });
$('#frqMode')?.dispatchEvent(new Event('change'));
window.addEventListener('studyspace:state-ready', restoreActiveSession);
window.addEventListener('studyspace:flashcard-reviewed', event => {
  const { subjectId, cardId, grade, reviewId } = event.detail || {}, subject = subjectById(subjectId);
  const card = subject?.flashcards?.find(item => item.id === cardId);
  const mastery = card?.recallConceptId && subject?.recallMastery?.[card.recallConceptId];
  if (!mastery) return;
  mastery.recalls = (mastery.recalls || 0) + 1; mastery.lastReviewAt = new Date().toISOString(); mastery.lastType = 'flashcard';
  if (grade === 'forgot') { mastery.failures = (mastery.failures || 0) + 1; mastery.intervalDays = 1; mastery.retentionEstimate = Math.max(0, Math.round((mastery.retentionEstimate || 0) * .7)); }
  else { mastery.successes = (mastery.successes || 0) + 1; mastery.successfulSessionIds ||= []; mastery.successfulSessionIds = [...new Set([...mastery.successfulSessionIds, `flashcard:${card.id}:${reviewId || id()}`])].slice(-12); mastery.successfulTypes ||= []; mastery.successfulTypes = [...new Set([...mastery.successfulTypes, 'flashcard'])]; mastery.intervalDays = grade === 'hard' ? Math.max(1, card.interval || 1) : Math.max(2, Math.round((card.interval || 1) * 1.5)); mastery.retentionEstimate = Math.min(100, Math.round((mastery.retentionEstimate || 0) * .75 + 25)); }
  mastery.nextReviewAt = new Date(Date.now() + mastery.intervalDays * 86400000).toISOString(); card.interval = mastery.intervalDays; card.dueAt = mastery.nextReviewAt;
  app.save(); renderModeProgress();
});
window.addEventListener('studyspace:view-changed', event => {
  if (event.detail?.name === 'progress') renderModeProgress();
  if (event.detail?.name === 'frq') { fillSubjects(); if (!activeFrq) activeFrq = app.getState().subjects.find(subject => subject.frqActive && !subject.frqActive.completed)?.frqActive || null; renderFrq(); renderFrqHistory(subjectFor('#frqSubject')); if (activeFrq?.deadline) startTimer(); }
  if (event.detail?.name === 'recall') { fillSubjects(); if (!activeRecall) activeRecall = app.getState().subjects.find(subject => subject.recallActive && !subject.recallActive.completed)?.recallActive || null; renderRecall(); renderRecallHistory(subjectFor('#recallSubject')); if (activeRecall?.deadline) startTimer(); }
});
if (app?.isReady?.()) restoreActiveSession();
