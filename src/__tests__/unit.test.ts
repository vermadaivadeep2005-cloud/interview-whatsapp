import { classifyLocally } from '../classifier';
import { validateTag } from '../tag-validator';

describe('Unit Tests — System Components', () => {
  
  describe('Local Keyword Classifier', () => {
    
    test('detects positive change sentiment for Anchor 1', () => {
      const result = classifyLocally('Yes, I got a promotion and an income increase!', 'anchor_1');
      expect(result.sentiment).toBe('positive');
      expect(result.economic_outcome).toBe('income_increase');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('detects negative sentiment for Anchor 1', () => {
      const result = classifyLocally('No, nothing has changed at all in my role.', 'anchor_1');
      expect(result.sentiment).toBe('negative');
      expect(result.economic_outcome).toBe('no_change');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('detects mixed sentiment when there are positive changes but barriers', () => {
      const result = classifyLocally('I got a new role but my employer has not increased my salary yet.', 'anchor_1');
      expect(result.sentiment).toBe('mixed');
      expect(result.economic_outcome).toBe('improved_current_role_only');
      expect(result.confidence).toBeLessThan(0.85);
    });

    test('detects bottleneck categories for Anchor 2', () => {
      const result = classifyLocally('My employer will not approve the purchase of tools like laptops.', 'anchor_2');
      expect(result.bottleneck_types).toContain('bottleneck_employer_buyin');
      expect(result.bottleneck_types).toContain('bottleneck_tooling_access');
    });

    test('detects benefit mechanisms for Anchor 3', () => {
      const result = classifyLocally('It made me much faster and more efficient in my daily workflow.', 'anchor_3');
      expect(result.benefit_mechanism).toBe('efficiency_in_current_role');
    });

    test('penalizes confidence for vague answers', () => {
      const result = classifyLocally('Maybe I think it sort of helped kind of', 'anchor_1');
      expect(result.confidence).toBeLessThan(0.75);
    });

    test('fails classification for very short answers', () => {
      const result = classifyLocally('ok thanks', 'anchor_1');
      expect(result.confidence).toBe(0.3);
      expect(result.call_reason).toBe('answer_too_short_for_local_classification');
    });

  });

  describe('Response Tag Validator', () => {

    test('accepts valid tags', () => {
      const tag = {
        question_id: 'anchor_1',
        raw_response: 'Yes, it changed my salary.',
        economic_outcome: 'income_increase',
        bottleneck_types: ['bottleneck_none_reported'],
        benefit_mechanism: 'new_income_stream',
        sentiment: 'positive',
        confidence_in_tagging: 0.9,
        turn_id: '6e584d4d-521c-4310-b042-8a4cedd887b4',
      };
      const result = validateTag(tag);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('rejects tag with invalid question_id', () => {
      const tag = {
        question_id: 'invalid_question',
        raw_response: 'Yes',
        sentiment: 'positive',
        confidence_in_tagging: 0.9,
        turn_id: null,
      };
      const result = validateTag(tag);
      expect(result.valid).toBe(false);
      expect(result.errors.join('')).toContain('invalid_question');
    });

    test('rejects tag with confidence out of bounds', () => {
      const tag = {
        question_id: 'anchor_1',
        raw_response: 'Yes',
        sentiment: 'positive',
        confidence_in_tagging: 1.5,
        turn_id: null,
      };
      const result = validateTag(tag);
      expect(result.valid).toBe(false);
      expect(result.errors.join('')).toContain('between 0.0 and 1.0');
    });

    test('rejects tag with invalid bottleneck enums', () => {
      const tag = {
        question_id: 'anchor_2',
        raw_response: 'Barrier',
        sentiment: 'negative',
        confidence_in_tagging: 0.85,
        bottleneck_types: ['invalid_bottleneck_value'],
        turn_id: null,
      };
      const result = validateTag(tag);
      expect(result.valid).toBe(false);
      expect(result.errors.join('')).toContain('invalid_bottleneck_value');
    });

  });

});
