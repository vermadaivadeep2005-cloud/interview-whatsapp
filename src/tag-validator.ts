/**
 * Response Tag Validator.
 * Validates every tag object before it is written to the response_tags table.
 * Throws a descriptive error if any field is invalid — never allows malformed
 * Gemini/classifier output to enter the database.
 */

const VALID_QUESTION_IDS = new Set([
  'anchor_1', 'anchor_1_probe',
  'anchor_2', 'anchor_2_probe',
  'anchor_3', 'anchor_3_probe',
  'anchor_4', 'anchor_4_probe',
  'catch_all', 'wrap_up',
]);

const VALID_SENTIMENTS = new Set(['positive', 'negative', 'neutral', 'mixed']);

const VALID_ECONOMIC_OUTCOMES = new Set([
  'income_increase', 'role_change_no_pay_change',
  'improved_current_role_only', 'no_change', 'too_early_to_tell',
]);

const VALID_BOTTLENECK_TYPES = new Set([
  'bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence',
  'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market',
  'bottleneck_none_reported',
]);

const VALID_BENEFIT_MECHANISMS = new Set([
  'efficiency_in_current_role', 'new_income_stream', 'internal_mobility',
  'external_mobility', 'credibility_signal', 'not_applicable',
]);

export interface TagInput {
  question_id: string;
  raw_response: string;
  economic_outcome?: string | null;
  bottleneck_types?: string[] | null;
  benefit_mechanism?: string | null;
  sentiment: string;
  confidence_in_tagging: number;
  transcription_confidence?: number | null;
  quotable_snippet?: string | null;
  turn_id: string | null;
  metadata?: any;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a tag object. Returns {valid: true, errors: []} on success,
 * or {valid: false, errors: [...]} with descriptive messages on failure.
 */
export function validateTag(tag: TagInput): ValidationResult {
  const errors: string[] = [];

  // question_id
  if (!tag.question_id || !VALID_QUESTION_IDS.has(tag.question_id)) {
    errors.push(`Invalid question_id: "${tag.question_id}". Must be one of: ${[...VALID_QUESTION_IDS].join(', ')}`);
  }

  // raw_response
  if (!tag.raw_response || typeof tag.raw_response !== 'string' || tag.raw_response.trim().length === 0) {
    errors.push('raw_response must be a non-empty string');
  }

  // sentiment
  if (!tag.sentiment || !VALID_SENTIMENTS.has(tag.sentiment)) {
    errors.push(`Invalid sentiment: "${tag.sentiment}". Must be one of: ${[...VALID_SENTIMENTS].join(', ')}`);
  }

  // confidence_in_tagging
  if (typeof tag.confidence_in_tagging !== 'number' || tag.confidence_in_tagging < 0 || tag.confidence_in_tagging > 1) {
    errors.push(`confidence_in_tagging must be a number between 0.0 and 1.0, got: ${tag.confidence_in_tagging}`);
  }

  // economic_outcome (optional)
  if (tag.economic_outcome !== null && tag.economic_outcome !== undefined) {
    if (!VALID_ECONOMIC_OUTCOMES.has(tag.economic_outcome)) {
      errors.push(`Invalid economic_outcome: "${tag.economic_outcome}". Must be one of: ${[...VALID_ECONOMIC_OUTCOMES].join(', ')}`);
    }
  }

  // bottleneck_types (optional array)
  if (tag.bottleneck_types !== null && tag.bottleneck_types !== undefined) {
    if (!Array.isArray(tag.bottleneck_types)) {
      errors.push('bottleneck_types must be an array or null');
    } else {
      for (const bt of tag.bottleneck_types) {
        if (!VALID_BOTTLENECK_TYPES.has(bt)) {
          errors.push(`Invalid bottleneck_type: "${bt}". Must be one of: ${[...VALID_BOTTLENECK_TYPES].join(', ')}`);
        }
      }
    }
  }

  // benefit_mechanism (optional)
  if (tag.benefit_mechanism !== null && tag.benefit_mechanism !== undefined) {
    if (!VALID_BENEFIT_MECHANISMS.has(tag.benefit_mechanism)) {
      errors.push(`Invalid benefit_mechanism: "${tag.benefit_mechanism}". Must be one of: ${[...VALID_BENEFIT_MECHANISMS].join(', ')}`);
    }
  }

  // transcription_confidence (optional)
  if (tag.transcription_confidence !== null && tag.transcription_confidence !== undefined) {
    if (typeof tag.transcription_confidence !== 'number' || tag.transcription_confidence < 0 || tag.transcription_confidence > 1) {
      errors.push(`transcription_confidence must be a number between 0.0 and 1.0, got: ${tag.transcription_confidence}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a tag and throws if invalid. Use this before every db.saveTag() call.
 */
export function assertValidTag(tag: TagInput, context: string = ''): void {
  const result = validateTag(tag);
  if (!result.valid) {
    const prefix = context ? `[${context}] ` : '';
    throw new Error(`${prefix}Tag validation failed:\n  - ${result.errors.join('\n  - ')}`);
  }
}
