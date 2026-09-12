/**
 * Adaptive mastery constants.
 *
 * Mathematical constants and default values for the mastery engine
 */

/** Default Glicko-2 rating deviation (phi) */
export const DEFAULT_PHI = 2.02;

/** Default Glicko-2 volatility (sigma) */
export const DEFAULT_SIGMA = 0.06;

/** Default FSRS stability in days */
export const DEFAULT_STABILITY = 0.1;

/** Default FSRS difficulty */
export const DEFAULT_DIFFICULTY = 5.0;

/** Maximum phi for cold start (ensures large deltas on first answers) */
export const COLD_START_PHI = 4.0;

/** Minimum time in minutes before time decay applies */
export const TIME_DECAY_THRESHOLD_MINUTES = 20;

/** FSRS 4.5.1 weights (17 parameters) */
export const FSRS_WEIGHTS = [
  0.4, // w[0] - initial stability for grade 1
  0.6, // w[1] - initial stability step
  2.4, // w[2] - initial difficulty for grade 1
  5.8, // w[3] - initial difficulty step
  4.93, // w[4] - initial difficulty mean
  0.94, // w[5] - initial difficulty step for grade
  0.86, // w[6] - difficulty update step
  0.01, // w[7] - difficulty retention
  1.49, // w[8] - stability update factor
  0.14, // w[9] - stability decay exponent
  0.94, // w[10] - grade factor
  2.18, // w[11] - grade exponent
  0.05, // w[12] - failure stability base
  0.34, // w[13] - failure difficulty exponent
  1.26, // w[14] - failure stability exponent
  0.29, // w[15] - failure grade factor
  2.61, // w[16] - failure constant
];

/** IRT parameters for different question types */
export const IRT_PARAMS: Record<
  "TF" | "MCQ" | "LONG",
  { a: number; c: number }
> = {
  TF: { a: 1.0, c: 0.5 }, // True/False: 50% guessing
  MCQ: { a: 1.2, c: 0.25 }, // Multiple Choice: 25% guessing (4 options)
  LONG: { a: 3.0, c: 0.0 }, // Long Answer: No guessing, high discrimination
};

/** Weighting constant for flashcard updates to mu */
export const FLASHCARD_MU_WEIGHT = 0.25;

/** Glicko-2 system constant (tau) */
export const GLICKO_TAU = 0.0833; // Approx 1/12

/** Maximum mu value (clamp). Raised so potential can reach 100 when mastered (100/(1+exp(-6)) ≈ 99.75). */
export const MAX_MU = 6.0;

/** Minimum mu value (clamp) */
export const MIN_MU = -4.0;

/** Streak bonus: multiply delta by (1 + this * min(streak-1, MAX_STREAK_FOR_BONUS-1)) when correct. */
export const STREAK_BONUS_PER_CORRECT = 0.5;
/** Max streak count used in bonus; 10+ correct in a row = 1 + 0.50*9 = 5.5x delta. */
export const MAX_STREAK_FOR_BONUS = 10;
/** When streak >= 4, minimum delta scales by (1 + this * min(streak-3, 7)) so high streaks keep moving mastery. */
export const STREAK_MIN_SCALE = 0.45;

/** K-factor for question difficulty updates (small to prevent wild swings) */
export const QUESTION_UPDATE_K = 0.05;

/** Base multiplier for long-response so written answers move mastery visibly. Final multiplier = this × (totalMarks/5) × outcome. Kept moderate to avoid one question swinging 80%+. */
export const LONG_RESPONSE_BOOST_BASE = 2.5;
/** Minimum mu-delta for a correct long-response so mastery always moves (real-time feel). */
export const MIN_DELTA_MU_CORRECT_LONG = 0.1;
/** Maximum mu-delta for a correct long-response in one question (prevents 12%→100% in one answer). */
export const MAX_REWARD_MU_LONG = 0.45;
/** Maximum mu-delta penalty for a wrong long-response in one question (prevents 98%→2% in one answer). */
export const MAX_PENALTY_MU_LONG = 0.45;
/** Written questions only: min mu change per answer (≈7% movement). */
export const MIN_DELTA_MU_LONG_QUESTION = 0.25;
/** Written questions: max mu change when confidence is very low (≈37% movement). */
export const MAX_DELTA_MU_LONG_QUESTION = 1.2;
/** Written questions: max mu change when confidence is normal (≈15% movement); 37% only if very low confidence. */
export const MAX_DELTA_MU_LONG_QUESTION_NORMAL = 0.5;
/** Cap per-question mu change so no single answer moves mastery by more than ~10–12% (normal, non-long). */
export const MAX_DELTA_MU_PER_QUESTION = 0.35;
export const MIN_DELTA_MU_PER_QUESTION = -0.35;
/** Only when confidence is extremely low: allow slightly larger move, but still cap at ~20–25%. */
export const MAX_DELTA_MU_LOW_CONFIDENCE = 0.6;
export const MIN_DELTA_MU_LOW_CONFIDENCE = -0.6;
/** Confidence below this uses the low-confidence cap (e.g. 0.25 = "very unsure"). */
export const LOW_CONFIDENCE_THRESHOLD = 0.3;
/** Minimum mu-delta for any correct answer so mastery always moves after each question. */
export const MIN_DELTA_MU_CORRECT_ANY = 0.06;
/** Lower minimum delta for MCQ/TF only — prevents grinding to high mastery with only multiple choice. */
export const MIN_DELTA_MU_CORRECT_MCQ_TF = 0.02;
/** Above this mu, correct MCQ/TF deltas are scaled down so high mastery requires long-form or exam. */
export const MU_THRESHOLD_MCQ_TF_DISCOUNT = 1.0;
/** Scale factor for MCQ/TF delta when mu > MU_THRESHOLD_MCQ_TF_DISCOUNT (e.g. 0.5 = half impact). */
export const MCQ_TF_DELTA_SCALE_AT_HIGH_MU = 0.45;
/** Minimum mu-delta magnitude for any wrong answer so mastery always drops in real time, even at high mastery. */
export const MIN_DELTA_MU_WRONG_ANY = 0.1;

/** When correct, cap effective expected prob so delta stays substantial at high mastery (weaker diminishing returns). Lower = more responsive. */
export const CAP_EXPECTED_FOR_CORRECT = 0.62;

/** Exam delta multiplier: exams are weighted heavily as a strong signal of real-time mastery. */
export const EXAM_DELTA_MULTIPLIER = 8.0;
/** Max extra factor from outperforming expectation: 1 + (outcome - expected) / n, capped here. */
export const EXAM_PERFORMANCE_FACTOR_CAP = 2.5;

/** Default uncertainty for question difficulty */
export const DEFAULT_QUESTION_PHI = 1.5;
