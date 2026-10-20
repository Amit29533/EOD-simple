import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortedQuestions, budgetsFor } from '../src/api/quiz-session.mjs';

test('legacy two-minute open-answer directives match the current answer window without changing the saved paper', () => {
  const paper = { questions: [
    { id: 'open', type: 'text', prompt: 'Choose one control. In two minutes, explain its purpose.' },
    { id: 'objective', type: 'mcq_single', prompt: 'In two minutes, how many events occur at a rate of 3 per minute?' },
    { id: 'scenario', type: 'text', prompt: 'An outage lasts two minutes. Explain the impact.' },
  ] };
  const original = structuredClone(paper);
  const questions = sortedQuestions(paper);
  assert.equal(questions.find((q) => q.id === 'open').prompt, 'Choose one control. In 60 seconds, explain its purpose.');
  assert.equal(budgetsFor(questions[0]).answer_ms, 60_000);
  assert.equal(questions.find((q) => q.id === 'objective').prompt, original.questions[1].prompt);
  assert.equal(questions.find((q) => q.id === 'scenario').prompt, original.questions[2].prompt);
  assert.deepEqual(paper, original);
});
