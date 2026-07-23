-- Migration v2: Questions table, response_tags additions, channel default, demographics constraints
-- Run this in your Supabase SQL Editor AFTER the previous migrations.

-- 1. Create the questions table
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

-- Enable RLS and add policy
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_only ON questions FOR ALL USING (auth.role() = 'service_role');

-- 2. Add question_uuid and turn_number to response_tags
ALTER TABLE response_tags
ADD COLUMN IF NOT EXISTS question_uuid uuid REFERENCES questions(id);

ALTER TABLE response_tags
ADD COLUMN IF NOT EXISTS turn_number integer;

-- 3. Change the default channel on sessions from 'whatsapp' to 'web'
ALTER TABLE sessions ALTER COLUMN channel SET DEFAULT 'web';

-- 4. Add CHECK constraint for channel values
-- (safe: uses NOT VALID so existing rows are not checked)
ALTER TABLE sessions
ADD CONSTRAINT sessions_channel_check CHECK (channel IN ('web', 'whatsapp')) NOT VALID;
