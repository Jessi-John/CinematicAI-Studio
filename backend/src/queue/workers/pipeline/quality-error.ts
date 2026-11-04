/**
 * REL-002: Typed error class to distinguish genuine quality failures from
 * infrastructure errors. The previous string-matching approach
 * (e.g. `err.message.includes('Story quality below floor')`) was fragile —
 * Redis / circuit-breaker errors could be misclassified as quality
 * failures and waste the retry budget.
 *
 * The orchestrator catches `QualityError` and decides whether to retry
 * the whole pipeline. Non-quality errors propagate immediately without
 * consuming any retry budget.
 */
export class QualityError extends Error {
  constructor(
    message: string,
    public readonly qualityScore: number,
    public readonly qualityGrade: string,
    public readonly issues: string[],
    public readonly storyCandidate?: import('../../../services/types.js').Story
  ) {
    super(message);
    this.name = 'QualityError';
  }
}
