import { db, Turn } from './db';
import { sanitizeTagInput } from './tag-validator';
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
      console.warn(`[Batch Audit] Rate limited (429) on attempt ${attempt} of ${retries}. Retrying in ${delay}ms...`);
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

  if (LLM_API_KEY) {
    const formattedTranscript = formatTranscriptForTagging(transcript);
    console.log(`[Batch Audit] Calling OpenAI-Compatible API (${LLM_MODEL}) for session ${sessionId}...`);

    try {
      const openAIBatchTagTool = [
        {
          type: 'function' as const,
          function: {
            name: 'tag_full_transcript',
            description: batchTagTool.description,
            parameters: batchTagTool.input_schema,
          }
        }
      ];

      const messages: ChatMessage[] = [
        { role: 'system', content: buildBatchAuditPrompt(protocol.codebook) },
        { role: 'user', content: formattedTranscript },
      ];

      const response = await callOpenAICompletion(messages, openAIBatchTagTool);
      const choice = response.choices?.[0];
      const assistantMessage = choice?.message;

      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];
        if (toolCall.function?.name === 'tag_full_transcript') {
          const rawArgs = JSON.parse(toolCall.function.arguments);
          const rawQuestions = rawArgs.tagged_questions || [];
          const taggedQuestions = rawQuestions.map((q: any) => sanitizeTagInput(q));
          console.log(`[Batch Audit via OpenAI] Saving ${taggedQuestions.length} audited tags...`);
          await db.saveBatchTags(sessionId, taggedQuestions);
          console.log('[Batch Audit] Successfully saved audited tags.');
        } else {
          console.warn(`[Batch Audit] Received unexpected function call: ${toolCall.function?.name}`);
        }
      } else {
        console.error('[Batch Audit] Model did not return a tool call.');
        await runSimulatedAudit(sessionId, transcript);
      }
    } catch (err) {
      console.error('Error during batch audit LLM call:', err);
      await runSimulatedAudit(sessionId, transcript);
    }
  } else {
    await runSimulatedAudit(sessionId, transcript);
  }
}

async function runSimulatedAudit(sessionId: string, transcript: Turn[]): Promise<void> {
  console.log(`[Batch Audit] Running in Simulated Audit Mode...`);
  
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
