import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const SPEECHMATICS_API_KEY = process.env.SPEECHMATICS_API_KEY;

// Speechmatics batch transcription endpoint
const SPEECHMATICS_JOBS_URL = 'https://asr.api.speechmatics.com/v2/jobs/';

export interface TranscriptionResult {
  text: string;
  confidence: number;
}

/**
 * Estimates confidence score based on the transcription response.
 * Speechmatics provides confidence per-word; we return overall confidence
 * from the transcript metadata if available, otherwise default to 0.95.
 */
function extractConfidence(transcript: any): number {
  // Speechmatics returns per-word confidence inside results[].alternatives[].confidence
  const results: any[] = transcript?.results || [];
  if (results.length === 0) return 0.0;

  const confidences = results
    .flatMap((r: any) => (r.alternatives || []).map((a: any) => a.confidence))
    .filter((c: any) => typeof c === 'number');

  if (confidences.length === 0) return 0.95; // default if not present
  const avg = confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length;
  return Math.round(avg * 100) / 100;
}

/**
 * Converts a Speechmatics transcript object to a plain text string
 * by joining all word alternatives.
 */
function extractText(transcript: any): string {
  const results: any[] = transcript?.results || [];
  return results
    .map((r: any) => r.alternatives?.[0]?.content || '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Transcribes audio using the Speechmatics Batch API.
 * Falls back to a mock response if the API key is not set or the call fails.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice_note.ogg',
  mimeType: string = 'audio/ogg'
): Promise<TranscriptionResult> {
  if (!SPEECHMATICS_API_KEY) {
    logger.warn('SPEECHMATICS_API_KEY is not set. Returning mock transcription.', { provider: 'speechmatics', callReason: 'missing_api_key' });
    return {
      text: 'This is a simulated transcription of the audio voice note.',
      confidence: 0.9,
    };
  }

  try {
    // ── Step 1: Submit the job ──────────────────────────────────────────────
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('data_file', blob, filename);

    // Speechmatics job config — auto-detects language
    const jobConfig = {
      type: 'transcription',
      transcription_config: {
        operating_point: 'enhanced',
        enable_partials: false,
      },
    };
    formData.append('config', JSON.stringify(jobConfig));

    const submitResponse = await fetch(SPEECHMATICS_JOBS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SPEECHMATICS_API_KEY}`,
      },
      body: formData,
    });

    if (!submitResponse.ok) {
      const errText = await submitResponse.text();
      throw new Error(`Speechmatics job submission error (${submitResponse.status}): ${errText}`);
    }

    const { id: jobId } = (await submitResponse.json()) as { id: string };
    logger.info(`Speechmatics job submitted: ${jobId}`, { provider: 'speechmatics', callReason: 'submit_job' });

    // ── Step 2: Poll until the job is done ─────────────────────────────────
    const MAX_POLLS = 30;  // 30 × 2s = 60s max wait
    const POLL_INTERVAL_MS = 2000;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const statusResponse = await fetch(`${SPEECHMATICS_JOBS_URL}${jobId}`, {
        headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
      });

      if (!statusResponse.ok) {
        const errText = await statusResponse.text();
        throw new Error(`Speechmatics status check error (${statusResponse.status}): ${errText}`);
      }

      const statusData = (await statusResponse.json()) as { job: { status: string } };
      const status = statusData.job?.status;
      logger.info(`Job ${jobId} status: ${status} (poll ${i + 1}/${MAX_POLLS})`, { provider: 'speechmatics', callReason: 'poll_status' });

      if (status === 'done') {
        // ── Step 3: Fetch the transcript ─────────────────────────────────────
        const transcriptResponse = await fetch(
          `${SPEECHMATICS_JOBS_URL}${jobId}/transcript?format=json-v2`,
          {
            headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
          }
        );

        if (!transcriptResponse.ok) {
          const errText = await transcriptResponse.text();
          throw new Error(`Speechmatics transcript fetch error (${transcriptResponse.status}): ${errText}`);
        }

        const transcript = await transcriptResponse.json();
        const text = extractText(transcript);
        const confidence = extractConfidence(transcript);

        logger.info(`Speechmatics job ${jobId} completed`, { provider: 'speechmatics', callReason: 'get_transcript', success: true });
        return { text, confidence };
      }

      if (status === 'rejected' || status === 'deleted') {
        throw new Error(`Speechmatics job ${jobId} failed with status: ${status}`);
      }
    }

    throw new Error(`Speechmatics job ${jobId} did not complete within the timeout window.`);
  } catch (error) {
    logger.error('Error during transcription via Speechmatics:', error, { provider: 'speechmatics', success: false });
    return {
      text: '[Transcription Failed]',
      confidence: 0.0,
    };
  }
}
