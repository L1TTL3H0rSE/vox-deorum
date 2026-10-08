/** Synthetic Decisions responses exercising the strict text-only contract mapping. */
import { describe, expect, it } from 'vitest';
import { experimental_evaluate } from 'ai';
import { fromDecisionsResponse, toDecisionsQuestions } from '../../../src/utils/models/providers/openai-decisions-contract.js';

const questions = {
  flag: { type: 'boolean' as const, instructions: { asks: 'Flag?' }, criteria: { true: 'present', false: 'absent' } },
  pick: { type: 'choice' as const, instructions: 'Pick?', criteria: { 'true': 'string true', other: null } },
  score: { type: 'score' as const, instructions: 'Score?', criteria: ['low', { level: 'middle' }, null] },
};
const request = toDecisionsQuestions(questions);

/** Return a fresh, entirely synthetic multi-question API response. */
function response() {
  return {
    model: 'gpt-6-luna',
    answers: [
      { name: 'flag', type: 'predicate', probability: 0.7 },
      { name: 'pick', type: 'choice', choice: 'true', confidence: 0.4,
        probabilities: [{ value: 'true', probability: 0.8 }, { value: 'other', probability: 0.2 }] },
      { name: 'score', type: 'score', score: 1.1, confidence: 0.55,
        probabilities: [{ value: 0, label: '0', probability: 0.1 }, { value: 1, label: '1', probability: 0.7 }, { value: 2, label: '2', probability: 0.2 }] },
    ],
  };
}

describe('Decisions question mapping', () => {
  it('should preserve names, typed string choices, structured descriptions, and ordered levels', () => {
    expect(request).toEqual([
      { name: 'flag', type: 'predicate', instructions: '{"asks":"Flag?"}\ntrue: present\nfalse: absent' },
      { name: 'pick', type: 'choice', instructions: 'Pick?', choices: [{ value: 'true', description: 'string true' }, { value: 'other' }] },
      { name: 'score', type: 'score', instructions: 'Score?', levels: [{ label: '0', description: 'low' }, { label: '1', description: '{"level":"middle"}' }, { label: '2' }] },
    ]);
  });

  it('should reject empty questions, choices, and a one-level score', () => {
    expect(() => toDecisionsQuestions({})).toThrow();
    expect(() => toDecisionsQuestions({ q: { type: 'choice', instructions: '', criteria: {} } })).toThrow();
    expect(() => toDecisionsQuestions({ q: { type: 'score', instructions: '', criteria: [null] } })).toThrow();
  });
});

describe('Decisions answer mapping', () => {
  it('should pass real experimental_evaluate validation without rounding or normalizing', async () => {
    const raw = response();
    const mapped = fromDecisionsResponse(request, raw);
    const result = await experimental_evaluate({
      model: { specificationVersion: 'v4', provider: 'synthetic', modelId: 'test', supportedQuestionTypes: ['choice', 'score', 'boolean'],
        doEvaluate: async () => ({ answers: mapped.answers, warnings: [] }) },
      state: 'synthetic', questions,
    });
    expect(result.answers).toEqual({
      flag: { type: 'boolean', probability: 0.7 },
      pick: { type: 'choice', choice: 'true', probabilities: { true: 0.8, other: 0.2 } },
      score: { type: 'score', score: 1.1, probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 } },
    });
    expect(mapped.confidence).toEqual({ pick: 0.4, score: 0.55 });
    expect(raw).toEqual(response());
  });

  it.each([0, 1])('should preserve predicate boundary %s', probability => {
    const raw = response(); raw.answers[0].probability = probability;
    expect(fromDecisionsResponse(request, raw).answers.flag).toEqual({ type: 'boolean', probability });
  });

  it.each([0, 2])('should preserve score boundary %s', score => {
    const raw = response(); raw.answers[2].score = score;
    raw.answers[2].probabilities = [0, 1, 2].map(value => ({ value, label: String(value), probability: value === score ? 1 : 0 }));
    expect(fromDecisionsResponse(request, raw).answers.score).toMatchObject({ score });
  });

  it('should allow floating point noise within 1e-6 without changing the provider score', () => {
    const raw = response(); raw.answers[2].score = 1.1000005;
    expect(fromDecisionsResponse(request, raw).answers.score).toMatchObject({ score: 1.1000005 });
  });

  it('should reject a single refusal with its question identity', () => {
    const raw = response();
    const refused = { ...raw, answers: [raw.answers[0], { name: 'pick', type: 'refusal' }, raw.answers[2]] };
    expect(() => fromDecisionsResponse(request, refused)).toThrow(/refusal.*pick/);
  });

  it.each([
    ['missing', (raw: ReturnType<typeof response>) => raw.answers.pop()],
    ['extra', raw => raw.answers.push(raw.answers[0])],
    ['reordered', raw => raw.answers.reverse()],
    ['duplicate names', raw => { raw.answers[1].name = 'flag'; }],
    ['unknown name', raw => { raw.answers[0].name = 'unknown'; }],
    ['wrong type', raw => { raw.answers[0].type = 'score'; }],
    ['unknown choice', raw => { raw.answers[1].choice = 'absent'; }],
    ['nonmaximal choice', raw => { raw.answers[1].choice = 'other'; }],
    ['missing distribution item', raw => raw.answers[1].probabilities?.pop()],
    ['duplicate distribution item', raw => { raw.answers[1].probabilities = [{ value: 'true', probability: 0.5 }, { value: 'true', probability: 0.5 }]; }],
    ['incorrect sum', raw => { raw.answers[1].probabilities = [{ value: 'true', probability: 0.2 }, { value: 'other', probability: 0.2 }]; }],
    ['wrong level label', raw => { raw.answers[2].probabilities = [{ value: 0, label: 'wrong', probability: 1 }, { value: 1, label: '1', probability: 0 }, { value: 2, label: '2', probability: 0 }]; }],
    ['out of range score', raw => { raw.answers[2].score = 3; }],
    ['contradictory score', raw => { raw.answers[2].score = 1.2; }],
    ['negative probability', raw => { raw.answers[0].probability = -0.1; }],
    ['large probability', raw => { raw.answers[0].probability = 1.1; }],
    ['NaN', raw => { raw.answers[0].probability = NaN; }],
    ['infinity', raw => { raw.answers[2].score = Infinity; }],
    ['invalid confidence', raw => { raw.answers[1].confidence = 2; }],
  ] satisfies [string, (raw: ReturnType<typeof response>) => unknown][])('should reject %s', (_name, mutate) => {
    const raw = response(); mutate(raw);
    expect(() => fromDecisionsResponse(request, raw)).toThrow(/invalid-response/);
  });

  it.each([true, false, 1, null])('should not coerce typed choice %s to a string', value => {
    const raw = response();
    expect(() => fromDecisionsResponse(request, { ...raw, answers: [raw.answers[0], { ...raw.answers[1], choice: value }, raw.answers[2]] })).toThrow();
  });

  it('should not coerce a boolean distribution key to its string spelling', () => {
    const raw = response();
    expect(() => fromDecisionsResponse(request, { ...raw, answers: [raw.answers[0], { ...raw.answers[1], probabilities: [{ value: true, probability: 0.8 }, { value: 'other', probability: 0.2 }] }, raw.answers[2]] })).toThrow();
  });

  it.each([
    [{ value: 'unknown', probability: 1 }, { value: 'other', probability: 0 }],
    [{ value: 'true', probability: '0.8' }, { value: 'other', probability: 0.2 }],
    [{ value: 'true', probability: NaN }, { value: 'other', probability: 0.2 }],
  ])('should reject unknown or nonnumeric choice probabilities', (...probabilities) => {
    const raw = response();
    expect(() => fromDecisionsResponse(request, { ...raw, answers: [raw.answers[0], { ...raw.answers[1], probabilities }, raw.answers[2]] })).toThrow();
  });

  it.each([-1, 0.5, 3, '0', NaN])('should reject invalid score level %s', value => {
    const raw = response();
    const score = { ...raw.answers[2], probabilities: [{ value, label: '0', probability: 0.1 }, { value: 1, label: '1', probability: 0.7 }, { value: 2, label: '2', probability: 0.2 }] };
    expect(() => fromDecisionsResponse(request, { ...raw, answers: [raw.answers[0], raw.answers[1], score] })).toThrow();
  });
});
