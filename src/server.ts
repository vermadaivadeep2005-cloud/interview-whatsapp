import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { db, supabase } from './db';
import { handleTurn } from './orchestrator';
import { sendWhatsAppMessage, sendConsentButtons, downloadWhatsAppMedia } from './whatsapp';
import { transcribeAudio } from './transcribe';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_verification_token';

// GET /webhook - Verification Handshake for Meta
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verification successful!');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Verification failed. Tokens do not match.');
  return res.status(403).send('Forbidden');
});

// POST /webhook - Message Handler
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // Log raw incoming webhook metadata/payload for debugging
    await supabase.from('webhook_logs').insert({ payload: body });

    // Check if the payload is from WhatsApp Cloud API
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];

    if (!message) {
      // Return 200 OK for other webhook events (like status deliveries, read receipts)
      return res.status(200).send('OK');
    }

    const fromPhone = message.from;
    console.log(`[Webhook] Received message from ${fromPhone}, type: ${message.type}`);

    // Retrieve or create session for the phone number
    const session = await db.getOrCreateSessionForPhone(fromPhone);
    const sessionId = session.id;

    let text = '';
    let inputMode: 'text' | 'voice' = 'text';
    let transcriptionConfidence: number | null = null;

    // 1. Process incoming message content based on its type
    if (message.type === 'text') {
      text = message.text.body;
    } else if (message.type === 'interactive') {
      // Interactive button clicks (like the consent options)
      const replyId = message.interactive?.button_reply?.id;
      text = replyId || '';
    } else if (message.type === 'audio') {
      console.log(`[Webhook] Voice note received with media ID: ${message.audio.id}`);
      inputMode = 'voice';
      try {
        const media = await downloadWhatsAppMedia(message.audio.id);
        const transcription = await transcribeAudio(media.buffer, media.filename, media.mimeType);
        text = transcription.text;
        transcriptionConfidence = transcription.confidence;
        console.log(`[Webhook] Transcribed: "${text}" (confidence: ${transcriptionConfidence})`);
      } catch (err) {
        console.error('[Webhook] Failed to process voice note:', err);
        await sendWhatsAppMessage(fromPhone, "Sorry, I had trouble processing that voice note. Could you try sending it again, or type a text message?");
        return res.status(200).send('OK');
      }
    } else {
      // Unrecognized message types (stickers, images, locations)
      await sendWhatsAppMessage(fromPhone, "Sorry, I can only read text or voice messages right now.");
      return res.status(200).send('OK');
    }

    // 2. Gatekeeper: Enforce Consent flow before storing turns or triggering orchestrator
    if (!session.consent_given) {
      const normalizedInput = text.trim().toLowerCase();
      const isConsentYes = normalizedInput === 'consent_yes' || 
                           normalizedInput === 'yes' || 
                           normalizedInput === 'y' || 
                           normalizedInput === 'haan' || 
                           normalizedInput === 'han' || 
                           normalizedInput === 'ha' || 
                           normalizedInput === 'ok' || 
                           normalizedInput === 'okay';
      const isConsentNo = normalizedInput === 'consent_no' || 
                          normalizedInput === 'no' || 
                          normalizedInput === 'n' || 
                          normalizedInput === 'nahi' || 
                          normalizedInput === 'nhi' || 
                          normalizedInput === 'na';

      if (isConsentYes) {
        console.log(`[Consent] Session ${sessionId} consented.`);
        // Update session state
        await db.updateSessionStatus(sessionId, 'in_progress', true);
        
        // Hand off to orchestrator with a mock "Yes, continue" to trigger the first question (Anchor 1)
        const reply = await handleTurn(sessionId, "Yes, continue", {
          inputMode: 'text',
          transcriptionConfidence: null
        });
        
        await sendWhatsAppMessage(fromPhone, reply);
      } else if (isConsentNo) {
        console.log(`[Consent] Session ${sessionId} declined.`);
        await db.updateSessionStatus(sessionId, 'declined', false);
        await sendWhatsAppMessage(fromPhone, "Thank you for your time. The interview has been declined.");
      } else {
        // Did not consent, send the consent buttons
        console.log(`[Consent] Re-prompting consent for session ${sessionId}.`);
        await sendConsentButtons(fromPhone);
      }

      return res.status(200).send('OK');
    }

    // 3. Normal Interview Flow: If user says 'stop', terminate session
    if (text.trim().toLowerCase() === 'stop') {
      console.log(`[Webhook] Stop command received. Terminating session ${sessionId}`);
      await db.updateSessionStatus(sessionId, 'declined');
      await sendWhatsAppMessage(fromPhone, "You have stopped the interview. Your answers up to this point have been saved. Thank you.");
      return res.status(200).send('OK');
    }

    // 4. Send to orchestrator
    const reply = await handleTurn(sessionId, text, {
      inputMode,
      transcriptionConfidence
    });

    // 5. Send orchestrator's response back to respondent
    await sendWhatsAppMessage(fromPhone, reply);
    return res.status(200).send('OK');

  } catch (error) {
    console.error('[Webhook Error]', error);
    // Return 200 OK so Meta doesn't flood/retry webhook, but log the crash
    return res.status(200).send('OK');
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook Verify Token: ${WHATSAPP_VERIFY_TOKEN}`);
});
