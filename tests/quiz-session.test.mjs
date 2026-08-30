import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortedQuestions, budgetsFor, remainingMs, ensureQuizState, integrityPatch, isOpenQuestion,
} from '../src/api/quiz-session.mjs';
import { questionForCandidate } from '../src/api/projections.mjs';
import { requiresSpokenAnswer, hasSpokenEvidence, openAnswerHasContent } from '../src/core/spoken-answer.mjs';
import { EXAM_MCQ_SECONDS, EXAM_OPEN_REVIEW_SECONDS, EXAM_OPEN_ANSWER_SECONDS } from '../src/core/constants.mjs';

test('MCQ budget is 30s; open questions get 60s review + 2 minutes answer', () => {
  assert.deepEqual(budgetsFor({ type: 'mcq_single' }), { review_ms: 0, answer_ms: EXAM_MCQ_SECONDS * 1000 });
  assert.deepEqual(budgetsFor({ type: 'scale' }), { review_ms: 0, answer_ms: 30_000 });
  assert.equal(isOpenQuestion({ type: 'text' }), true);
  assert.deepEqual(budgetsFor({ type: 'text' }), {
    review_ms: EXAM_OPEN_REVIEW_SECONDS * 1000,
    answer_ms: EXAM_OPEN_ANSWER_SECONDS * 1000,
  });
});

test('remaining time never goes negative and open review uses the review window', () => {
  const started = new Date(Date.now() - 10_000).toISOString();
  const mcqLeft = remainingMs({ type: 'mcq_single' }, { question_started_at: started, phase: 'answer' });
  assert.ok(mcqLeft <= 20_000 && mcqLeft > 0);
  const reviewLeft = remainingMs({ type: 'text' }, { question_started_at: started, phase: 'review' });
  assert.ok(reviewLeft <= 50_000 && reviewLeft > 0);
  const expired = remainingMs({ type: 'mcq_single' }, { question_started_at: new Date(Date.now() - 90_000).toISOString(), phase: 'answer' });
  assert.equal(expired, 0);
});

test('quiz cursor starts at first item; integrity events increment counters', () => {
  const qs = sortedQuestions({ questions: [{ id: 'b', order: 2, type: 'text' }, { id: 'a', order: 1, type: 'mcq_single' }] });
  assert.deepEqual(qs.map((q) => q.id), ['a', 'b']);
  const state = ensureQuizState({ snapshot_json: { questions: qs } }, qs);
  assert.equal(state.index, 0);
  assert.equal(state.phase, 'answer');
  const next = integrityPatch(state, 'copy', 'Copy blocked', { question_index: 0, question_id: 'q1', question_prompt: 'Prompt?' });
  assert.equal(next.integrity.copy, 1);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].event, 'copy');
  assert.equal(next.events[0].detail, 'Copy blocked');
  assert.equal(next.events[0].question_id, 'q1');
  const unknown = integrityPatch(next, 'select_all', 'Select-all blocked');
  assert.equal(unknown.integrity.copy, 1);
  assert.equal(unknown.integrity.other, 1, 'unknown integrity events are filed under other');
  assert.equal(unknown.events.length, 2, 'unknown events are still appended to the trail');
});

test('sortedQuestions never serves a question twice', () => {
  const questions = [
    { id: 'a', order: 1, type: 'mcq_single', prompt: 'A?' },
    { id: 'a', order: 1, type: 'text', prompt: 'A duplicate id?' },
    { id: 'b', order: 2, type: 'text', prompt: 'B?' },
    { id: 'b', order: 2, type: 'text', prompt: 'B duplicate id?' },
    { id: 'c', order: 3, type: 'mcq_multi', prompt: 'B?' },
  ];
  const qs = sortedQuestions({ questions });
  assert.deepEqual(qs.map((q) => q.id), ['a', 'b'], 'duplicate ids/prompts are dropped');
  assert.deepEqual(qs.map((q) => q.prompt), ['A?', 'B?']);
});

test('sortedQuestions collapses typography/label variants of one prompt and keeps the microphone requirement', () => {
  // Frozen pre-fix snapshot: the flagged published copy of the common spoken
  // question plus a legacy copy that differs only by the leading label and
  // punctuation — the shape that made the exam ask the same question twice,
  // the second time with no microphone.
  const questions = [
    { id: 'pin', order: 0, type: 'text', question_set: 'rsa-oral', pin_first: true, audio_required: true,
      prompt: 'COMMON QUESTION — In simple terms, what problem does Databricks solve?' },
    { id: 'legacy', order: 5, type: 'text',
      prompt: 'In simple terms, what problem does Databricks solve?' },
    { id: 'other', order: 2, type: 'text', prompt: 'A different question entirely?' },
  ];
  const qs = sortedQuestions({ questions });
  assert.deepEqual(qs.map((q) => q.id), ['pin', 'other'], 'the label-less twin is recognized as the same question');
  assert.equal(qs[0].pin_first, true, 'still pinned first');
  assert.equal(qs[0].audio_required, true, 'still requires an audio answer');
  assert.equal(qs[0].question_set, 'rsa-oral', 'still a spoken-set question');
  // The source snapshot rows are never mutated by the merge.
  assert.equal(questions[0].order, 0);
  assert.equal(questions[2].prompt, 'A different question entirely?');
});

test('sortedQuestions merges a flagged twin onto an unflagged survivor (frozen legacy snapshot)', () => {
  // Here the flag-less legacy copy comes FIRST in the frozen array (same
  // prompt, straight quotes); the survivor must still inherit the spoken
  // contract from its curly-quoted published twin.
  const questions = [
    { id: 'legacy', order: 0, type: 'text',
      prompt: 'A client says, "We already have a data warehouse and Spark environment. Why do we need Databricks?"' },
    { id: 'flagged', order: 1, type: 'text', question_set: 'rsa-oral', audio_required: true,
      prompt: 'A client says, “We already have a data warehouse and Spark environment. Why do we need Databricks?”' },
    { id: 'plain', order: 2, type: 'text', prompt: 'Unrelated open question.' },
  ];
  const qs = sortedQuestions({ questions });
  const merged = qs.find((q) => q.id === 'legacy');
  assert.ok(merged, 'the survivor keeps its row identity');
  assert.equal(merged.question_set, 'rsa-oral', 'set membership is inherited from the twin');
  assert.equal(merged.audio_required, true, 'the microphone requirement is inherited from the twin');
  assert.equal(qs.filter((q) => String(q.prompt).includes('Why do we need')).length, 1, 'served once');
});

test('candidate projection shows the microphone on EVERY open question', () => {
  // The microphone is a rule of the open-question type, not a per-question
  // opt-in (core/spoken-answer.mjs), so the projection cannot be talked out of
  // it by a stripped flag, an unhealed legacy row or a standard (non-spoken)
  // prompt. This is what fixes "no record button on questions 7-10".
  assert.equal(
    questionForCandidate({ id: 'a', type: 'text', prompt: 'p', question_set: 'rsa-oral', audio_required: false }).audio_required,
    true,
  );
  assert.equal(
    questionForCandidate({ id: 'b', type: 'text', prompt: 'p', question_set: 'rsa-oral' }).audio_required,
    true,
  );
  assert.equal(
    questionForCandidate({ id: 'c', type: 'text', prompt: 'p', audio_required: true }).audio_required,
    true,
  );
  assert.equal(
    questionForCandidate({ id: 'd', type: 'text', prompt: 'p' }).audio_required,
    true,
    'a standard open question demands the recorded answer too',
  );
  // Non-open questions are untouched unless they explicitly opt in.
  assert.equal(questionForCandidate({ id: 'e', type: 'mcq_single', prompt: 'p' }).audio_required, false);
  assert.equal(questionForCandidate({ id: 'f', type: 'scale', prompt: 'p' }).audio_required, false);
  assert.equal(questionForCandidate({ id: 'g', type: 'mcq_multi', prompt: 'p', audio_required: true }).audio_required, true);
});

test('the open-question contract is decided by type, and spoken evidence by payload', () => {
  assert.equal(requiresSpokenAnswer({ type: 'text' }), true, 'open = recorded answer');
  assert.equal(requiresSpokenAnswer({ type: 'mcq_single' }), false, 'choice questions stay as they are');
  assert.equal(requiresSpokenAnswer({ type: 'mcq_single', audio_required: true }), true, 'an explicit opt-in still works');
  assert.equal(requiresSpokenAnswer(null), false);

  assert.equal(hasSpokenEvidence({ audio_b64: 'QUJDRA==' }), true, 'a recording alone counts');
  assert.equal(hasSpokenEvidence({ transcript: 'spoken answer' }), true, 'a transcript alone counts');
  assert.equal(hasSpokenEvidence({ text: 'typed notes', transcript: '  ', audio_b64: '   ' }), false, 'whitespace is nothing');
  assert.equal(hasSpokenEvidence('a plain string answer'), false, 'typed-only strings carry no audio');

  // An audio-only answer is NOT blank: it must never be discarded as empty.
  assert.equal(openAnswerHasContent({ text: '', transcript: '', audio_b64: 'QUJDRA==' }), true);
  assert.equal(openAnswerHasContent({ text: 'notes only' }), true);
  assert.equal(openAnswerHasContent({ text: '', transcript: '', audio_b64: '' }), false);
});

test('a frozen paper whose oral rows lost every flag still pins first and demands audio', () => {
  // Worst-case legacy snapshot: every spoken row was edited through the
  // pre-fix admin UI, which stripped question_set/pin_first/audio_required —
  // and the paper even holds a label-less duplicate of the common question.
  // The published catalogue is the contract, so serving restores it.
  const pinPrompt = 'COMMON QUESTION — In simple terms, what problem does Databricks solve for an enterprise, and what is the role of an RSA in helping the client solve that problem?';
  const questions = [
    { id: 'pin', order: 0, type: 'text', prompt: pinPrompt },
    { id: 'twin', order: 0, type: 'text', prompt: pinPrompt.replace(/^COMMON QUESTION —\s*/, '') },
    { id: 'oral-2', order: 1, type: 'text', prompt: 'A client says, “We already have a data warehouse and Spark environment. Why do we need Databricks?” How would you answer?' },
    { id: 'std', order: 2, type: 'text', prompt: 'Unrelated standard open question.' },
  ];
  const qs = sortedQuestions({ questions });
  assert.equal(qs.length, 3, 'the duplicate twin collapses');
  assert.equal(qs[0].id, 'pin', 'the common question is pinned first again');
  assert.equal(qs[0].pin_first, true);
  assert.equal(qs[0].question_set, 'rsa-oral');
  assert.equal(qs[0].audio_required, true, 'the microphone requirement is restored');
  assert.equal(qs[0].prompt, pinPrompt.replace(/^COMMON QUESTION —\s*/, ''), 'the retired label is dropped from the served wording');
  const second = qs.find((q) => q.id === 'oral-2');
  assert.equal(second.question_set, 'rsa-oral');
  assert.equal(second.audio_required, true, 'every spoken prompt gets the mic back');
  const std = qs.find((q) => q.id === 'std');
  assert.equal(std.question_set, undefined, 'a standard question keeps its own set');
  // ...but it still demands the microphone: the open-question contract is a rule
  // of the type, applied to every served row.
  assert.equal(std.audio_required, true);
});
