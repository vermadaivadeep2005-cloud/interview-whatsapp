import { createInterface } from 'readline';
import { db } from './db';
import retagSession from './batch-audit';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `http://localhost:${PORT}/webhook`;

const PHONE = '254712345678'; // Simulated Kenyan phone number

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function createTextPayload(text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: PHONE,
                  id: `wamid.text.${Date.now()}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function createButtonPayload(buttonId: 'consent_yes' | 'consent_no') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: PHONE,
                  id: `wamid.button.${Date.now()}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: {
                      id: buttonId,
                      title: buttonId === 'consent_yes' ? 'Yes, continue' : 'No thanks',
                    },
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function createAudioPayload(mediaId: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: PHONE,
                  id: `wamid.audio.${Date.now()}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'audio',
                  audio: {
                    id: mediaId,
                    mime_type: 'audio/ogg',
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

async function sendWebhook(payload: any) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Webhook request failed with status: ${res.status}`);
    }
  } catch (err) {
    console.error('Error sending request to webhook server:', err);
    console.log('Is the server running? Start it first using: npm run dev');
  }
}

async function printLatestAssistantReply(sessionId: string) {
  // Wait 1.5 seconds for orchestrator to write to database
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const turns = await db.getFullTranscript(sessionId);
    const lastTurn = turns[turns.length - 1];
    
    if (lastTurn && lastTurn.role === 'assistant') {
      console.log(`\n🤖 Interviewer: "${lastTurn.content}"`);
      if (lastTurn.question_id) {
        console.log(`   [State: ${lastTurn.question_id}]`);
      }
    } else {
      console.log('\n🤖 Interviewer: [Waiting for response...]');
    }
  } catch (err) {
    console.error('Error fetching latest turn:', err);
  }
}

async function main() {
  console.log('==================================================');
  console.log('   AI-Moderated Interview WhatsApp Simulator CLI   ');
  console.log('==================================================');
  console.log('Connecting to Supabase...');

  let session;
  try {
    session = await db.getOrCreateSessionForPhone(PHONE);
    console.log(`Session found/created: ${session.id}`);
    console.log(`Current Status: ${session.status.toUpperCase()}`);
    console.log(`Consent Given: ${session.consent_given}`);
  } catch (err: any) {
    console.error('Could not connect to database:', err.message);
    console.log('\nHave you run schema.sql in your Supabase SQL Editor?');
    process.exit(1);
  }

  const sessionId = session.id;

  console.log('\nAvailable commands:');
  console.log('  /yes                - Simulate clicking "Yes, continue" consent button');
  console.log('  /no                 - Simulate clicking "No thanks" consent button');
  console.log('  /voice <file_path>  - Transcribe and send a real local audio file (e.g. /voice C:\\recording.wav)');
  console.log('  /audit              - Run the Batch Audit Pass on this session');
  console.log('  /exit               - Exit this simulator\n');

  // Print last turn to resume context
  const turns = await db.getFullTranscript(sessionId);
  if (turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    console.log(`Last message: [${lastTurn.role}] "${lastTurn.content}"`);
  } else {
    console.log('🤖 Interviewer: [No messages sent yet. Send any text to start or trigger consent]');
  }

  const promptUser = () => {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();

      if (trimmed === '/exit') {
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/yes') {
        console.log('>> Clicking button [Yes, continue]');
        await sendWebhook(createButtonPayload('consent_yes'));
        await printLatestAssistantReply(sessionId);
      } else if (trimmed === '/no') {
        console.log('>> Clicking button [No thanks]');
        await sendWebhook(createButtonPayload('consent_no'));
        await printLatestAssistantReply(sessionId);
      } else if (trimmed.startsWith('/voice')) {
        const filePath = trimmed.replace('/voice', '').trim();
        if (!filePath) {
          console.log('>> Please specify a path to a real local audio file. Example:');
          console.log('   /voice C:\\Users\\Indra\\Desktop\\recording.wav');
          console.log('   (Supports .wav, .mp3, and .ogg formats)');
          promptUser();
          return;
        }
        
        console.log(`>> Sending local audio file: "${filePath}"`);
        await sendWebhook(createAudioPayload(`local:${filePath}`));
        await printLatestAssistantReply(sessionId);
      } else if (trimmed === '/audit') {
        console.log('>> Running Batch Audit Pass...');
        await retagSession(sessionId);
        console.log('Audit completed. Check `response_tags` table in Supabase where source = \'batch_audit\'.');
      } else {
        // Send normal text message
        await sendWebhook(createTextPayload(trimmed));
        await printLatestAssistantReply(sessionId);
      }

      promptUser();
    });
  };

  promptUser();
}

main();
