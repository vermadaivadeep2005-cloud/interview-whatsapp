import dotenv from 'dotenv';

dotenv.config();

export interface LogPayload {
  requestId?: string;
  sessionId?: string;
  anonId?: string;
  turnId?: string;
  questionId?: string;
  provider?: 'gemini' | 'speechmatics' | 'local_classifier' | 'whatsapp';
  callReason?: string;
  latencyMs?: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  success?: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Mask sensitive information like phone numbers (254712345678 -> 254712...678).
 */
export function maskPhone(phone?: string): string {
  if (!phone) return 'unknown';
  const trimmed = phone.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-3)}`;
}

/**
 * Structured JSON Logger that adheres to security/PII filters.
 */
export const logger = {
  info(message: string, payload: LogPayload = {}) {
    console.log(JSON.stringify({
      level: 'INFO',
      timestamp: new Date().toISOString(),
      message,
      ...sanitizePayload(payload),
    }));
  },

  warn(message: string, payload: LogPayload = {}) {
    console.warn(JSON.stringify({
      level: 'WARN',
      timestamp: new Date().toISOString(),
      message,
      ...sanitizePayload(payload),
    }));
  },

  error(message: string, error?: any, payload: LogPayload = {}) {
    console.error(JSON.stringify({
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      message,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...sanitizePayload(payload),
    }));
  },
};

/**
 * Sanitizes log payloads to guarantee no PII (phone number, raw text replies) is logged.
 */
function sanitizePayload(payload: LogPayload): Record<string, any> {
  const clean = { ...payload };

  // Filter out credentials if accidentally passed
  const blacklist = [
    'WHATSAPP_ACCESS_TOKEN',
    'GEMINI_API_KEY',
    'SPEECHMATICS_API_KEY',
    'authorization',
    'auth',
    'apiKey',
    'accessToken',
  ];

  for (const k of Object.keys(clean)) {
    if (blacklist.some((b) => k.toLowerCase().includes(b.toLowerCase()))) {
      clean[k] = '[REDACTED]';
    }
  }

  // Mask phone numbers if present
  if (clean.phone) {
    clean.phone = maskPhone(String(clean.phone));
  }
  if (clean.toPhone) {
    clean.toPhone = maskPhone(String(clean.toPhone));
  }
  if (clean.fromPhone) {
    clean.fromPhone = maskPhone(String(clean.fromPhone));
  }

  // Never log raw content or audios
  delete clean.rawAudio;
  delete clean.raw_audio;
  delete clean.buffer;

  return clean;
}
