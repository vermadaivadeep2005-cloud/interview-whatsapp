import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { db, supabase } from './db';
import { handleTurn } from './orchestrator';
import { downloadWhatsAppMedia } from './whatsapp';
import { getTransport } from './transport';
import { logger } from './logger';
import { transcribeAudio } from './transcribe';
import multer from 'multer';

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
    logger.info('Webhook verification successful', { provider: 'whatsapp', callReason: 'verify_handshake' });
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed: verify token mismatch', { provider: 'whatsapp', callReason: 'verify_handshake' });
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

    // §5 Channel derivation: messages arriving via the WhatsApp Cloud API webhook are 'whatsapp'
    const channel = 'whatsapp';

    logger.info('Incoming webhook message received', { provider: 'whatsapp', callReason: 'incoming_webhook', messageType: message.type });

    // Retrieve or create session for the phone number, passing derived channel
    const session = await db.getOrCreateSessionForPhone(fromPhone, channel);
    const sessionId = session.id;

    // §6 Update last_activity_at on every incoming message, before any processing
    await db.updateSessionActivity(sessionId);

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
      logger.info('Incoming audio voice note received', { provider: 'whatsapp', callReason: 'audio_received' });
      inputMode = 'voice';
      try {
        const media = await downloadWhatsAppMedia(message.audio.id);
        const transcription = await transcribeAudio(media.buffer, media.filename, media.mimeType);
        text = transcription.text;
        transcriptionConfidence = transcription.confidence;
        logger.info('Audio transcription completed', { provider: 'speechmatics', callReason: 'transcription_success' });
      } catch (err) {
        logger.error('Failed to process incoming audio voice note', err, { provider: 'whatsapp', success: false });
        await getTransport().sendMessage(fromPhone, "Sorry, I had trouble processing that voice note. Could you try sending it again, or type a text message?");
        return res.status(200).send('OK');
      }
    } else {
      // Unrecognized message types (stickers, images, locations)
      await getTransport().sendMessage(fromPhone, "Sorry, I can only read text or voice messages right now.");
      return res.status(200).send('OK');
    }

    // Update session mode_of_input if needed
    const currentMode = session.mode_of_input;
    let nextMode = currentMode;
    if (!currentMode) {
      nextMode = inputMode;
    } else if (currentMode === 'text' && inputMode === 'voice') {
      nextMode = 'mixed';
    } else if (currentMode === 'voice' && inputMode === 'text') {
      nextMode = 'mixed';
    }
    if (nextMode !== currentMode && nextMode) {
      await db.updateSessionModeOfInput(sessionId, nextMode);
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
        logger.info('Consent granted for session', { sessionId, callReason: 'consent_granted' });
        await db.updateSessionStatus(sessionId, 'in_progress', true);

        // Start demographics collection — ask for name first
        const firstDemoReply = 'Karibu! Before we begin the interview, could you share your name?';
        await db.appendTurn(sessionId, 'assistant', firstDemoReply, 'text', 'demo_name');
        await getTransport().sendMessage(fromPhone, firstDemoReply);
      } else if (isConsentNo) {
        logger.info('Consent declined for session', { sessionId, callReason: 'consent_declined' });
        await db.updateSessionStatus(sessionId, 'declined', false);
        await getTransport().sendMessage(fromPhone, "Thank you for your time. The interview has been declined.");
      } else {
        // Did not consent, send the consent buttons
        logger.info('Invalid consent reply: re-prompting buttons', { sessionId, callReason: 'consent_prompt' });
        await getTransport().sendConsent(fromPhone);
      }

      return res.status(200).send('OK');
    }

    // 3. Normal Interview Flow: If user says 'stop', terminate session
    if (text.trim().toLowerCase() === 'stop') {
      logger.info('Stop command received: terminating session', { sessionId, callReason: 'user_stopped_session' });
      // §6 Fix: 'stop' mid-interview should be 'abandoned', not 'declined'
      // 'declined' is for refusing consent; 'abandoned' is for quitting mid-way
      await db.updateSessionStatus(sessionId, 'abandoned');
      await getTransport().sendMessage(fromPhone, "You have stopped the interview. Your answers up to this point have been saved. Thank you.");
      return res.status(200).send('OK');
    }

    // 4. Send to orchestrator — wrapped in try/catch to handle errors and update session status
    let reply: string;
    try {
      reply = await handleTurn(sessionId, text, {
        inputMode,
        transcriptionConfidence
      });
    } catch (orchErr) {
      // §6: Error boundary — don't leave session stuck at 'in_progress' on unrecoverable errors
      logger.error('handleTurn threw an unrecoverable error; marking session abandoned', orchErr, {
        sessionId,
        callReason: 'orchestrator_crash',
      });
      try {
        await db.updateSessionStatus(sessionId, 'abandoned');
      } catch (statusErr) {
        logger.error('Failed to mark session abandoned after orchestrator crash', statusErr, { sessionId });
      }
      await getTransport().sendMessage(fromPhone, "Sorry, something went wrong on our end. Your answers have been saved. We'll follow up with you.");
      return res.status(200).send('OK');
    }

    // 5. Send orchestrator's response back to respondent
    await getTransport().sendMessage(fromPhone, reply);
    return res.status(200).send('OK');

  } catch (error) {
    logger.error('Unhandled webhook route crash', error, { provider: 'whatsapp', success: false });
    return res.status(200).send('OK');
  }
});

// Web Chat API Endpoint
const upload = multer();

app.post('/api/web-chat', upload.single('audio'), async (req: Request, res: Response): Promise<any> => {
  try {
    const { phone, text: bodyText } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const channel = 'web';
    const session = await db.getOrCreateSessionForPhone(phone, channel);
    const sessionId = session.id;

    await db.updateSessionActivity(sessionId);

    let text = bodyText || '';
    let inputMode: 'text' | 'voice' = 'text';
    let transcriptionConfidence: number | null = null;

    if (req.file) {
      logger.info('Incoming web audio received', { provider: 'web', callReason: 'audio_received' });
      inputMode = 'voice';
      try {
        const transcription = await transcribeAudio(req.file.buffer, req.file.originalname, req.file.mimetype);
        text = transcription.text;
        transcriptionConfidence = transcription.confidence;
        logger.info('Audio transcription completed', { provider: 'speechmatics', callReason: 'transcription_success' });
      } catch (err) {
        logger.error('Failed to process incoming web audio', err, { provider: 'web', success: false });
        return res.status(500).json({ error: 'Failed to transcribe audio', reply: 'Sorry, I had trouble processing that voice note.' });
      }
    }

    const currentMode = session.mode_of_input;
    let nextMode = currentMode;
    if (!currentMode) nextMode = inputMode;
    else if (currentMode === 'text' && inputMode === 'voice') nextMode = 'mixed';
    else if (currentMode === 'voice' && inputMode === 'text') nextMode = 'mixed';
    if (nextMode !== currentMode && nextMode) await db.updateSessionModeOfInput(sessionId, nextMode);

    if (!session.consent_given) {
      const normalizedInput = text.trim().toLowerCase();
      const isConsentYes = normalizedInput === 'consent_yes' || normalizedInput === 'yes' || normalizedInput === 'y' || normalizedInput === 'ok' || normalizedInput === 'okay';
      const isConsentNo = normalizedInput === 'consent_no' || normalizedInput === 'no' || normalizedInput === 'n';

      if (isConsentYes) {
        await db.updateSessionStatus(sessionId, 'in_progress', true);
        const firstDemoReply = 'Karibu! Before we begin the interview, could you share your name?';
        await db.appendTurn(sessionId, 'assistant', firstDemoReply, 'text', 'demo_name');
        return res.json({ reply: firstDemoReply });
      } else if (isConsentNo) {
        await db.updateSessionStatus(sessionId, 'declined', false);
        return res.json({ reply: "Thank you for your time. The interview has been declined." });
      } else {
        return res.json({ reply: "Would you like to participate in this interview? Please reply with 'Yes' or 'No'." });
      }
    }

    if (text.trim().toLowerCase() === 'stop') {
      await db.updateSessionStatus(sessionId, 'abandoned');
      return res.json({ reply: "You have stopped the interview. Your answers up to this point have been saved. Thank you." });
    }

    let reply: string;
    try {
      reply = await handleTurn(sessionId, text, { inputMode, transcriptionConfidence });
    } catch (orchErr) {
      logger.error('handleTurn threw error', orchErr, { sessionId });
      await db.updateSessionStatus(sessionId, 'abandoned');
      return res.json({ reply: "Sorry, something went wrong on our end. Your answers have been saved." });
    }

    return res.json({ reply });
  } catch (error) {
    logger.error('Unhandled web-chat crash', error, { provider: 'web' });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook Verify Token: ${WHATSAPP_VERIFY_TOKEN}`);
});
