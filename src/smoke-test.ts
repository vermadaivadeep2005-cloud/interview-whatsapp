import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

async function runSmokeTest() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        GEMINI PROVIDER SMOKE TEST            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (!GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY is not defined in env variables.');
    process.exit(1);
  }

  console.log(`Initializing client for model: ${GEMINI_MODEL}...`);
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  try {
    console.log('Sending test prompt: "Hello, model! Confirm if you are working."...');
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: 'Hello, model! Confirm if you are working. Keep the reply to under 10 words.',
    });

    console.log('\n✨ API CALL SUCCESSFUL! Response:');
    console.log(`   "${response.text?.trim()}"\n`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ API CALL FAILED:', err);
    process.exit(1);
  }
}

runSmokeTest();
