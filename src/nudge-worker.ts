import { supabase, db } from './db';
import { sendWhatsAppMessage } from './whatsapp';

/**
 * Nudge and Abandonment check job.
 * Intended to be run periodically (e.g., every 30 minutes via cron).
 */
export async function runNudgeJob() {
  console.log('[Nudge Worker] Starting nudge check...');

  const now = new Date();
  const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Process 10-hour Stale Sessions -> Send Nudge
  console.log(`[Nudge Worker] Checking for sessions stale since 10h (before ${tenHoursAgo})...`);
  const { data: staleAt10h, error: error10h } = await supabase
    .from('sessions')
    .select('*')
    .eq('status', 'in_progress')
    .is('nudge_sent_at', null)
    .lt('last_activity_at', tenHoursAgo);

  if (error10h) {
    console.error('Error fetching 10h stale sessions:', error10h);
  } else {
    console.log(`[Nudge Worker] Found ${staleAt10h?.length || 0} sessions to nudge.`);
    for (const session of staleAt10h || []) {
      try {
        const phone = await db.getPhoneForSession(session.id);
        const nudgeMessage = "Hey! We still have a couple more questions for you — and honestly, your answers so far have been great. Got a few minutes now, or want us to check back later? You can also just send a voice note if that's easier!";
        
        console.log(`[Nudge Worker] Sending nudge to phone ${phone} for session ${session.id}...`);
        await sendWhatsAppMessage(phone, nudgeMessage);
        await db.markNudgeSent(session.id);
      } catch (err) {
        console.error(`Failed to process 10h nudge for session ${session.id}:`, err);
      }
    }
  }

  // 2. Process 24-hour Stale Sessions -> Mark Abandoned
  console.log(`[Nudge Worker] Checking for sessions stale since 24h (before ${twentyFourHoursAgo})...`);
  const { data: staleAt24h, error: error24h } = await supabase
    .from('sessions')
    .select('*')
    .eq('status', 'in_progress')
    .lt('last_activity_at', twentyFourHoursAgo);

  if (error24h) {
    console.error('Error fetching 24h stale sessions:', error24h);
  } else {
    console.log(`[Nudge Worker] Found ${staleAt24h?.length || 0} sessions to abandon.`);
    for (const session of staleAt24h || []) {
      try {
        console.log(`[Nudge Worker] Marking session ${session.id} as abandoned.`);
        await db.markAbandoned(session.id);
      } catch (err) {
        console.error(`Failed to mark session ${session.id} as abandoned:`, err);
      }
    }
  }

  console.log('[Nudge Worker] Nudge check complete.');
}

// If run directly from command line (e.g. npm run nudge)
if (require.main === module) {
  runNudgeJob().then(() => process.exit(0)).catch((err) => {
    console.error('Nudge job failed:', err);
    process.exit(1);
  });
}
