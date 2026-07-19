-- Migration: Add demographics column to sessions table
-- Phase 2: Demographics Collection
-- Run this in your Supabase SQL Editor

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS demographics jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN sessions.demographics IS 'Stores respondent demographics collected at interview start: name, email, age, gender, county, sub_county, occupation';
