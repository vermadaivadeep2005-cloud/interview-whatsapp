-- Migration: Add mode_of_input column to sessions table
-- Phase 5: Session mode_of_input Tracking
-- Run this in your Supabase SQL Editor

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS mode_of_input text
CHECK (mode_of_input IN ('text', 'voice', 'mixed')) DEFAULT 'text';

COMMENT ON COLUMN sessions.mode_of_input IS 'Tracks if the session was conducted purely via text, purely via voice, or mixed (both)';
