import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { db, Turn } from './db';
import dotenv from 'dotenv';

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_NAME = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// The tool for batch tagging the entire transcript
export const batchTagTool = {
  name: 'tag_full_transcript',
  description: 'Tag all responses from the full interview transcript against the codebook.',
  input_schema: {
    type: 'object',
    properties: {
      tagged_questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question_id: {
              type: 'string',
              enum: ['anchor_1', 'anchor_1_probe', 'anchor_2', 'anchor_2_probe', 'anchor_3', 'anchor_3_probe', 'anchor_4', 'anchor_4_probe', 'catch_all'],
            },
            raw_response: { type: 'string' },
            economic_outcome: {
              type: 'string',
              enum: ['income_increase', 'role_change_no_pay_change', 'improved_current_role_only', 'no_change', 'too_early_to_tell'],
            },
            bottleneck_types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence', 'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market', 'bottleneck_none_reported'],
              },
            },
            benefit_mechanism: {
              type: 'string',
              enum: ['efficiency_in_current_role', 'new_income_stream', 'internal_mobility', 'external_mobility', 'credibility_signal', 'not_applicable'],
            },
            sentiment: {
              type: 'string',
              enum: ['positive', 'neutral', 'negative', 'mixed'],
            },
            confidence_in_tagging: { type: 'number', minimum: 0, maximum: 1 },
            quotable_snippet: { type: 'string' },
          },
          required: ['question_id', 'raw_response', 'sentiment', 'confidence_in_tagging'],
        },
      },
    },
    required: ['tagged_questions'],
  },
};

// Gemini batch tag tool definition
export const geminiBatchTagTool = {
  name: 'tag_full_transcript',
  description: 'Tag all responses from the full interview transcript against the codebook.',
  parameters: {
    type: 'OBJECT',
    properties: {
      tagged_questions: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            question_id: {
              type: 'STRING',
              enum: ['anchor_1', 'anchor_1_probe', 'anchor_2', 'anchor_2_probe', 'anchor_3', 'anchor_3_probe', 'anchor_4', 'anchor_4_probe', 'catch_all', 'wrap_up'],
            },
            raw_response: { type: 'STRING' },
            economic_outcome: {
              type: 'STRING',
              enum: ['income_increase', 'role_change_no_pay_change', 'improved_current_role_only', 'no_change', 'too_early_to_tell'],
            },
            bottleneck_types: {
              type: 'ARRAY',
              items: {
                type: 'STRING',
                enum: ['bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence', 'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market', 'bottleneck_none_reported'],
              },
            },
            benefit_mechanism: {
              type: 'STRING',
              enum: ['efficiency_in_current_role', 'new_income_stream', 'internal_mobility', 'external_mobility', 'credibility_signal', 'not_applicable'],
            },
            sentiment: {
              type: 'STRING',
              enum: ['positive', 'neutral', 'negative', 'mixed'],
            },
            confidence_in_tagging: { type: 'NUMBER' },
            quotable_snippet: { type: 'STRING' },
          },
          required: ['question_id', 'raw_response', 'sentiment', 'confidence_in_tagging'],
        },
      },
    },
    required: ['tagged_questions'],
  },
};

export function buildBatchAuditPrompt(codebook: any): string {
  return `
You are an expert researcher reviewing a completed qualitative interview. Your task is to perform a batch audit tag of the entire transcript.

Review all turns carefully. A respondent's earlier answers may be clarified or contradicted by their later comments. Ensure your tags reflect the overall context of the complete interview.

Use the provided codebook for your classifications:
${JSON.stringify(codebook, null, 2)}

You must classify and tag every respondent turn that maps to an anchor question or probe. For each, output a structured element in the tagged_questions array.
`;
}

export function formatTranscriptForTagging(transcript: Turn[]): string {
  return transcript
    .map((t) => {
      const modeStr = t.input_mode ? ` [via ${t.input_mode}]` : '';
      const qStr = t.question_id ? ` (answering ${t.question_id})` : '';
      return `${t.role.toUpperCase()}${modeStr}${qStr}: ${t.content}`;
    })
    .join('\n\n');
}

/**
 * Executes a batch audit pass on a completed session.
 */
export async function retagSession(sessionId: string): Promise<void> {
  console.log(`[Batch Audit] Starting audit for session ${sessionId}...`);
  const transcript = await db.getFullTranscript(sessionId);
  const protocol = await db.getProtocolForSession(sessionId);

  if (transcript.length === 0) {
    console.warn(`[Batch Audit] Session ${sessionId} has no turns. Skipping.`);
    return;
  }

  if (ai) {
    const formattedTranscript = formatTranscriptForTagging(transcript);

    try {
      console.log(`[Batch Audit] Calling Gemini API (${GEMINI_MODEL}) for session ${sessionId}...`);
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: formattedTranscript }] }],
        config: {
          systemInstruction: buildBatchAuditPrompt(protocol.codebook),
          tools: [{ functionDeclarations: [geminiBatchTagTool as any] }],
        },
      });

      if (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        if (call.name === 'tag_full_transcript') {
          const taggedQuestions = (call.args as any).tagged_questions;
          console.log(`[Batch Audit via Gemini] Saving ${taggedQuestions.length} audited tags...`);
          await db.saveBatchTags(sessionId, taggedQuestions);
          console.log('[Batch Audit] Successfully saved audited tags.');
        } else {
          console.warn(`[Batch Audit] Received unexpected function call: ${call.name}`);
        }
      } else {
        console.error('[Batch Audit] Gemini did not return a function call.');
      }
    } catch (err) {
      console.error('Error during Gemini batch audit:', err);
    }
  } else if (anthropic) {
    const formattedTranscript = formatTranscriptForTagging(transcript);

    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 2000,
      system: buildBatchAuditPrompt(protocol.codebook),
      tools: [batchTagTool as any],
      tool_choice: { type: 'tool', name: 'tag_full_transcript' },
      messages: [{ role: 'user', content: formattedTranscript }],
    });

    const toolCall = response.content.find((b) => b.type === 'tool_use' && b.name === 'tag_full_transcript');
    if (toolCall && toolCall.type === 'tool_use') {
      const taggedQuestions = (toolCall.input as any).tagged_questions;
      console.log(`[Batch Audit] Saving ${taggedQuestions.length} audited tags...`);
      await db.saveBatchTags(sessionId, taggedQuestions);
      console.log('[Batch Audit] Successfully saved audited tags.');
    } else {
      console.error('[Batch Audit] Claude did not return the expected tool call.');
    }
  } else {
    // Simulated Batch Audit Mode
    console.log(`[Batch Audit] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY set. Running in Simulated Audit Mode...`);
    
    // Find all respondent turns that have a question_id
    const respondentTurns = transcript.filter((t) => t.role === 'respondent' && t.question_id);
    const mockTaggedQuestions = respondentTurns.map((turn) => {
      return {
        question_id: turn.question_id!,
        raw_response: turn.content,
        economic_outcome: turn.question_id === 'anchor_1' ? 'income_increase' : null,
        bottleneck_types: turn.question_id === 'anchor_2' ? ['bottleneck_skill_gap'] : null,
        benefit_mechanism: turn.question_id === 'anchor_3' ? 'efficiency_in_current_role' : null,
        sentiment: 'positive',
        confidence_in_tagging: 0.95,
        quotable_snippet: turn.content.substring(0, Math.min(50, turn.content.length)),
      };
    });

    console.log(`[Batch Audit] Saving ${mockTaggedQuestions.length} mock audited tags...`);
    await db.saveBatchTags(sessionId, mockTaggedQuestions);
    console.log('[Batch Audit] Successfully saved mock audited tags.');
  }
}

// CLI runner
if (require.main === module) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Please specify a session ID: npm run audit -- <session_id>');
    process.exit(1);
  }

  retagSession(sessionId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Audit run failed:', err);
      process.exit(1);
    });
}
export default retagSession;
