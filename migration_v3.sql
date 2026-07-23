-- Migration v3: Fix response_tags foreign key relationship with questions table

-- 1. Drop the old question_id text column
ALTER TABLE response_tags
DROP COLUMN question_id;

-- 2. Rename question_uuid to question_id
ALTER TABLE response_tags
RENAME COLUMN question_uuid TO question_id;

-- 3. Enforce NOT NULL constraint
ALTER TABLE response_tags
ALTER COLUMN question_id SET NOT NULL;
