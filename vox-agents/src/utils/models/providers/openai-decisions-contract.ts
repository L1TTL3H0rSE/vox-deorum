/** Text-only mapping between the Decisions API and the AI SDK evaluation contract. */
import { z } from 'zod';
import type {
  Experimental_EvaluationModelV4Answer as Answer,
  Experimental_EvaluationModelV4CallOptions as CallOptions,
  Experimental_EvaluationModelV4Input as Input,
} from '@ai-sdk/provider';

/** Matches the AI SDK's absolute tolerance, without rescaling provider distributions. */
export const decisionsTolerance = 1e-6;

/** The supported text question subset of POST /v1/decisions. */
export type DecisionsQuestion = { name: string; instructions: string } & (
  | { type: 'predicate' }
  | { type: 'choice'; choices: { value: string; description?: string }[] }
  | { type: 'score'; levels: { label: string; description?: string }[] }
);

/** A non-retryable request, refusal, or response-contract failure. */
export class DecisionsContractError extends Error {
  /** Keep diagnostics limited to question identities, never request evidence or credentials. */
  constructor(readonly kind: 'invalid-request' | 'invalid-response' | 'refusal', readonly questionIds: string[]) {
    super(`OpenAI Decisions ${kind}${questionIds.length ? ` for questions: ${questionIds.join(', ')}` : ''}.`);
    this.name = 'DecisionsContractError';
  }
}

/** Render structured evaluation evidence as text, without claiming image/message support. */
export function decisionsText(input: Input): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

/** Give every question an explicit name and every ordered score level its index label. */
export function toDecisionsQuestions(questions: CallOptions['questions']): DecisionsQuestion[] {
  if (Object.keys(questions).length === 0) throw new DecisionsContractError('invalid-request', []);
  return Object.entries(questions).map(([name, question]) => {
    const instructions = decisionsText(question.instructions);
    if (question.type === 'boolean') {
      const descriptions = Object.entries(question.criteria ?? {})
        .flatMap(([key, value]) => value == null ? [] : [`${key}: ${decisionsText(value)}`]);
      return { name, type: 'predicate', instructions: [instructions, ...descriptions].join('\n') };
    }
    if (question.type === 'choice') {
      const choices = Object.entries(question.criteria).map(([value, description]) => ({
        value, ...(description == null ? {} : { description: decisionsText(description) }),
      }));
      if (!choices.length) throw new DecisionsContractError('invalid-request', [name]);
      return { name, type: 'choice', instructions, choices };
    }
    if (question.criteria.length < 2) throw new DecisionsContractError('invalid-request', [name]);
    return {
      name, type: 'score', instructions,
      levels: question.criteria.map((description, index) => ({
        label: String(index), ...(description == null ? {} : { description: decisionsText(description) }),
      })),
    };
  });
}

const probability = z.number().finite().min(0).max(1);
const named = { name: z.string() };
const answerSchema = z.discriminatedUnion('type', [
  z.object({ ...named, type: z.literal('predicate'), probability }),
  z.object({ ...named, type: z.literal('refusal') }),
  z.object({
    ...named, type: z.literal('choice'), choice: z.union([z.string(), z.boolean()]), confidence: probability,
    probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean()]), probability })),
  }),
  z.object({
    ...named, type: z.literal('score'), score: z.number().finite(), confidence: probability,
    probabilities: z.array(z.object({ value: z.number().int().nonnegative(), label: z.string(), probability })),
  }),
]);
const responseSchema = z.object({ model: z.string().min(1), answers: z.array(answerSchema) });

/** Require one finite probability per expected option, with no missing or duplicate entries. */
function validateDistribution(keys: string[], entries: { key: string; probability: number }[], id: string): Record<string, number> {
  if (entries.length !== keys.length || new Set(entries.map(entry => entry.key)).size !== keys.length
    || entries.some(entry => !keys.includes(entry.key))
    || Math.abs(entries.reduce((sum, entry) => sum + entry.probability, 0) - 1) > decisionsTolerance) {
    throw new DecisionsContractError('invalid-response', [id]);
  }
  return Object.fromEntries(entries.map(entry => [entry.key, entry.probability]));
}

/** Validate identity, order, types, and semantic consistency before exposing any answers. */
export function fromDecisionsResponse(questions: DecisionsQuestion[], raw: unknown) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new DecisionsContractError('invalid-response', questions.map(question => question.name));
  const response = parsed.data;
  if (response.answers.length !== questions.length
    || response.answers.some((answer, index) => answer.name !== questions[index].name)) {
    throw new DecisionsContractError('invalid-response', questions.map(question => question.name));
  }
  const refused = response.answers.filter(answer => answer.type === 'refusal').map(answer => answer.name);
  if (refused.length) throw new DecisionsContractError('refusal', refused);
  const answers: Record<string, Answer> = Object.create(null);
  const confidence: Record<string, number> = Object.create(null);
  for (const [index, question] of questions.entries()) {
    const answer = response.answers[index];
    const id = question.name;
    if (answer.type === 'predicate' && question.type === 'predicate') {
      answers[id] = { type: 'boolean', probability: answer.probability };
    } else if (answer.type === 'choice' && question.type === 'choice') {
      // Internal choice keys are strings. In particular, boolean true is not the key "true".
      if (typeof answer.choice !== 'string' || answer.probabilities.some(entry => typeof entry.value !== 'string')) {
        throw new DecisionsContractError('invalid-response', [id]);
      }
      const choice = answer.choice;
      const distribution = validateDistribution(question.choices.map(choice => choice.value),
        answer.probabilities.map(entry => ({ key: String(entry.value), probability: entry.probability })), id);
      if (!Object.hasOwn(distribution, choice)
        || Object.values(distribution).some(value => value > distribution[choice] + decisionsTolerance)) {
        throw new DecisionsContractError('invalid-response', [id]);
      }
      answers[id] = { type: 'choice', choice: answer.choice, probabilities: distribution };
      confidence[id] = answer.confidence;
    } else if (answer.type === 'score' && question.type === 'score') {
      if (answer.probabilities.some(entry => question.levels[entry.value]?.label !== entry.label)) {
        throw new DecisionsContractError('invalid-response', [id]);
      }
      const distribution = validateDistribution(question.levels.map((_, level) => String(level)),
        answer.probabilities.map(entry => ({ key: String(entry.value), probability: entry.probability })), id);
      const mean = Object.entries(distribution).reduce((sum, [level, value]) => sum + Number(level) * value, 0);
      if (answer.score < 0 || answer.score > question.levels.length - 1 || Math.abs(answer.score - mean) > decisionsTolerance) {
        throw new DecisionsContractError('invalid-response', [id]);
      }
      answers[id] = { type: 'score', score: answer.score, probabilities: distribution };
      confidence[id] = answer.confidence;
    } else {
      throw new DecisionsContractError('invalid-response', [id]);
    }
  }
  return { answers, confidence, model: response.model };
}
