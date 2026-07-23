-- Create tables

-- 1. Respondents: who you invited, kept separate from the anonymized ID Claude/Gemini ever sees
CREATE TABLE IF NOT EXISTS respondents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone text UNIQUE NOT NULL,
    cohort text,
    invited_at timestamptz DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb
);

-- 2. The PII firewall: AI only ever sees anon_id, never phone or name
CREATE TABLE IF NOT EXISTS respondent_anon_map (
    respondent_id uuid REFERENCES respondents(id) PRIMARY KEY,
    anon_id text UNIQUE NOT NULL DEFAULT 'R-' || substr(md5(random()::text), 1, 8)
);

-- 3. Protocols: Versioned so mid-study wording changes don't retroactively alter what earlier respondents were asked
CREATE TABLE IF NOT EXISTS protocols (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version text NOT NULL,
    is_active boolean DEFAULT true,
    anchor_questions jsonb NOT NULL,
    codebook jsonb NOT NULL
);

-- 4. Sessions: Tracks the progress of each respondent interview
CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    respondent_id uuid REFERENCES respondents(id) NOT NULL,
    protocol_id uuid REFERENCES protocols(id) NOT NULL,
    channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'whatsapp')),
    status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','consented','in_progress','completed','abandoned','declined')),
    consent_given boolean DEFAULT false,
    last_activity_at timestamptz,
    nudge_sent_at timestamptz,
    completed_at timestamptz,
    metadata jsonb DEFAULT '{}'::jsonb
);

-- 4b. Questions: Stores every question the bot asks, linked to protocol and session
CREATE TABLE IF NOT EXISTS questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid REFERENCES sessions(id) NOT NULL,
    protocol_id uuid REFERENCES protocols(id) NOT NULL,
    anchor_key text,
    question_text text NOT NULL,
    question_type text NOT NULL DEFAULT 'open_ended' CHECK (question_type IN ('open_ended', 'mcq', 'free_text')),
    options jsonb,
    turn_number integer NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- 5. Turns: Append-only, immutable transcript — never edit a row here after it's written
CREATE TABLE IF NOT EXISTS turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid REFERENCES sessions(id) NOT NULL,
    turn_number integer NOT NULL,
    role text NOT NULL CHECK (role IN ('assistant','respondent')),
    content text NOT NULL,
    question_id text,
    input_mode text CHECK (input_mode IN ('text','voice')),
    created_at timestamptz DEFAULT now(),
    UNIQUE (session_id, turn_number)
);

-- 6. Response Tags: Structured tags — generated twice per turn (live, then audited), never edited in place
CREATE TABLE IF NOT EXISTS response_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid REFERENCES sessions(id) NOT NULL,
    turn_id uuid REFERENCES turns(id),
    question_id text NOT NULL,
    question_uuid uuid REFERENCES questions(id),
    source text NOT NULL CHECK (source IN ('live','batch_audit')),
    raw_response text NOT NULL,
    economic_outcome text,
    bottleneck_types text[],
    benefit_mechanism text,
    sentiment text,
    confidence_in_tagging numeric(3,2),
    transcription_confidence numeric(3,2),
    quotable_snippet text,
    turn_number integer,
    metadata jsonb DEFAULT '{}'::jsonb
);

-- 7. Webhook Logs: Store raw incoming payloads from WhatsApp Cloud API for auditing/debugging
CREATE TABLE IF NOT EXISTS webhook_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    payload jsonb NOT NULL
);

-- Row Level Security (RLS) policies: Lock every table to server-side access only
ALTER TABLE respondents ENABLE ROW LEVEL SECURITY;
ALTER TABLE respondent_anon_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE protocols ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;

-- Create policies for service_role access
CREATE POLICY service_role_only ON respondents FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON respondent_anon_map FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON protocols FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON sessions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON questions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON turns FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON response_tags FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_only ON webhook_logs FOR ALL USING (auth.role() = 'service_role');
