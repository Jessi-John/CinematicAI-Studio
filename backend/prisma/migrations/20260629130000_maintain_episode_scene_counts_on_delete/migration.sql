-- REL-022: Keep cached story counts consistent when child rows are deleted.
-- The original backfill migration only computed counts at creation time; any
-- future deletion of an episode or scene (including via ON DELETE CASCADE
-- when a story is removed) would leave the parent story with stale counts.
-- These triggers decrement the cached counters on every deletion.

CREATE OR REPLACE FUNCTION decrement_story_episode_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE "stories"
    SET "episodeCount" = GREATEST(0, "episodeCount" - 1)
    WHERE id = OLD."storyId";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decrement_story_scene_count()
RETURNS TRIGGER AS $$
DECLARE
    v_story_id TEXT;
BEGIN
    SELECT "storyId" INTO v_story_id
    FROM "episodes"
    WHERE id = OLD."episodeId";

    IF v_story_id IS NOT NULL THEN
        UPDATE "stories"
        SET "sceneCount" = GREATEST(0, "sceneCount" - 1)
        WHERE id = v_story_id;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS episode_delete_count ON "episodes";
CREATE TRIGGER episode_delete_count
AFTER DELETE ON "episodes"
FOR EACH ROW
EXECUTE FUNCTION decrement_story_episode_count();

DROP TRIGGER IF EXISTS scene_delete_count ON "scenes";
CREATE TRIGGER scene_delete_count
AFTER DELETE ON "scenes"
FOR EACH ROW
EXECUTE FUNCTION decrement_story_scene_count();
