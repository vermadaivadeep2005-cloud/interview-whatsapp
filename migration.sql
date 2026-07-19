-- Migration SQL: Add metadata columns, webhook logs, and timestamps

-- 1. Create Webhook Logs table to store raw metadata from WhatsApp Cloud API
CREATE TABLE IF NOT EXISTS webhook_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    payload jsonb NOT NULL
);

-- Enable RLS and add policy for service_role
ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_only ON webhook_logs FOR ALL USING (auth.role() = 'service_role');

-- 2. Add metadata JSONB column to respondents (for age, location, cohort details, etc.)
ALTER TABLE respondents 
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- 3. Add metadata JSONB column to sessions (for platform details, testing flags, etc.)
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- 4. Add created_at timing column to turns (tracks when the message was sent)
ALTER TABLE turns 
ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- 5. Add metadata JSONB column to response_tags (for model parameters, tokens used, etc.)
ALTER TABLE response_tags 
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
