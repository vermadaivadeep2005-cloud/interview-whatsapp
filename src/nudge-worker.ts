import { supabase, db } from './db';
import { getTransport } from './transport';
import { logger } from './logger';

/**
 * Nudge and Abandonment check job.
 * Intended to be run periodically (e.g., every 30 minutes via cron).
 */
export async function runNudgeJob() {
  logger.info('Starting nudge check worker...', { provider: 'whatsapp', callReason: 'nudge_check' });

  const now = new Date();
  const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Process 10-hour Stale Sessions -> Send Nudge
  const { data: staleAt10h, error: error10h } = await supabase
    .from('sessions')
    .select('*')
    .eq('status', 'in_progress')
    .is('nudge_sent_at', null)
    .lt('last_activity_at', tenHoursAgo);

  if (error10h) {
    logger.error('Error fetching 10h stale sessions', error10h);
  } else {
    for (const session of staleAt10h || []) {
      try {
        const phone = await db.getPhoneForSession(session.id);
        const nudgeMessage = "Hey! We still have a couple more questions for you — and honestly, your answers so far have been great. Got a few minutes now, or want us to check back later? You can also just send a voice note if that's easier!";
        
        logger.info(`Sending nudge for session ${session.id}`, { sessionId: session.id, provider: 'whatsapp', callReason: 'nudge_sent' });
        const result = await getTransport().sendMessage(phone, nudgeMessage);
        if (result.delivered) {
          await db.markNudgeSent(session.id);
        } else {
          logger.error(`Transport failed to deliver nudge for session ${session.id}`, result.error, { sessionId: session.id });
        }
      } catch (err) {
        logger.error(`Failed to process 10h nudge for session ${session.id}`, err, { sessionId: session.id });
      }
    }
  }

  // 2. Process 24-hour Stale Sessions -> Mark Abandoned
  const { data: staleAt24h, error: error24h } = await supabase
    .from('sessions')
    .select('*')
    .eq('status', 'in_progress')
    .lt('last_activity_at', twentyFourHoursAgo);

  if (error24h) {
    logger.error('Error fetching 24h stale sessions', error24h);
  } else {
    for (const session of staleAt24h || []) {
      try {
        logger.info(`Marking session ${session.id} as abandoned due to inactivity`, { sessionId: session.id, callReason: 'session_abandoned' });
        await db.markAbandoned(session.id);
      } catch (err) {
        logger.error(`Failed to mark session ${session.id} as abandoned`, err, { sessionId: session.id });
      }
    }
  }

  logger.info('Nudge check complete.', { provider: 'whatsapp' });
}

// If run directly from command line (e.g. npm run nudge)
if (require.main === module) {
  runNudgeJob().then(() => process.exit(0)).catch((err) => {
    logger.error('Nudge job failed', err);
    process.exit(1);
  });
}
