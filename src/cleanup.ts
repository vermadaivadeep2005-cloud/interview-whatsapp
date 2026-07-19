import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Constants for dummy identification
const CLI_TEST_PHONE = '254712345678';
const TEST_COHORTS = new Set(['Initial Cohort', 'Test Cohort', 'simulated_cohort']);

async function runCleanup() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        DUMMY DATA CLEANUP UTILITY            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const isDryRun = !process.argv.includes('--confirm');
  console.log(`Mode: ${isDryRun ? '🔍 DRY RUN (no modifications)' : '⚠️  CONFIRMED DELETION'}\n`);

  // Load candidates
  console.log('Fetching database rows...');
  const { data: respondents } = await supabase.from('respondents').select('*');
  const { data: sessions } = await supabase.from('sessions').select('*');
  const { data: turns } = await supabase.from('turns').select('*');
  const { data: tags } = await supabase.from('response_tags').select('*');
  const { data: logs } = await supabase.from('webhook_logs').select('*');

  const dummyRespondents: Array<{ id: string; phone: string; reason: string }> = [];
  const dummySessions: Array<{ id: string; respondent_id: string; reason: string }> = [];
  const dummyTurns: Array<{ id: string; session_id: string; reason: string }> = [];
  const dummyTags: Array<{ id: string; session_id: string; reason: string }> = [];
  const dummyLogs: Array<{ id: string; reason: string }> = [];

  const dummyRespondentIds = new Set<string>();
  const dummySessionIds = new Set<string>();
  const dummyTurnIds = new Set<string>();

  // 1. Audit Respondents
  (respondents || []).forEach((r) => {
    let isDummy = false;
    let reason = '';

    if (r.phone === CLI_TEST_PHONE) {
      isDummy = true;
      reason = 'Matches CLI test phone number (254712345678)';
    } else if (r.cohort && TEST_COHORTS.has(r.cohort)) {
      isDummy = true;
      reason = `Cohort is test cohort: "${r.cohort}"`;
    } else if (r.metadata && (r.metadata.test_mode === true || r.metadata.simulated === true)) {
      isDummy = true;
      reason = 'Metadata indicates test_mode or simulatedRespondent';
    }

    if (isDummy) {
      dummyRespondents.push({ id: r.id, phone: r.phone, reason });
      dummyRespondentIds.add(r.id);
    }
  });

  // 2. Audit Sessions
  (sessions || []).forEach((s) => {
    let isDummy = false;
    let reason = '';

    if (dummyRespondentIds.has(s.respondent_id)) {
      isDummy = true;
      reason = 'Linked to dummy respondent';
    } else if (s.metadata && (s.metadata.test_mode === true || s.metadata.simulated === true)) {
      isDummy = true;
      reason = 'Session metadata contains test_mode / simulated tag';
    }

    if (isDummy) {
      dummySessions.push({ id: s.id, respondent_id: s.respondent_id, reason });
      dummySessionIds.add(s.id);
    }
  });

  // 3. Audit Turns
  (turns || []).forEach((t) => {
    if (dummySessionIds.has(t.session_id)) {
      dummyTurns.push({ id: t.id, session_id: t.session_id, reason: 'Linked to dummy session' });
      dummyTurnIds.add(t.id);
    }
  });

  // 4. Audit Tags
  (tags || []).forEach((t) => {
    if (dummySessionIds.has(t.session_id)) {
      dummyTags.push({ id: t.id, session_id: t.session_id, reason: 'Linked to dummy session' });
    }
  });

  // 5. Audit Webhook Logs
  (logs || []).forEach((l) => {
    let isDummy = false;
    let reason = '';
    const payloadStr = JSON.stringify(l.payload);
    if (payloadStr.includes(CLI_TEST_PHONE)) {
      isDummy = true;
      reason = 'Contains CLI test phone number';
    } else if (payloadStr.includes('test_mode') || payloadStr.includes('sandbox')) {
      isDummy = true;
      reason = 'Contains test mode markers';
    }

    if (isDummy) {
      dummyLogs.push({ id: l.id, reason });
    }
  });

  // ── Show report ───────────────────────────────────────────────
  console.log('── CANDIDATE DUMMY ROWS ────────────────────────');
  console.log(`  Respondents:   ${dummyRespondents.length} / ${(respondents || []).length}`);
  dummyRespondents.forEach((r) => console.log(`    - Respondent ${r.phone} (${r.id}): ${r.reason}`));

  console.log(`  Sessions:      ${dummySessions.length} / ${(sessions || []).length}`);
  dummySessions.forEach((s) => console.log(`    - Session ${s.id}: ${s.reason}`));

  console.log(`  Turns:         ${dummyTurns.length} / ${(turns || []).length}`);
  console.log(`  Response Tags: ${dummyTags.length} / ${(tags || []).length}`);
  console.log(`  Webhook Logs:  ${dummyLogs.length} / ${(logs || []).length}`);
  dummyLogs.forEach((l) => console.log(`    - Log ${l.id}: ${l.reason}`));

  const totalDummyRows = dummyRespondents.length + dummySessions.length + dummyTurns.length + dummyTags.length + dummyLogs.length;

  if (totalDummyRows === 0) {
    console.log('\n✅ No dummy rows detected in the database.');
    process.exit(0);
  }

  if (isDryRun) {
    console.log('\n💡 To perform deletion, rerun this command with the --confirm flag:');
    console.log('   npm run cleanup -- --confirm\n');
    process.exit(0);
  }

  // ── Confirmed Deletion Flow ───────────────────────────────────
  console.log('\n⚠️  WARNING: You are about to permanently delete the above data rows.');
  console.log('This action cannot be undone. To proceed, please confirm:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('\nType "APPROVE CLEANUP" to continue: ', async (answer) => {
    rl.close();
    if (answer.trim() !== 'APPROVE CLEANUP') {
      console.log('❌ Confirmation failed. Aborting cleanup.');
      process.exit(1);
    }

    console.log('\nDeleting dummy records in safe FK order...');

    try {
      // 1. Delete Response Tags
      if (dummyTags.length > 0) {
        console.log(`Deleting ${dummyTags.length} response tags...`);
        const { error } = await supabase.from('response_tags').delete().in('id', dummyTags.map((t) => t.id));
        if (error) throw error;
      }

      // 2. Delete Turns
      if (dummyTurns.length > 0) {
        console.log(`Deleting ${dummyTurns.length} turns...`);
        const { error } = await supabase.from('turns').delete().in('id', dummyTurns.map((t) => t.id));
        if (error) throw error;
      }

      // 3. Delete Sessions
      if (dummySessions.length > 0) {
        console.log(`Deleting ${dummySessions.length} sessions...`);
        const { error } = await supabase.from('sessions').delete().in('id', dummySessions.map((s) => s.id));
        if (error) throw error;
      }

      // 4. Delete Respondent Anon Maps
      if (dummyRespondents.length > 0) {
        console.log(`Deleting ${dummyRespondents.length} anon maps...`);
        const { error } = await supabase.from('respondent_anon_map').delete().in('respondent_id', dummyRespondents.map((r) => r.id));
        if (error) throw error;
      }

      // 5. Delete Respondents
      if (dummyRespondents.length > 0) {
        console.log(`Deleting ${dummyRespondents.length} respondents...`);
        const { error } = await supabase.from('respondents').delete().in('id', dummyRespondents.map((r) => r.id));
        if (error) throw error;
      }

      // 6. Delete Webhook Logs
      if (dummyLogs.length > 0) {
        console.log(`Deleting ${dummyLogs.length} webhook logs...`);
        const { error } = await supabase.from('webhook_logs').delete().in('id', dummyLogs.map((l) => l.id));
        if (error) throw error;
      }

      console.log('\n🎉 Cleanup successfully finished!');

      // Rerun DB Relationship Audit
      console.log('\nRerunning Database Audit...');
      const { execSync } = require('child_process');
      execSync('npx tsx src/db-audit.ts', { stdio: 'inherit' });

      process.exit(0);
    } catch (err) {
      console.error('\n❌ ERROR during deletion. DB may have been left in a partially deleted state:', err);
      process.exit(1);
    }
  });
}

runCleanup().catch((err) => {
  console.error('Cleanup utility crash:', err);
  process.exit(1);
});
