import dotenv from 'dotenv';

dotenv.config();

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Sends a standard text message over WhatsApp Cloud API.
 */
export async function sendWhatsAppMessage(toPhone: string, text: string): Promise<any> {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[WhatsApp Mock API] Send Message to ${toPhone}: "${text}"`);
    return { mock: true, to: toPhone, text };
  }

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`WhatsApp API send error (${response.status}): ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error sending WhatsApp message to ${toPhone}:`, error);
    throw error;
  }
}

/**
 * Sends interactive buttons for consent flow.
 */
export async function sendConsentButtons(toPhone: string): Promise<any> {
  const textBody = "Before we start: this will be recorded and transcribed, your responses will be anonymized in reporting, and you can stop at any point by saying 'stop.' OK to continue?";

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[WhatsApp Mock API] Send Consent Buttons to ${toPhone}`);
    return { mock: true, to: toPhone, textBody };
  }

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: textBody },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'consent_yes', title: 'Yes, continue' } },
              { type: 'reply', reply: { id: 'consent_no', title: 'No thanks' } },
            ],
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`WhatsApp API button error (${response.status}): ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error sending WhatsApp consent buttons to ${toPhone}:`, error);
    throw error;
  }
}

export interface DownloadedMedia {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Downloads a media file from WhatsApp Cloud API using its media ID.
 * Supports a "local:<path>" fallback for offline testing using real audio files.
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<DownloadedMedia> {
  if (mediaId.startsWith('local:')) {
    const filePath = mediaId.replace('local:', '');
    const fs = require('fs');
    const path = require('path');
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      let mimeType = 'audio/ogg';
      if (ext === '.wav') mimeType = 'audio/wav';
      else if (ext === '.mp3') mimeType = 'audio/mpeg';
      else if (ext === '.m4a') mimeType = 'audio/mp4';
      return { buffer, filename, mimeType };
    } else {
      console.warn(`[WhatsApp Mock API] Local file not found: ${filePath}. Returning mock audio.`);
      return { buffer: Buffer.from('mock-audio-content'), filename: 'voice_note.ogg', mimeType: 'audio/ogg' };
    }
  }

  if (!ACCESS_TOKEN) {
    console.warn(`[WhatsApp Mock API] Download media ID: ${mediaId} - returning mock audio buffer.`);
    return { buffer: Buffer.from('mock-audio-content'), filename: 'voice_note.ogg', mimeType: 'audio/ogg' };
  }

  try {
    // 1. Get the media URL from Meta Graph API
    const metaUrl = `https://graph.facebook.com/v20.0/${mediaId}`;
    const urlResponse = await fetch(metaUrl, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
    });

    if (!urlResponse.ok) {
      const errorText = await urlResponse.text();
      throw new Error(`WhatsApp Media URL lookup error (${urlResponse.status}): ${errorText}`);
    }

    const mediaMetadata = (await urlResponse.json()) as { url: string };
    const downloadUrl = mediaMetadata.url;

    if (!downloadUrl) {
      throw new Error(`No download URL returned for media ID ${mediaId}`);
    }

    // 2. Download the binary audio content
    const mediaResponse = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
    });

    if (!mediaResponse.ok) {
      throw new Error(`WhatsApp Media download error (${mediaResponse.status})`);
    }

    const arrayBuffer = await mediaResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Attempt to guess mime type from headers
    const contentType = mediaResponse.headers.get('content-type') || 'audio/ogg';
    let filename = 'voice_note.ogg';
    if (contentType.includes('wav')) filename = 'voice_note.wav';
    else if (contentType.includes('mpeg') || contentType.includes('mp3')) filename = 'voice_note.mp3';

    return {
      buffer,
      filename,
      mimeType: contentType,
    };
  } catch (error) {
    console.error(`Failed to download WhatsApp media with ID ${mediaId}:`, error);
    throw error;
  }
}
