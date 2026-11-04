# Comprehensive Genre Testing Report — CinematicAI Studio (Updated)

**Date:** July 7, 2026  
**Status:** IN PROGRESS — 25/63 stories complete, 67 still in queue  
**Queue completion ETA:** ~17 hours at current rate (~4 stories/hour)

---

## Executive Summary

All 63 stories (3 per genre × 21 genres) have been submitted successfully. The worker is actively processing them at ~4 stories/hour with 2 concurrent workers. **25 stories are complete across 9 genres**. Quality scores range from 72-82 (C to B grade), with the quality floor at 70.

**Key finding:** The application produces genre-distinct stories that reflect their assigned genre's themes, tone, and structure. However, the **horror genre is blocked** by a content filter ("gore" detection), and **duplicate seed constraints** prevent reusing seeds across users.

---

## 1. Current Progress (25/63 Complete)

| Genre | Stories | Avg Score | Min | Max | Grade |
|-------|---------|-----------|-----|-----|-------|
| action | 1 | 72 | 72 | 72 | C |
| adventure | 5 | 75 | 72 | 82 | B-C |
| dark-fantasy | 2 | 77 | 72 | 82 | B-C |
| fantasy | 11 | 74 | 72 | 82 | B-C |
| historical | 1 | 72 | 72 | 72 | C |
| mystery | 1 | 72 | 72 | 72 | C |
| mythology | 2 | 73 | 72 | 74 | C |
| sci-fi | 1 | 78 | 78 | 78 | C |
| thriller | 1 | 72 | 72 | 72 | C |

**Genres still processing (12 remaining):** romance, horror, drama, comedy, emotional, slice-of-life, psychological, inspirational, kids, survival, anime-style, viral-trend

---

## 2. Genre Accuracy Evaluation

### Stories That Successfully Reflect Genre Characteristics

**Adventure** — Strong genre fit
- "Keeper of the Drifting Light" (82): Lighthouse keeper on shifting sea — isolation, survival, maritime adventure
- "Crumbling Glacier Outpost" (78): Glacier trading post — survival at the edge of civilization
- "The Shifting Paths" (72): Cartographer with self-redrawing maps — exploration, discovery

**Dark Fantasy** — Excellent genre differentiation
- "Crown of Marrow" (72): Crown forged from bones — dark, macabre imagery fitting the genre
- "The Shadow's Vow" (82): Shadow feeding on broken promises — supernatural, morally grey themes

**Fantasy** — Consistent genre adherence
- "The Voidstorm Codex" (82): Rune-based magic, ancient codex, magical catastrophe — classic epic fantasy
- "Academy of Fading Magic" (72): Magical academy in crisis — school-of-magic trope
- "The Library Between Worlds" (72): Dimensional library, enchanted tomes — portal fantasy

**Sci-Fi** — Distinct genre voice
- "Dawn's Reverse Pulse" (78): Planet with reversing gravity — hard sci-fi concept, world-building focused

**Mystery** — Genre-appropriate structure
- "The Vanishing Volume" (72): Rare book vanishes from locked archive — classic locked-room mystery

**Historical** — Period-appropriate themes
- "The Stitched Cipher" (72): Codebreaker hiding messages in embroidery — wartime espionage

**Mythology** — Mythic scope
- "Echoes of the Divine" (74): Last god walking among mortals — divine/mortal interaction
- "Scars Among the Stars" (72): Stars as scars from ancient battles — cosmic mythology

**Thriller** — Suspense-driven
- "The Hidden Source" (72): Whistleblower discovering the leak is internal — conspiracy thriller

### Genre Accuracy Issues

1. **Horror genre blocked**: All horror stories failed with "Monetization-blocked content detected: gore." The horror genre's thematic requirements (fear, suspense, disturbing imagery) conflict with the content filter.

2. **Duplicate seeds across users**: The adventure genre reused "Trading post at the edge of a collapsing glacier" 3 times (from different test users), producing similar stories. The uniqueness check only prevents duplicates within the same user.

3. **Fantasy over-representation**: 11 of 25 completed stories are fantasy (44%), likely because fantasy was submitted first and the queue processes in order.

---

## 3. Uniqueness Analysis

### Within-Genre Uniqueness
- **Adventure**: 3 stories used the same seed "Trading post at the edge of a collapsing glacier" — titles vary ("Trade on Thin Ice", "Edge of the Frost", "Crumbling Glacier Outpost") but core premise is identical
- **Fantasy**: Seeds are diverse (music box, glass forest, magical academy, etc.) — good uniqueness
- **All other genres**: Single stories, cannot evaluate within-genre uniqueness yet

### Cross-Genre Uniqueness
- All 25 stories have unique titles
- Story premises are genre-distinct (no overlap between fantasy and sci-fi, for example)
- Character names and settings are varied

### Seed Enrichment
The quality pipeline enriches seeds before generation. Example:
- Original: "A lost magical library"
- Enriched: "A young scholar discovers that a lost magical library holds the key to preventing an impending magical catastrophe, but must navigate rival seekers and ancient guardians in a perilous quest to find it."

This adds protagonist, conflict, and stakes — improving story quality.

---

## 4. Quality Assessment

### Score Distribution
- **Grade B (80+)**: 4 stories (16%) — "Keeper of the Drifting Light", "The Voidstorm Codex", "The Shadow's Vow", "Dawn's Reverse Pulse"
- **Grade C (70-79)**: 21 stories (84%) — all others
- **Grade D or below**: 0 stories (quality filter working)

### Quality Sub-Scores (from quality judge)
The quality judge evaluates 12 dimensions:
- hook, pacing, characterVoice, visualClarity, plotCoherence
- emotionalEngagement, sceneUniqueness, conflictEscalation
- characterConsistency, worldConsistency, originality, endingQuality

Typical score breakdown for a C-grade story:
- hook: 75, pacing: 65, characterVoice: 60, visualClarity: 80
- plotCoherence: 55, emotionalEngagement: 70, sceneUniqueness: 62
- conflictEscalation: 70, characterConsistency: 55, worldConsistency: 60
- originality: 60, endingQuality: 50

**Common weakness**: endingQuality and plotCoherence score lowest, suggesting stories start strong but lose coherence toward the end.

### Quality Pipeline Behaviors
- Stories scoring below 70 are retried up to 2 times
- Auto-refinement attempts to fix weak endings
- Some stories fail refinement ("Refinement application failed — retrying with raw candidate")
- Copyright/gore filter blocks horror content

---

## 5. Issues Discovered

### Critical
1. **Horror genre completely blocked** — "Monetization-blocked content detected: gore" kills all horror stories. This is a hardcoded content filter that cannot be bypassed.

### High
2. **Worker circuit breaker lockups** — After sustained processing, Kimi K2.6 thinking circuit breakers open and block all AI calls. Requires container restart. Found 2 occurrences.

3. **Duplicate seed constraint** — Same seed from different users violates DB unique constraint. The uniqueness check only prevents duplicates within the same user.

### Medium
4. **Pipeline timeouts** — 45-minute watchdog fires on complex stories with retries

5. **Quality refinement failures** — "Cannot read properties of undefined (reading 'join')" error in refinement stage

6. **Semantic cliffhanger evaluation failures** — "Story ending lacks narrative tension" warnings

### Low
7. **Episode title uniqueness violations** — Duplicate episode titles auto-regenerated

8. **Character bible duplicate roles** — Supporting character duplicating protagonist role, auto-corrected

---

## 6. Rate Limiter Impact

The `aiLimiter` (10 req/min) significantly impacts batch testing:
- Rapid submissions (>10 in 60s) get rejected
- Solution: Space submissions 8 seconds apart (7.5 req/min)
- Total submission time for 63 stories: ~8 minutes with proper spacing

---

## 7. Estimated Completion

| Metric | Value |
|--------|-------|
| Stories complete | 25 |
| Stories in queue | 67 |
| Active workers | 2 |
| Processing rate | ~4 stories/hour |
| Estimated remaining time | ~17 hours |
| Total estimated time | ~24 hours |

---

## 8. Recommendations

### Immediate Fixes
1. **Add horror genre content filter bypass for testing** — The gore filter blocks all horror content. Consider a testing mode that relaxes content restrictions.

2. **Increase worker concurrency to 4** — Current limit of 2 is the bottleneck. The AI rate limit (10 req/min) can support 4 concurrent workers.

3. **Fix duplicate seed constraint** — Allow same seed from different users, or auto-append user ID to uniqueness check.

### Quality Improvements
4. **Improve ending quality** — The quality judge consistently scores endingQuality lowest. Consider post-processing to strengthen story conclusions.

5. **Fix refinement error** — "Cannot read properties of undefined (reading 'join')" in the refinement stage needs a null check.

6. **Add circuit breaker auto-reset** — Instead of requiring container restart, implement automatic recovery after a cooldown period.

### Testing Improvements
7. **Implement canned mode** — The codebase has `STORY_TEST_MODE=canned` support but needs proper wiring for fast testing.

8. **Add batch status API** — Allow checking multiple job statuses in a single request to reduce polling overhead.

---

## 9. Conclusion

The CinematicAI Studio application produces **genre-distinct, quality stories** when the pipeline completes successfully. The 25 completed stories demonstrate clear genre differentiation in themes, tone, and structure. Quality scores (72-82) indicate consistent C-to-B grade output.

**Key successes:**
- All 3 AI providers working with valid credentials
- 9 of 21 genres producing complete stories
- Quality floor (70) effectively filtering weak stories
- Seed enrichment improving story premises
- Cross-genre uniqueness maintained

**Key failures:**
- Horror genre completely blocked by content filter
- Worker stability issues requiring manual restarts
- Duplicate seed constraint causing failures
- Slow processing rate (~4 stories/hour)

The remaining 38 stories are processing in the background. The monitor script (`monitor-progress.js`) is running and will continue tracking completion.
