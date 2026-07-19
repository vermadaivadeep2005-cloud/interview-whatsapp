import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function audit() {
  let issues = 0;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      DATABASE RELATIONSHIP AUDIT             ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── Row counts ────────────────────────────────────────────────
  console.log('── ROW COUNTS ──────────────────────────────────');
  const tables = ['respondents','respondent_anon_map','protocols','sessions','turns','response_tags','webhook_logs'];
  for (const t of tables) {
    const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
    console.log(`  ${t.padEnd(25)} ${count ?? '?'} rows`);
  }

  // ── Load all data ─────────────────────────────────────────────
  const { data: respondents } = await supabase.from('respondents').select('id, phone, cohort');
  const { data: anonMaps }    = await supabase.from('respondent_anon_map').select('respondent_id, anon_id');
  const { data: protocols }   = await supabase.from('protocols').select('id, version, is_active');
  const { data: sessions }    = await supabase.from('sessions').select('id, respondent_id, protocol_id, status, consent_given');
  const { data: turns }       = await supabase.from('turns').select('id, session_id, turn_number, role, question_id, input_mode');
  const { data: tags }        = await supabase.from('response_tags').select('id, session_id, turn_id, question_id, source');

  const respondentIds = new Set((respondents || []).map((r: any) => r.id));
  const protocolIds   = new Set((protocols   || []).map((p: any) => p.id));
  const sessionIds    = new Set((sessions    || []).map((s: any) => s.id));
  const turnIds       = new Set((turns       || []).map((t: any) => t.id));
  const anonRespIds   = new Set((anonMaps    || []).map((a: any) => a.respondent_id));

  // ── FK: sessions → respondents ────────────────────────────────
  console.log('\n── FK: sessions.respondent_id → respondents.id ─');
  const orphanSessionsResp = (sessions || []).filter((s: any) => !respondentIds.has(s.respondent_id));
  if (orphanSessionsResp.length > 0) {
    orphanSessionsResp.forEach((s: any) => console.log(`  ❌ session ${s.id} has unknown respondent_id ${s.respondent_id}`));
    issues += orphanSessionsResp.length;
  } else {
    console.log('  ✅ All sessions have a valid respondent_id');
  }

  // ── FK: sessions → protocols ──────────────────────────────────
  console.log('\n── FK: sessions.protocol_id → protocols.id ─────');
  const orphanSessionsProto = (sessions || []).filter((s: any) => !protocolIds.has(s.protocol_id));
  if (orphanSessionsProto.length > 0) {
    orphanSessionsProto.forEach((s: any) => console.log(`  ❌ session ${s.id} has unknown protocol_id ${s.protocol_id}`));
    issues += orphanSessionsProto.length;
  } else {
    console.log('  ✅ All sessions have a valid protocol_id');
  }

  const activeProtocols = (protocols || []).filter((p: any) => p.is_active);
  console.log(`\n── PROTOCOL HEALTH ──────────────────────────────`);
  console.log(`  Total protocols: ${(protocols || []).length}`);
  if (activeProtocols.length === 0) {
    console.log('  ❌ No active protocol — run: npm run seed');
    issues++;
  } else if (activeProtocols.length > 1) {
    console.log('  ⚠️  Multiple active protocols detected:');
    activeProtocols.forEach((p: any) => console.log(`    - v${p.version} (${p.id})`));
  } else {
    console.log(`  ✅ Exactly one active protocol: v${activeProtocols[0].version} (${activeProtocols[0].id})`);
  }

  // ── FK: anon_map → respondents ────────────────────────────────
  console.log('\n── FK: anon_map.respondent_id → respondents.id ─');
  const orphanAnon = (anonMaps || []).filter((a: any) => !respondentIds.has(a.respondent_id));
  if (orphanAnon.length > 0) {
    orphanAnon.forEach((a: any) => console.log(`  ❌ anon_map has unknown respondent_id ${a.respondent_id}`));
    issues += orphanAnon.length;
  } else {
    console.log('  ✅ All anon_map entries point to valid respondents');
  }
  const respondentsMissingAnon = (respondents || []).filter((r: any) => !anonRespIds.has(r.id));
  if (respondentsMissingAnon.length > 0) {
    respondentsMissingAnon.forEach((r: any) => console.log(`  ⚠️  respondent ${r.id} (${r.phone}) has NO anon_map entry`));
    issues += respondentsMissingAnon.length;
  } else {
    console.log('  ✅ Every respondent has an anon_map entry');
  }

  // ── FK: turns → sessions ──────────────────────────────────────
  console.log('\n── FK: turns.session_id → sessions.id ──────────');
  const orphanTurns = (turns || []).filter((t: any) => !sessionIds.has(t.session_id));
  if (orphanTurns.length > 0) {
    orphanTurns.forEach((t: any) => console.log(`  ❌ turn ${t.id} has unknown session_id ${t.session_id}`));
    issues += orphanTurns.length;
  } else {
    console.log('  ✅ All turns have a valid session_id');
  }

  // ── FK: response_tags → sessions ─────────────────────────────
  console.log('\n── FK: response_tags.session_id → sessions.id ──');
  const orphanTagsSess = (tags || []).filter((t: any) => !sessionIds.has(t.session_id));
  if (orphanTagsSess.length > 0) {
    orphanTagsSess.forEach((t: any) => console.log(`  ❌ tag ${t.id} has unknown session_id ${t.session_id}`));
    issues += orphanTagsSess.length;
  } else {
    console.log('  ✅ All response_tags have a valid session_id');
  }

  // ── FK: response_tags → turns ─────────────────────────────────
  console.log('\n── FK: response_tags.turn_id → turns.id ────────');
  const tagsWithTurnId = (tags || []).filter((t: any) => t.turn_id !== null);
  const orphanTagsTurn = tagsWithTurnId.filter((t: any) => !turnIds.has(t.turn_id));
  if (orphanTagsTurn.length > 0) {
    orphanTagsTurn.forEach((t: any) => console.log(`  ❌ tag ${t.id} has unknown turn_id ${t.turn_id}`));
    issues += orphanTagsTurn.length;
  } else {
    console.log(`  ✅ All ${tagsWithTurnId.length} tagged response_tags have a valid turn_id`);
  }

  // ── Turn ordering ─────────────────────────────────────────────
  console.log('\n── TURN ORDERING (sequential check) ─────────────');
  const sessionTurns: Record<string, number[]> = {};
  (turns || []).forEach((t: any) => {
    if (!sessionTurns[t.session_id]) sessionTurns[t.session_id] = [];
    sessionTurns[t.session_id].push(t.turn_number);
  });
  let gapCount = 0;
  for (const [sid, nums] of Object.entries(sessionTurns)) {
    const sorted = [...nums].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        console.log(`  ⚠️  session ${sid} turn gap: [${sorted.join(', ')}]`);
        gapCount++; break;
      }
    }
  }
  if (gapCount === 0) console.log('  ✅ All sessions have sequential turn_numbers');

  // ── Session status breakdown ──────────────────────────────────
  console.log('\n── SESSION STATUS BREAKDOWN ─────────────────────');
  const statusCounts: Record<string, number> = {};
  (sessions || []).forEach((s: any) => { statusCounts[s.status] = (statusCounts[s.status] || 0) + 1; });
  Object.entries(statusCounts).forEach(([k, v]) => console.log(`  ${k.padEnd(15)} ${v}`));
  const consentedCount = (sessions || []).filter((s: any) => s.consent_given).length;
  console.log(`  consent_given=true  ${consentedCount}`);

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  if (issues === 0) {
    console.log('║  ✅ AUDIT PASSED — 0 integrity issues found  ║');
  } else {
    console.log(`║  ❌ AUDIT FAILED — ${issues} issue(s) found             ║`);
  }
  console.log('╚══════════════════════════════════════════════╝\n');
  process.exit(issues > 0 ? 1 : 0);
}

audit().catch((err) => { console.error('Audit error:', err); process.exit(1); });
