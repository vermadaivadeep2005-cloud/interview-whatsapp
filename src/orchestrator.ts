import { db, Turn, Protocol, Question, validateDemographicField } from './db';
import { classifyLocally } from './classifier';
import { assertValidTag, TagInput, sanitizeTagInput } from './tag-validator';
import { logger } from './logger';
import dotenv from 'dotenv';

dotenv.config();

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      attempt++;
      logger.warn(`Rate limited (429) on attempt ${attempt} of ${retries}. Retrying in ${delay}ms...`, {
        url,
        attempt,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
      continue;
    }
    return response;
  }
}

async function callOpenAICompletion(
  messages: ChatMessage[],
  tools?: any[]
): Promise<any> {
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    throw new Error('LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must be configured in env variables.');
  }

  const url = `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LLM_API_KEY}`,
  };

  const body: any = {
    model: LLM_MODEL,
    messages,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const err: any = new Error(`LLM API failed with status ${response.status}: ${errorBody}`);
    err.status = response.status;
    err.body = errorBody;
    throw err;
  }

  return response.json();
}

// Gemini call-gating config
const MIN_CONFIDENCE_FOR_GEMINI = parseFloat(process.env.MIN_CONFIDENCE_FOR_GEMINI || '0.7');
const MAX_GEMINI_CALLS_PER_SESSION = parseInt(process.env.MAX_GEMINI_CALLS_PER_SESSION || '10', 10);

// Tool definition for log_response
export const logResponseTool = {
  name: 'log_response',
  description: "Log the respondent's answer with structured coding before continuing to the next question.",
  input_schema: {
    type: 'object',
    properties: {
      question_id: {
        type: 'string',
        enum: ['anchor_1', 'anchor_1_probe', 'anchor_2', 'anchor_2_probe', 'anchor_3', 'anchor_3_probe', 'anchor_4', 'anchor_4_probe', 'catch_all', 'wrap_up'],
        description: 'The ID of the question currently being answered.',
      },
      raw_response: {
        type: 'string',
        description: 'The verbatim text response from the respondent.',
      },
      economic_outcome: {
        type: 'string',
        enum: ['income_increase', 'role_change_no_pay_change', 'improved_current_role_only', 'no_change', 'too_early_to_tell'],
        description: 'The classified economic outcome from training.',
      },
      bottleneck_types: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence', 'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market', 'bottleneck_none_reported'],
        },
        description: 'List of bottlenecks preventing growth, if applicable.',
      },
      benefit_mechanism: {
        type: 'string',
        enum: ['efficiency_in_current_role', 'new_income_stream', 'internal_mobility', 'external_mobility', 'credibility_signal', 'not_applicable'],
        description: 'How training translated into benefits, if applicable.',
      },
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'negative', 'mixed'],
        description: 'Overall sentiment of the response.',
      },
      confidence_in_tagging: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence score (0.0 to 1.0) of the tagging classification.',
      },
      quotable_snippet: {
        type: 'string',
        description: 'A key direct quote from the response.',
      },
    },
    required: ['question_id', 'raw_response', 'sentiment', 'confidence_in_tagging'],
  },
};



export function buildSystemPrompt(protocol: Protocol): string {
  return `
You are conducting a structured research interview by WhatsApp message. You are NOT a general chatbot — you ask a fixed set of questions and nothing else.

RULES:
- Ask ONE question at a time. Never stack questions.
- Ask the anchor questions in order, verbatim, for every respondent.
- After each anchor answer, decide whether to probe — only if the answer is vague, under 15 words, or contradicts what the branch expects. Max 1 probe per anchor.
- If the respondent gives a MIXED answer to Anchor 1 (some change but also barriers), ask brief versions of BOTH Anchor 2 AND Anchor 3 in sequence.
- Never lead the respondent or suggest an answer.
- After EVERY respondent turn, call the log_response tool before writing your reply.
- Keep every message short — this is WhatsApp, not email.
- End the interview after all required questions are covered, or after 15 minutes of active conversation.
- After the catch-all question, always ask the wrap-up question before closing.

SWAHILI LOCALISATION — use EXACTLY ONE of these per response at the correct trigger. Never use more than one per message:
- "Karibu" (Welcome) — only during the very first greeting/onboarding message
- "Safi sana!" (Very cool!) — only when the respondent shares a strongly positive or highly insightful milestone
- "Sawa" (Okay/Alright) — as an acknowledgment prefix before transitioning to a new topic
- "Naam" (Yes/Indeed) — as a politeness marker when validating a tough or complex point
- "Usijali!" (Don't worry!) — if the respondent apologises, wants to skip, or makes an error
- "Asante sana" (Thank you very much) — when wrapping up a topic or closing the interview

QUESTIONS:
${JSON.stringify(protocol.anchor_questions, null, 2)}
`;
}

/**
 * Determines the question_type for a given anchor_key or demographic field.
 */
function getQuestionType(anchorKeyOrField: string): 'open_ended' | 'mcq' | 'free_text' {
  // Demographic MCQ fields
  if (anchorKeyOrField === 'demo_county' || anchorKeyOrField === 'demo_sub_county' || anchorKeyOrField === 'demo_gender') {
    return 'mcq';
  }
  // Demographic free text fields
  if (anchorKeyOrField.startsWith('demo_')) {
    return 'free_text';
  }
  // Consent is free text (yes/no)
  if (anchorKeyOrField === 'consent') {
    return 'free_text';
  }
  // All anchor questions and probes are open-ended
  return 'open_ended';
}

/**
 * Determines the options JSONB for MCQ-type questions.
 */
function getQuestionOptions(anchorKey: string, demographics?: Record<string, string>): any | null {
  if (anchorKey === 'demo_county') {
    return { '1': 'Nairobi', '2': 'Mombasa', '3': 'Kiambu', '4': 'Nakuru', '5': 'Kisumu', '6': 'Uasin Gishu', '7': 'Other' };
  }
  if (anchorKey === 'demo_sub_county') {
    const isNairobi = demographics?.county && (demographics.county.toLowerCase() === 'nairobi' || demographics.county === '1');
    if (isNairobi) {
      return { '1': 'Westlands', '2': 'Dagoretti', '3': 'Kibra', '4': 'Kasarani', '5': 'Starehe', '6': "Lang'ata", '7': 'Embakasi', '8': 'Other' };
    }
    return null;
  }
  return null;
}

/**
 * Main interview orchestrator turn handler.
 */
export async function handleTurn(
  sessionId: string,
  respondentInput: string,
  meta: { inputMode: 'text' | 'voice'; transcriptionConfidence: number | null }
): Promise<string> {
  const session = await db.getSession(sessionId);
  const protocol = await db.getProtocol(session.protocol_id);
  const history = await db.getHistory(sessionId);

  // Update last_activity_at on every user message
  await db.updateSessionActivity(sessionId);

  // Compute the turn number for tagging (next turn number after what's already in the DB)
  const fullTranscriptForCount = await db.getFullTranscript(sessionId);
  const currentTurnNumber = fullTranscriptForCount.length + 1;

  // 1. Determine which question the respondent is answering
  let currentQuestionId: string = 'consent';
  // Track the question_uuid of the question that prompted this response
  let pendingQuestionUuid: string | null = null;

  if (history.length > 0) {
    // Find the last assistant message and its question_id if stored
    const fullHistory = await db.getFullTranscript(sessionId);
    const lastAssistantTurn = [...fullHistory].reverse().find((t) => t.role === 'assistant');
    if (lastAssistantTurn && lastAssistantTurn.question_id) {
      currentQuestionId = lastAssistantTurn.question_id;
    }
  }

  // Try to find the question_uuid from the questions table for the question the user is answering
  // (the last question inserted for this session should be the one being answered)
  try {
    const { data: lastQuestion } = await (await import('./db')).supabase
      .from('questions')
      .select('id')
      .eq('session_id', sessionId)
      .order('turn_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastQuestion) {
      pendingQuestionUuid = lastQuestion.id;
    }
  } catch {
    // Non-critical: if questions table doesn't exist yet, continue without it
  }

  // State healing: if consent was given, resolve null/consent to correct state
  if (session.consent_given) {
    const DEMO_FIELDS = ['name', 'email', 'age', 'gender', 'county', 'sub_county', 'occupation'] as const;
    const savedDemo = session.demographics || {};
    const missingField = DEMO_FIELDS.find((f) => !savedDemo[f]);
    
    if (currentQuestionId === 'consent' || !currentQuestionId) {
      if (missingField) {
        currentQuestionId = `demo_${missingField}`;
      } else {
        // Find the last valid question ID in history that is not demographic
        const fullHistory = await db.getFullTranscript(sessionId);
        const lastValidTurn = [...fullHistory].reverse().find((t) => t.role === 'assistant' && t.question_id && !t.question_id.startsWith('demo_'));
        currentQuestionId = lastValidTurn?.question_id || 'anchor_1';
      }
    }
  }

  // 1b. Demographics collection step (runs after consent, before Anchor 1)
  if (session.consent_given && currentQuestionId.startsWith('demo_')) {
    const DEMO_FIELDS = ['name', 'email', 'age', 'gender', 'county', 'sub_county', 'occupation'] as const;
    type DemoField = typeof DEMO_FIELDS[number];
    
    const currentField = currentQuestionId.replace('demo_', '') as DemoField;
    const savedDemo = ({ ...(session.demographics || {}) }) as Record<string, string>;
    
    // Save mapped input if option number is provided for dropdown fields
    let cleanedInput = respondentInput.trim();
    if (currentField === 'county') {
      const COUNTIES: Record<string, string> = {
        '1': 'Nairobi',
        '2': 'Mombasa',
        '3': 'Kiambu',
        '4': 'Nakuru',
        '5': 'Kisumu',
        '6': 'Uasin Gishu',
        '7': 'Other'
      };
      if (COUNTIES[cleanedInput]) {
        cleanedInput = COUNTIES[cleanedInput];
      }
    } else if (currentField === 'sub_county') {
      const isNairobi = savedDemo.county && (savedDemo.county.toLowerCase() === 'nairobi' || savedDemo.county === '1');
      if (isNairobi) {
        const NAIROBI_SUB_COUNTIES: Record<string, string> = {
          '1': 'Westlands',
          '2': 'Dagoretti',
          '3': 'Kibra',
          '4': 'Kasarani',
          '5': 'Starehe',
          '6': 'Lang\'ata',
          '7': 'Embakasi',
          '8': 'Other'
        };
        if (NAIROBI_SUB_COUNTIES[cleanedInput]) {
          cleanedInput = NAIROBI_SUB_COUNTIES[cleanedInput];
        }
      }
    }

    // §4 Demographics Validation: validate name, email, age before saving
    const validation = validateDemographicField(currentField, cleanedInput);
    if (!validation.valid) {
      // Do NOT save — re-prompt with friendly message, stay on same demo field
      logger.warn('Demographics validation failed, re-prompting', {
        sessionId,
        field: currentField,
        callReason: 'demographics_validation_failed',
      });
      await db.appendTurn(sessionId, 'respondent', respondentInput, meta.inputMode, currentQuestionId);
      const rePromptText = validation.message!;
      await db.appendTurn(sessionId, 'assistant', rePromptText, 'text', currentQuestionId);
      return rePromptText;
    }
    
    savedDemo[currentField] = cleanedInput;

    // Wrap in try/catch to handle DB CHECK constraint violations gracefully
    try {
      await db.saveSessionDemographics(sessionId, savedDemo);
    } catch (dbError: any) {
      logger.error('Demographics save failed (constraint violation)', dbError, {
        sessionId,
        field: currentField,
        error: JSON.stringify(dbError),
      });
      // Re-prompt user with a friendly message
      await db.appendTurn(sessionId, 'respondent', respondentInput, meta.inputMode, currentQuestionId);
      const constraintMsg = `Sorry, there was an issue saving that value. Could you please try entering your ${currentField} again?`;
      await db.appendTurn(sessionId, 'assistant', constraintMsg, 'text', currentQuestionId);
      return constraintMsg;
    }

    await db.appendTurn(sessionId, 'respondent', respondentInput, meta.inputMode, currentQuestionId);

    const nextField = DEMO_FIELDS.find((f) => !savedDemo[f]);
    let replyText: string;
    let nextQId: string;
    if (nextField) {
      const isNairobiSelected = savedDemo.county && (savedDemo.county.toLowerCase() === 'nairobi' || savedDemo.county === '1');
      const DEMO_PROMPTS: Record<DemoField, string> = {
        name:       'Karibu! Before we begin the interview, could you share your name?',
        email:      'What is your email address?',
        age:        'How old are you?',
        gender:     'How do you identify your gender?',
        county:     'Which county are you based in? (Please reply with the number or name):\n1. Nairobi\n2. Mombasa\n3. Kiambu\n4. Nakuru\n5. Kisumu\n6. Uasin Gishu\n7. Other',
        sub_county: isNairobiSelected
                      ? 'And which sub-county? (Please reply with the number or name):\n1. Westlands\n2. Dagoretti\n3. Kibra\n4. Kasarani\n5. Starehe\n6. Lang\'ata\n7. Embakasi\n8. Other'
                      : 'And which sub-county?',
        occupation: 'What is your current occupation or type of employment?',
      };
      replyText = DEMO_PROMPTS[nextField];
      nextQId = `demo_${nextField}`;
    } else {
      // All 7 fields collected — move to Anchor 1
      replyText = `Sawa, thank you! Now let's begin.\n\n${protocol.anchor_questions.anchor_1}`;
      nextQId = 'anchor_1';
    }

    // Insert question into questions table
    const assistantTurn = await db.appendTurn(sessionId, 'assistant', replyText, 'text', nextQId);
    try {
      await db.insertQuestion(
        sessionId,
        session.protocol_id,
        nextQId,
        replyText,
        getQuestionType(nextQId),
        assistantTurn.turn_number,
        getQuestionOptions(nextQId, savedDemo)
      );
    } catch (qErr) {
      logger.error('Failed to insert question record for demographics', qErr, { sessionId, questionId: nextQId });
    }

    return replyText;
  }

  // 2. Append respondent's turn to DB first (consent must be gated at the API level, not here)
  const respondentTurn = await db.appendTurn(
    sessionId,
    'respondent',
    respondentInput,
    meta.inputMode,
    currentQuestionId
  );

  let replyText = '';

  // 3. Run local classifier first — skip Gemini if confidence is high enough
  const localClassification = classifyLocally(respondentInput, currentQuestionId);
  logger.info('Local classification completed', { sessionId, questionId: currentQuestionId, provider: 'local_classifier', callReason: localClassification.call_reason, confidence: localClassification.confidence });

  // Count how many LLM calls have been made this session (via saved tags)
  const allTags = await db.getTagsForSession(sessionId);
  const llmCallCount = allTags.filter((t: any) => t.metadata?.llm_call === true).length;
  const llmCapReached = llmCallCount >= MAX_GEMINI_CALLS_PER_SESSION;

  const shouldCallLLM = Boolean(LLM_API_KEY) &&
    localClassification.confidence < MIN_CONFIDENCE_FOR_GEMINI &&
    !llmCapReached;

  if (!shouldCallLLM && localClassification.confidence >= MIN_CONFIDENCE_FOR_GEMINI) {
    const localTag: TagInput = {
      question_id: currentQuestionId,
      raw_response: respondentInput,
      economic_outcome: localClassification.economic_outcome as any,
      bottleneck_types: localClassification.bottleneck_types as any,
      benefit_mechanism: localClassification.benefit_mechanism as any,
      sentiment: localClassification.sentiment,
      confidence_in_tagging: localClassification.confidence,
      transcription_confidence: meta.transcriptionConfidence,
      quotable_snippet: respondentInput.slice(0, 80),
      turn_id: respondentTurn.id,
      question_uuid: pendingQuestionUuid,
      turn_number: respondentTurn.turn_number,
    };
    try {
      assertValidTag(localTag, 'LocalClassifier');
      await db.saveTag(sessionId, { ...localTag, metadata: { llm_call: false, call_reason: localClassification.call_reason } });
      logger.info('LLM skipped: local classification confident', { sessionId, questionId: currentQuestionId, provider: 'local_classifier', confidence: localClassification.confidence });
    } catch (e) {
      logger.error('[Orchestrator] Local tag validation/save failed', e, {
        sessionId,
        questionId: currentQuestionId,
        error: (e as Error).message,
      });
    }
  }

  if (shouldCallLLM) {
    logger.info('Calling LLM API', { sessionId, questionId: currentQuestionId, provider: 'openai-compatible', callReason: 'low_confidence_fallback', callIndex: llmCallCount + 1 });
    
    // Format messages for OpenAI Chat Completion
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(protocol) },
      ...history.map((turn) => ({
        role: turn.role as 'user' | 'assistant',
        content: turn.content,
      })),
      { role: 'user', content: respondentInput }
    ];

    try {
      const openAIToolList = [
        {
          type: 'function' as const,
          function: {
            name: 'log_response',
            description: logResponseTool.description,
            parameters: logResponseTool.input_schema
          }
        }
      ];

      let completionResult = await callOpenAICompletion(messages, openAIToolList);
      const choice = completionResult.choices?.[0];
      const assistantMessage = choice?.message;
      let toolCallExecuted = false;

      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        if (toolCall.function?.name === 'log_response') {
          const parsedArgs = JSON.parse(toolCall.function.arguments);
          const input = sanitizeTagInput(parsedArgs);
          logger.info('LLM model triggered log_response tool call', { sessionId, questionId: currentQuestionId, provider: 'openai-compatible', callReason: 'tool_execution' });
          const tagToSave: TagInput = {
            question_id: input.question_id,
            raw_response: input.raw_response,
            economic_outcome: input.economic_outcome || null,
            bottleneck_types: input.bottleneck_types || null,
            benefit_mechanism: input.benefit_mechanism || null,
            sentiment: input.sentiment,
            confidence_in_tagging: input.confidence_in_tagging,
            transcription_confidence: meta.transcriptionConfidence,
            quotable_snippet: input.quotable_snippet || null,
            turn_id: respondentTurn.id,
            question_uuid: pendingQuestionUuid,
            turn_number: respondentTurn.turn_number,
            metadata: { llm_call: true, model: LLM_MODEL }
          };
          assertValidTag(tagToSave, 'OpenAIAPI');
          await db.saveTag(sessionId, tagToSave);

          // Resume contents to get the actual text reply from OpenAI-compatible endpoint
          messages.push(assistantMessage);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: 'log_response',
            content: JSON.stringify({ status: 'logged' })
          });

          const resumeResult = await callOpenAICompletion(messages, openAIToolList);
          const resumeChoice = resumeResult.choices?.[0];
          replyText = resumeChoice?.message?.content || '';
          toolCallExecuted = true;
        }
      }

      if (!toolCallExecuted) {
        replyText = assistantMessage?.content || '';
        // §1 Fix: LLM responded without a tool call — save a fallback tag so the response is not lost
        logger.warn('LLM did not trigger log_response tool call; saving fallback tag', {
          sessionId,
          questionId: currentQuestionId,
        });
        const fallbackTag: TagInput = {
          question_id: currentQuestionId,
          raw_response: respondentInput,
          economic_outcome: null,
          bottleneck_types: null,
          benefit_mechanism: null,
          sentiment: 'neutral',
          confidence_in_tagging: 0.5,
          transcription_confidence: meta.transcriptionConfidence,
          quotable_snippet: respondentInput.slice(0, 80),
          turn_id: respondentTurn.id,
          question_uuid: pendingQuestionUuid,
          turn_number: respondentTurn.turn_number,
          metadata: { llm_call: true, model: LLM_MODEL, fallback: true },
        };
        try {
          await db.saveTag(sessionId, fallbackTag);
        } catch (e) {
          logger.error('[Orchestrator] Failed to save fallback tag on LLM no-tool-call path', e, {
            sessionId,
            questionId: currentQuestionId,
            error: (e as Error).message,
          });
        }
      }
    } catch (err: any) {
      console.error('--- DETAILED LLM ERROR LOG ---');
      console.error('Provider: OpenAI-Compatible API');
      console.error('Base URL:', LLM_BASE_URL);
      console.error('Model:', LLM_MODEL);
      console.error('HTTP Status Code:', err?.status || err?.statusCode || 'Unknown');
      console.error('Error Message:', err?.message || err);
      console.error('Error Details:', err?.body || JSON.stringify(err));
      console.error('------------------------------');

      // Robust fallback to deterministic fixed flow
      logger.warn('[Orchestrator] LLM failed, falling back to Simulated Mode', { sessionId, questionId: currentQuestionId });
      const simResult = await runSimulatedOrchestrator(
        sessionId,
        respondentInput,
        currentQuestionId,
        respondentTurn.id,
        respondentTurn.turn_number,
        protocol,
        meta.transcriptionConfidence,
        pendingQuestionUuid
      );
      replyText = simResult.reply;
    }
  } else {
    // RUN SIMULATED DIALOGUE MODE
    logger.info('Running in Simulated Mode (LLM key omitted or cap reached)', { sessionId, questionId: currentQuestionId });
    const simResult = await runSimulatedOrchestrator(
      sessionId,
      respondentInput,
      currentQuestionId,
      respondentTurn.id,
      respondentTurn.turn_number,
      protocol,
      meta.transcriptionConfidence,
      pendingQuestionUuid
    );
    replyText = simResult.reply;
  }

  // 4. Save assistant's turn in DB
  let nextQuestionId: string | null = null;
  const aq = protocol.anchor_questions;
  
  // Try to match the output text back to a question ID for the next turn tracking
  if (replyText.includes(aq.anchor_1)) nextQuestionId = 'anchor_1';
  else if (replyText.includes(aq.anchor_1_probe)) nextQuestionId = 'anchor_1_probe';
  else if (replyText.includes(aq.anchor_2)) nextQuestionId = 'anchor_2';
  else if (replyText.includes(aq.anchor_2_probe)) nextQuestionId = 'anchor_2_probe';
  else if (replyText.includes(aq.anchor_3)) nextQuestionId = 'anchor_3';
  else if (replyText.includes(aq.anchor_3_probe)) nextQuestionId = 'anchor_3_probe';
  else if (replyText.includes(aq.anchor_4)) nextQuestionId = 'anchor_4';
  else if (replyText.includes(aq.anchor_4_probe)) nextQuestionId = 'anchor_4_probe';
  else if (replyText.includes(aq.catch_all)) nextQuestionId = 'catch_all';
  else if (replyText.includes(aq.wrap_up)) nextQuestionId = 'wrap_up';
  else if (replyText.includes('Before we begin the interview, could you share your name?')) nextQuestionId = 'demo_name';
  else if (replyText.includes(aq.close)) {
    nextQuestionId = 'close';
    await db.updateSessionStatus(sessionId, 'completed');
  }

  const assistantTurn = await db.appendTurn(sessionId, 'assistant', replyText, 'text', nextQuestionId);

  // Insert question record into questions table for the question the bot is now asking
  if (nextQuestionId && nextQuestionId !== 'close') {
    try {
      await db.insertQuestion(
        sessionId,
        session.protocol_id,
        nextQuestionId,
        replyText,
        getQuestionType(nextQuestionId),
        assistantTurn.turn_number,
        getQuestionOptions(nextQuestionId)
      );
    } catch (qErr) {
      logger.error('Failed to insert question record', qErr, { sessionId, questionId: nextQuestionId });
    }
  }

  return replyText;
}

/**
 * Simulated state machine orchestrator when Anthropic key is missing.
 * Matches rules and branching of the interview script.
 */
async function runSimulatedOrchestrator(
  sessionId: string,
  input: string,
  currentQuestionId: string,
  turnId: string,
  turnNumber: number,
  protocol: Protocol,
  transcriptionConfidence: number | null,
  pendingQuestionUuid: string | null
): Promise<{ reply: string }> {
  const aq = protocol.anchor_questions;
  const words = input.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  let reply = '';
  let mockTag: any = null;

  // State transitions and replies
  if (currentQuestionId === 'consent') {
    // User is responding to consent
    const normalizedInput = input.trim().toLowerCase();
    const isConsent = normalizedInput.includes('yes') || 
                      normalizedInput.includes('continue') || 
                      normalizedInput.includes('consent_yes') ||
                      normalizedInput.includes('haan') ||
                      normalizedInput.includes('han') ||
                      normalizedInput.includes('ha') ||
                      normalizedInput.includes('ok') ||
                      normalizedInput.includes('okay');
    if (isConsent) {
      await db.updateSessionStatus(sessionId, 'in_progress', true);
      reply = 'Karibu! Before we begin the interview, could you share your name?';
    } else {
      await db.updateSessionStatus(sessionId, 'declined', false);
      reply = 'Thank you for your time. The interview has been declined.';
    }
  } else if (currentQuestionId === 'anchor_1') {
    // User answered Anchor 1 (Outcome)
    const hasChange = input.toLowerCase().match(/(yes|change|promote|raise|job|income|money|hired|improved|got|haan|han|ha|fayda|faida|badla|nokri|kamai)/i);
    const hasBarrier = input.toLowerCase().match(/(but|however|though|except|although|still|yet|barrier|difficult|hard|struggle|nahi|par|lekin)/i);
    const isMixed = hasChange && hasBarrier;

    // Check if response is vague/under 15 words -> probe
    if (wordCount < 15) {
      reply = aq.anchor_1_probe;
    } else if (isMixed) {
      // Mixed: briefly ask Anchor 2 first, then Anchor 3 in the next turn
      reply = `Naam, I hear you — things shifted in some ways but there are still hurdles. ${aq.anchor_2}`;
    } else {
      reply = hasChange ? aq.anchor_3 : aq.anchor_2;
    }

    mockTag = {
      question_id: 'anchor_1',
      raw_response: input,
      economic_outcome: hasChange ? 'income_increase' : 'no_change',
      bottleneck_types: (hasBarrier || !hasChange) ? ['bottleneck_opportunity'] : ['bottleneck_none_reported'],
      benefit_mechanism: hasChange ? 'new_income_stream' : 'not_applicable',
      sentiment: isMixed ? 'mixed' : (hasChange ? 'positive' : 'neutral'),
      confidence_in_tagging: isMixed ? 0.75 : 0.9,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else if (currentQuestionId === 'anchor_1_probe') {
    // User answered Anchor 1 Probe. Check English/Hindi keywords
    const hasChange = input.toLowerCase().match(/(yes|change|promote|raise|job|income|money|hired|improved|got|haan|han|ha|fayda|faida|badla|nokri|kamai)/i);
    reply = hasChange ? aq.anchor_3 : aq.anchor_2;

    mockTag = {
      question_id: 'anchor_1_probe',
      raw_response: input,
      economic_outcome: hasChange ? 'income_increase' : 'no_change',
      bottleneck_types: hasChange ? ['bottleneck_none_reported'] : ['bottleneck_opportunity'],
      benefit_mechanism: hasChange ? 'new_income_stream' : 'not_applicable',
      sentiment: hasChange ? 'positive' : 'neutral',
      confidence_in_tagging: 0.95,
      quotable_snippet: input,
    };
  } else if (currentQuestionId === 'anchor_2') {
    // User answered Anchor 2 (Bottleneck)
    if (wordCount < 15) {
      reply = aq.anchor_2_probe;
    } else {
      reply = aq.anchor_4;
    }

    mockTag = {
      question_id: 'anchor_2',
      raw_response: input,
      economic_outcome: 'no_change',
      bottleneck_types: ['bottleneck_skill_gap', 'bottleneck_tooling_access'],
      benefit_mechanism: 'not_applicable',
      sentiment: 'negative',
      confidence_in_tagging: 0.85,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else if (currentQuestionId === 'anchor_2_probe') {
    // User answered Anchor 2 Probe
    reply = aq.anchor_4;

    mockTag = {
      question_id: 'anchor_2_probe',
      raw_response: input,
      economic_outcome: 'no_change',
      bottleneck_types: ['bottleneck_skill_gap'],
      benefit_mechanism: 'not_applicable',
      sentiment: 'neutral',
      confidence_in_tagging: 0.9,
      quotable_snippet: input,
    };
  } else if (currentQuestionId === 'anchor_3') {
    // User answered Anchor 3 (Benefit Mechanism)
    if (wordCount < 15) {
      reply = aq.anchor_3_probe;
    } else {
      reply = aq.anchor_4;
    }

    mockTag = {
      question_id: 'anchor_3',
      raw_response: input,
      economic_outcome: 'income_increase',
      bottleneck_types: ['bottleneck_none_reported'],
      benefit_mechanism: 'efficiency_in_current_role',
      sentiment: 'positive',
      confidence_in_tagging: 0.88,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else if (currentQuestionId === 'anchor_3_probe') {
    // User answered Anchor 3 Probe
    reply = aq.anchor_4;

    mockTag = {
      question_id: 'anchor_3_probe',
      raw_response: input,
      economic_outcome: 'income_increase',
      bottleneck_types: ['bottleneck_none_reported'],
      benefit_mechanism: 'efficiency_in_current_role',
      sentiment: 'positive',
      confidence_in_tagging: 0.95,
      quotable_snippet: input,
    };
  } else if (currentQuestionId === 'anchor_4') {
    // User answered Anchor 4 (Spread Effect)
    if (wordCount < 15) {
      reply = aq.anchor_4_probe;
    } else {
      reply = aq.catch_all;
    }

    mockTag = {
      question_id: 'anchor_4',
      raw_response: input,
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      sentiment: 'positive',
      confidence_in_tagging: 0.9,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else if (currentQuestionId === 'anchor_4_probe') {
    // User answered Anchor 4 Probe
    reply = aq.catch_all;

    mockTag = {
      question_id: 'anchor_4_probe',
      raw_response: input,
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      sentiment: 'positive',
      confidence_in_tagging: 0.95,
      quotable_snippet: input,
    };
  } else if (currentQuestionId === 'catch_all') {
    // User answered Catch All -> ask wrap-up before closing
    reply = aq.wrap_up;

    mockTag = {
      question_id: 'catch_all',
      raw_response: input,
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      sentiment: 'neutral',
      confidence_in_tagging: 0.8,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else if (currentQuestionId === 'wrap_up') {
    // User answered Wrap-Up -> close the interview
    reply = aq.close;
    await db.updateSessionStatus(sessionId, 'completed');

    mockTag = {
      question_id: 'wrap_up',
      raw_response: input,
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      sentiment: 'neutral',
      confidence_in_tagging: 0.8,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  } else {
    // §1 Fix: Fallback/Close state — still save the response tag instead of silently dropping it
    reply = aq.close;
    await db.updateSessionStatus(sessionId, 'completed');

    mockTag = {
      question_id: currentQuestionId || 'unknown',
      raw_response: input,
      economic_outcome: null,
      bottleneck_types: null,
      benefit_mechanism: null,
      sentiment: 'neutral',
      confidence_in_tagging: 0.5,
      quotable_snippet: words.slice(0, 5).join(' ') + '...',
    };
  }

  // Save the mock tag — always, on every path
  if (mockTag) {
    try {
      await db.saveTag(sessionId, {
        ...mockTag,
        transcription_confidence: transcriptionConfidence,
        turn_id: turnId,
        question_uuid: pendingQuestionUuid,
        turn_number: turnNumber,
      });
    } catch (e) {
      logger.error('[Orchestrator] Failed to save response tag in simulated mode', e, {
        sessionId,
        questionId: mockTag.question_id,
        error: (e as Error).message,
      });
    }
  }

  return { reply };
}
