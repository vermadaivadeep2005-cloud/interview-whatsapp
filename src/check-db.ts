import { supabase } from './db';

async function checkDb() {
  console.log('Fetching latest sessions, turns and response_tags from Supabase...');

  // Get latest session
  const { data: sessions, error: sError } = await supabase
    .from('sessions')
    .select('*, respondents(phone)')
    .order('last_activity_at', { ascending: false })
    .limit(3);

  if (sError) {
    console.error('Error fetching sessions:', sError);
    process.exit(1);
  }

  if (!sessions || sessions.length === 0) {
    console.log('No sessions found in database.');
    process.exit(0);
  }

  for (const session of sessions) {
    console.log('\n==================================================');
    console.log(`Session ID: ${session.id}`);
    console.log(`Status: ${session.status} | Consent: ${session.consent_given}`);
    console.log(`Respondent Phone: ${(session as any).respondents?.phone}`);
    console.log('==================================================');

    // Get turns
    const { data: turns, error: tError } = await supabase
      .from('turns')
      .select('*')
      .eq('session_id', session.id)
      .order('turn_number', { ascending: true });

    if (tError) {
      console.error('Error fetching turns:', tError);
      continue;
    }

    console.log('\n--- Transcript ---');
    for (const turn of turns || []) {
      console.log(`[Turn ${turn.turn_number}] ${turn.role.toUpperCase()}: "${turn.content}" (Mode: ${turn.input_mode}, QID: ${turn.question_id})`);
    }

    // Get response tags
    const { data: tags, error: tagError } = await supabase
      .from('response_tags')
      .select('*')
      .eq('session_id', session.id)
      .order('source', { ascending: true });

    if (tagError) {
      console.error('Error fetching tags:', tagError);
      continue;
    }

    console.log('\n--- Response Tags ---');
    for (const tag of tags || []) {
      console.log(`[Source: ${tag.source} | QID: ${tag.question_id}] Sentiment: ${tag.sentiment} | Economic Outcome: ${tag.economic_outcome} | Confidence: ${tag.confidence_in_tagging}`);
    }
  }

  process.exit(0);
}

checkDb();
