/**
 * Local polarity and answer-quality classifier.
 * Runs before Gemini to avoid API calls for obvious/high-confidence answers.
 * Returns a classification with confidence — if confidence >= MIN_CONFIDENCE threshold,
 * Gemini is skipped entirely.
 */

export interface LocalClassification {
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  economic_outcome: 'income_increase' | 'role_change_no_pay_change' | 'improved_current_role_only' | 'no_change' | 'too_early_to_tell' | null;
  bottleneck_types: string[] | null;
  benefit_mechanism: 'efficiency_in_current_role' | 'new_income_stream' | 'internal_mobility' | 'external_mobility' | 'credibility_signal' | 'not_applicable' | null;
  confidence: number; // 0.0 – 1.0
  call_reason: string; // why Gemini was/wasn't called
}

// Keyword sets
const POSITIVE_SIGNALS = /\b(yes|changed|change|promoted|promotion|raise|hired|income|money|improved|growth|new client|new role|better|earned|earning|landed|got the job|fayda|faida|badla|nokri|kamai|haan|improved|benefit|opportunity|salary|increased)\b/i;
const NEGATIVE_SIGNALS = /\b(no|nothing|not yet|haven't|didn't|couldn't|struggle|barrier|difficult|hard|blocked|still waiting|no change|nahi|abhi nahi|nope|same as before|no difference)\b/i;
const BARRIER_SIGNALS  = /\b(but|however|though|except|although|still|yet|barrier|difficult|hard|struggle|employer|confidence|tools|access|opportunity|nahi|par|lekin|management|permission)\b/i;
const VAGUE_SIGNALS    = /\b(maybe|kind of|sort of|a bit|somewhat|not sure|unclear|I think|possibly|could be)\b/i;
const EFFICIENCY_SIGNALS = /\b(faster|efficient|better at my job|current role|same job|workflow|productivity|automate|time saving)\b/i;
const NEW_INCOME_SIGNALS  = /\b(new client|freelance|side income|new project|consulting|extra income|additional income)\b/i;
const MOBILITY_SIGNALS    = /\b(promotion|promoted|new role|moved up|transferred|internal move|new position)\b/i;

/**
 * Classifies a respondent's answer locally without calling any external API.
 * Used to gate Gemini calls: only call Gemini if confidence < MIN_CONFIDENCE.
 */
export function classifyLocally(
  input: string,
  questionId: string
): LocalClassification {
  const text = input.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Very short or empty answers — low confidence, send to Gemini
  if (wordCount < 5) {
    return {
      sentiment: 'neutral',
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      confidence: 0.3,
      call_reason: 'answer_too_short_for_local_classification',
    };
  }

  let hasPositive = POSITIVE_SIGNALS.test(text);
  const hasNegative = NEGATIVE_SIGNALS.test(text);
  const hasBarrier  = BARRIER_SIGNALS.test(text);
  const isVague     = VAGUE_SIGNALS.test(text);

  // Strong negations override positive keyword matches (e.g. "nothing has changed")
  if (/\b(no change|nothing has changed|nothing changed|not changed|no difference|same as before)\b/i.test(text)) {
    hasPositive = false;
  }

  const isMixed     = hasPositive && (hasNegative || hasBarrier);

  // Determine sentiment
  let sentiment: LocalClassification['sentiment'] = 'neutral';
  if (isMixed)           sentiment = 'mixed';
  else if (hasPositive)  sentiment = 'positive';
  else if (hasNegative)  sentiment = 'negative';

  // Vague answers → lower confidence
  const vaguenessPenalty = isVague ? 0.2 : 0.0;
  const mixedPenalty     = isMixed ? 0.1 : 0.0;
  const baseConfidence   = 0.85 - vaguenessPenalty - mixedPenalty;

  // Question-specific tagging
  let economic_outcome: LocalClassification['economic_outcome'] = null;
  let bottleneck_types: string[] | null = null;
  let benefit_mechanism: LocalClassification['benefit_mechanism'] = null;

  if (questionId === 'anchor_1' || questionId === 'anchor_1_probe') {
    if (isMixed) {
      economic_outcome = 'improved_current_role_only';
    } else if (hasPositive && !hasNegative) {
      economic_outcome = 'income_increase';
    } else if (!hasPositive && hasNegative) {
      economic_outcome = 'no_change';
    } else {
      economic_outcome = 'too_early_to_tell';
    }
  }

  if (questionId === 'anchor_2' || questionId === 'anchor_2_probe') {
    const detected: string[] = [];
    if (/\b(opportunity|chance|no opportunity|no openings)\b/i.test(text))          detected.push('bottleneck_opportunity');
    if (/\b(employer|management|boss|company|buy.?in|approval)\b/i.test(text))      detected.push('bottleneck_employer_buyin');
    if (/\b(confidence|fear|scared|not sure|imposter)\b/i.test(text))               detected.push('bottleneck_confidence');
    if (/\b(tools|software|hardware|access|license|subscription|laptop)\b/i.test(text)) detected.push('bottleneck_tooling_access');
    if (/\b(skill|gap|training|learn|knowledge)\b/i.test(text))                     detected.push('bottleneck_skill_gap');
    if (/\b(market|economy|demand|clients|no clients|no market)\b/i.test(text))     detected.push('bottleneck_market');
    bottleneck_types = detected.length > 0 ? detected : ['bottleneck_none_reported'];
  }

  if (questionId === 'anchor_3' || questionId === 'anchor_3_probe') {
    if (EFFICIENCY_SIGNALS.test(text))   benefit_mechanism = 'efficiency_in_current_role';
    else if (NEW_INCOME_SIGNALS.test(text)) benefit_mechanism = 'new_income_stream';
    else if (MOBILITY_SIGNALS.test(text))   benefit_mechanism = 'internal_mobility';
    else if (hasPositive)                    benefit_mechanism = 'credibility_signal';
    else                                     benefit_mechanism = 'not_applicable';
  }

  const finalConfidence = Math.max(0.1, Math.min(1.0, baseConfidence));

  return {
    sentiment,
    economic_outcome,
    bottleneck_types,
    benefit_mechanism,
    confidence: parseFloat(finalConfidence.toFixed(2)),
    call_reason: finalConfidence >= 0.7 ? 'local_classifier_confident' : 'low_confidence_needs_gemini',
  };
}
