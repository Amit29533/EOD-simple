import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortedQuestions, budgetsFor, remainingMs, ensureQuizState, integrityPatch, isOpenQuestion,
} from '../src/api/quiz-session.mjs';
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
