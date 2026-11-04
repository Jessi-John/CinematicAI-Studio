-- M28: Align grade_floor with quality_floor.
--
-- The quality scoring system has TWO independent floors:
--   1. quality_floor (numeric, 0-100) — checked against `overall` score
--   2. grade_floor (letter, A-F) — checked against the grade derived from the overall score
--
-- Grades map to scores: A=90+, B=80+, C=70+, D=60+, F=<60.
-- This means grade_floor='B' (score >=80) is STRICTER than quality_floor=70 (score >=70).
--
-- The contradiction caused valid C-grade stories (score 70-79) to be sent to the DLQ
-- despite passing the quality_floor check. In real mode with AI providers, scores
-- of 70-85 are typical — many genres (sci-fi, thriller, drama) consistently score
-- 70-79 (grade C) and were being rejected.
--
-- Fix: Set grade_floor='C' to match quality_floor=70. Both floors now accept the
-- same range of stories. A story must score >=70 AND have grade >=C to pass.
-- The numeric quality_floor=70 still enforces the lower bound; grade_floor='C'
-- adds no additional constraint for the majority of valid stories.
--
-- For deployments that want strict B-grade output, admins can update the
-- system_settings table via the admin API or directly via SQL.

UPDATE "system_settings"
SET "value" = 'C'
WHERE "key" = 'grade_floor' AND "value" = 'B';
