import { sendWhatsAppMessage, sendConsentButtons } from './whatsapp';

export interface ChannelTransport {
  sendMessage(toPhone: string, text: string): Promise<{ delivered: boolean; error?: string }>;
  sendConsent(toPhone: string): Promise<{ delivered: boolean; error?: string }>;
}

export class WhatsAppTransport implements ChannelTransport {
  async sendMessage(toPhone: string, text: string) {
    try {
      const res = await sendWhatsAppMessage(toPhone, text);
      const isMock = res && res.mock === true;
      return { delivered: true, details: isMock ? 'mock' : 'live' };
    } catch (e) {
      return { delivered: false, error: (e as Error).message };
    }
  }

  async sendConsent(toPhone: string) {
    try {
      const res = await sendConsentButtons(toPhone);
      const isMock = res && res.mock === true;
      return { delivered: true, details: isMock ? 'mock' : 'live' };
    } catch (e) {
      return { delivered: false, error: (e as Error).message };
    }
  }
}

export class LoggingTransport implements ChannelTransport {
  async sendMessage(toPhone: string, text: string) {
    console.log(`[LoggingTransport] SIMULATED DELIVERY to ${toPhone}: "${text}"`);
    return { delivered: true };
  }

  async sendConsent(toPhone: string) {
    console.log(`[LoggingTransport] SIMULATED CONSENT prompts sent to ${toPhone}`);
    return { delivered: true };
  }
}

let activeTransport: ChannelTransport | null = null;

export function getTransport(): ChannelTransport {
  if (activeTransport) return activeTransport;

  const mode = process.env.TRANSPORT || 'logging';
  console.log(`[Transport] Initializing active transport mode: ${mode}`);

  if (mode === 'whatsapp') {
    activeTransport = new WhatsAppTransport();
  } else {
    activeTransport = new LoggingTransport();
  }

  return activeTransport;
}
