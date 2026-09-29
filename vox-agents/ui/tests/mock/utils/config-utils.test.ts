import { describe, expect, it } from 'vitest';
import { isSynthesizableModelId, validateMappings } from '@/utils/config-utils';

describe('configuration model validation', () => {
  it.each([
    'openai/gpt-5',
    'openrouter/vendor/model',
    'openai-compatible/local-model',
    'codex/gpt-5-codex'
  ])('accepts a provider-qualified model ID that can be synthesized: %s', modelId => {
    expect(isSynthesizableModelId(modelId)).toBe(true);
    expect(validateMappings([{ agent: 'default', model: modelId }], [])).toEqual([]);
  });

  it('still reports a garbage model mapping when no definition exists', () => {
    expect(validateMappings([{ agent: 'default', model: 'garbage' }], []))
      .toEqual(['Model "garbage" used by agent "default" does not exist']);
  });
});
