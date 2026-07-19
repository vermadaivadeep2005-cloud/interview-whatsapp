import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { db, Turn, Protocol } from './db';
import dotenv from 'dotenv';

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_NAME = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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

// Gemini Tool definition (requires uppercase types)
export const geminiLogResponseTool = {
  name: 'log_response',
  description: "Log the respondent's answer with structured coding before continuing to the next question.",
  parameters: {
    type: 'OBJECT',
    properties: {
      question_id: {
        type: 'STRING',
        enum: ['anchor_1', 'anchor_1_probe', 'anchor_2', 'anchor_2_probe', 'anchor_3', 'anchor_3_probe', 'anchor_4', 'anchor_4_probe', 'catch_all', 'wrap_up'],
        description: 'The ID of the question currently being answered.',
      },
      raw_response: {
        type: 'STRING',
        description: 'The verbatim text response from the respondent.',
      },
      economic_outcome: {
        type: 'STRING',
        enum: ['income_increase', 'role_change_no_pay_change', 'improved_current_role_only', 'no_change', 'too_early_to_tell'],
        description: 'The classified economic outcome from training.',
      },
      bottleneck_types: {
        type: 'ARRAY',
        items: {
          type: 'STRING',
          enum: ['bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence', 'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market', 'bottleneck_none_reported'],
        },
        description: 'List of bottlenecks preventing growth, if applicable.',
      },
      benefit_mechanism: {
        type: 'STRING',
        enum: ['efficiency_in_current_role', 'new_income_stream', 'internal_mobility', 'external_mobility', 'credibility_signal', 'not_applicable'],
        description: 'How training translated into benefits, if applicable.',
      },
      sentiment: {
        type: 'STRING',
        enum: ['positive', 'neutral', 'negative', 'mixed'],
        description: 'Overall sentiment of the response.',
      },
      confidence_in_tagging: {
        type: 'NUMBER',
        description: 'Confidence score (0.0 to 1.0) of the tagging classification.',
      },
      quotable_snippet: {
        type: 'STRING',
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

  // 1. Determine which question the respondent is answering
  let currentQuestionId: string = 'consent';
  if (history.length > 0) {
    // Find the last assistant message and its question_id if stored
    const fullHistory = await db.getFullTranscript(sessionId);
    const lastAssistantTurn = [...fullHistory].reverse().find((t) => t.role === 'assistant');
    if (lastAssistantTurn && lastAssistantTurn.question_id) {
      currentQuestionId = lastAssistantTurn.question_id;
    }
  }

  // 1b. Demographics collection step (runs after consent, before Anchor 1)
  if (session.consent_given && currentQuestionId.startsWith('demo_')) {
    const DEMO_FIELDS = ['name', 'email', 'age', 'gender', 'county', 'sub_county', 'occupation'] as const;
    type DemoField = typeof DEMO_FIELDS[number];
    const DEMO_PROMPTS: Record<DemoField, string> = {
      name:       'Karibu! Before we begin the interview, could you share your name?',
      email:      'What is your email address?',
      age:        'How old are you?',
      gender:     'How do you identify your gender?',
      county:     'Which county are you based in?',
      sub_county: 'And which sub-county?',
      occupation: 'What is your current occupation or type of employment?',
    };
    const currentField = currentQuestionId.replace('demo_', '') as DemoField;
    const savedDemo = ({ ...(session.demographics || {}) }) as Record<string, string>;
    savedDemo[currentField] = respondentInput.trim();
    await db.saveSessionDemographics(sessionId, savedDemo);
    await db.appendTurn(sessionId, 'respondent', respondentInput, meta.inputMode, currentQuestionId);

    const nextField = DEMO_FIELDS.find((f) => !savedDemo[f]);
    let replyText: string;
    let nextQId: string;
    if (nextField) {
      replyText = DEMO_PROMPTS[nextField];
      nextQId = `demo_${nextField}`;
    } else {
      // All 7 fields collected — move to Anchor 1
      replyText = `Sawa, thank you! Now let's begin.\n\n${protocol.anchor_questions.anchor_1}`;
      nextQId = 'anchor_1';
    }
    await db.appendTurn(sessionId, 'assistant', replyText, 'text', nextQId);
    await db.updateSessionActivity(sessionId);
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

  // 3. Check if we should use the Live Gemini API, Claude API, or run in Simulated Mode
  if (ai) {
    console.log(`[Orchestrator] Calling Gemini API (${GEMINI_MODEL}) for session ${sessionId}...`);
    // Format history for Gemini contents array
    const contents = history.map((turn) => ({
      role: (turn.role as string) === 'respondent' ? 'user' : 'model',
      parts: [{ text: turn.content }],
    }));
    // Add current input
    contents.push({
      role: 'user',
      parts: [{ text: respondentInput }],
    });

    try {
      let response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: contents as any,
        config: {
          systemInstruction: buildSystemPrompt(protocol),
          tools: [{ functionDeclarations: [geminiLogResponseTool as any] }],
        },
      });

      // Handle tool call
      if (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        if (call.name === 'log_response') {
          const input = call.args as any;
          console.log(`[Orchestrator] Save Tag via Gemini:`, input);
          await db.saveTag(sessionId, {
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
          });

          // Resume contents to get the actual text reply from Gemini
          contents.push(response.candidates?.[0]?.content as any); // model's functionCall turn
          contents.push({
            role: 'user',
            parts: [{
              text: JSON.stringify({ functionResponse: { name: 'log_response', response: { status: 'logged' } } })
            }]
          });

          const resumeResponse = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents as any,
            config: {
              systemInstruction: buildSystemPrompt(protocol),
              tools: [{ functionDeclarations: [geminiLogResponseTool as any] }],
            },
          });
          response = resumeResponse;
        }
      }

      replyText = response.text || '';
    } catch (err) {
      console.error('Error calling Gemini API:', err);
      replyText = "Sorry, I encountered an error processing your request. Please try again.";
    }
  } else if (anthropic) {
    console.log(`[Orchestrator] Calling Claude API for session ${sessionId}...`);
    // Format history for Claude messages array
    const messages = [...history, { role: 'user' as const, content: respondentInput }];

    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 500,
      system: buildSystemPrompt(protocol),
      tools: [logResponseTool as any],
      messages: messages,
    });

    // Handle tool use blocks in the output
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'log_response') {
        const input = block.input as any;
        console.log(`[Orchestrator] Save Tag:`, input);
        await db.saveTag(sessionId, {
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
        });
      }
    }

    // Find assistant text reply
    replyText = response.content.find((b) => b.type === 'text')?.text ?? "Thanks — that's everything I needed.";
  } else {
    // RUN SIMULATED DIALOGUE MODE
    console.log(`[Orchestrator] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY set. Running in Simulated Mode...`);
    const simResult = await runSimulatedOrchestrator(
      sessionId,
      respondentInput,
      currentQuestionId,
      respondentTurn.id,
      protocol,
      meta.transcriptionConfidence
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
  else if (replyText.includes(aq.close)) {
    nextQuestionId = 'close';
    await db.updateSessionStatus(sessionId, 'completed');
  }

  await db.appendTurn(sessionId, 'assistant', replyText, 'text', nextQuestionId);
  await db.updateSessionActivity(sessionId);

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
  protocol: Protocol,
  transcriptionConfidence: number | null
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
      reply = aq.anchor_1;
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
    // Fallback/Close state
    reply = aq.close;
  }

  // Save the mock tag if generated
  if (mockTag) {
    await db.saveTag(sessionId, {
      ...mockTag,
      transcription_confidence: transcriptionConfidence,
      turn_id: turnId,
    });
  }

  return { reply };
}
