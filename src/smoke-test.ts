import dotenv from 'dotenv';

dotenv.config();

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delay = 1000): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, options);
    if (response.status === 429 && attempt < retries) {
      attempt++;
      console.warn(`⚠️ Rate limited (429). Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
      continue;
    }
    return response;
  }
}

async function callOpenAICompletion(messages: any[], tools?: any[]): Promise<any> {
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

async function runSmokeTest() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         LLM PROVIDER SMOKE TEST              ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    console.error('❌ ERROR: LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL is not defined in env variables.');
    process.exit(1);
  }

  console.log(`Base URL: ${LLM_BASE_URL}`);
  console.log(`Model:    ${LLM_MODEL}`);
  console.log('\n--- STEP 1: Testing simple completion ---');

  try {
    const messages = [
      { role: 'user', content: 'Hello, model! Confirm if you are working. Keep the reply to under 10 words.' }
    ];
    
    console.log('Sending test prompt...');
    const result = await callOpenAICompletion(messages);
    const text = result.choices?.[0]?.message?.content?.trim();
    
    console.log('✨ Chat completion successful!');
    console.log(`🤖 Model Reply: "${text}"`);
  } catch (err: any) {
    console.error('❌ Simple completion test FAILED:', err.message);
    if (err.body) {
      console.error('Error Body:', err.body);
    }
    process.exit(1);
  }

  console.log('\n--- STEP 2: Testing tool-call round trip ---');
  try {
    const logResponseToolSchema = {
      type: 'function',
      function: {
        name: 'log_response',
        description: "Log the respondent's answer with structured coding before continuing.",
        parameters: {
          type: 'object',
          properties: {
            question_id: { type: 'string', enum: ['anchor_1'] },
            raw_response: { type: 'string' },
            economic_outcome: { type: 'string', enum: ['income_increase'] },
            bottleneck_types: { type: 'array', items: { type: 'string' } },
            benefit_mechanism: { type: 'string', enum: ['efficiency_in_current_role'] },
            sentiment: { type: 'string', enum: ['positive'] },
            confidence_in_tagging: { type: 'number' },
            quotable_snippet: { type: 'string' }
          },
          required: ['question_id', 'raw_response', 'sentiment', 'confidence_in_tagging']
        }
      }
    };

    const messages = [
      {
        role: 'user',
        content: "Please log the response: 'I got a 50% raise.' question_id is anchor_1, economic_outcome is income_increase, bottleneck_types is empty, benefit_mechanism is efficiency_in_current_role, sentiment is positive, confidence_in_tagging is 0.95, and quotable_snippet is '50% raise'. You must call the log_response tool."
      }
    ];

    console.log('Sending prompt and expecting function call...');
    const result = await callOpenAICompletion(messages, [logResponseToolSchema]);
    const message = result.choices?.[0]?.message;

    if (message?.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      console.log('✨ Tool call round-trip successful!');
      console.log(`   Function Name: ${toolCall.function?.name}`);
      console.log(`   Arguments:     ${toolCall.function?.arguments}`);
      
      const parsedArgs = JSON.parse(toolCall.function?.arguments);
      console.log('✅ Parsed Arguments Successfully:', parsedArgs);
      
      console.log('\n🎉 ALL SMOKE TESTS PASSED SUCCESSFULLY!');
      process.exit(0);
    } else {
      console.error('❌ FAILED: The model responded but did not call the tool.');
      console.log('Model Response was:', message?.content);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Tool call round-trip test FAILED:', err.message);
    if (err.body) {
      console.error('Error Body:', err.body);
    }
    process.exit(1);
  }
}

runSmokeTest();
