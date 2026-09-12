/**
 * Public types for the adaptive mastery engine.
 *
 * Core state interface for tracking topic mastery using a hybrid of:
 * - Glicko-2 (mu, phi, sigma)
 * - 3PL IRT (Item Response Theory)
 * - FSRS 4.5.1 (Free Spaced Repetition Scheduler)
 */

export interface TopicMasteryState {
  /** Ability rating in logit space. Clamped to [-4, 6]; defaults to 0. */
  mu: number;

  /** Rating Deviation / Uncertainty (Glicko-2 phi) - default 2.02 */
  phi: number;

  /** Volatility / Consistency (Glicko-2 sigma) - default 0.06 */
  sigma: number;

  /** FSRS memory strength in days - default 0.1 */
  stability: number;

  /** FSRS topic difficulty - default 5.0 */
  difficulty: number;

  /** Timestamp of last interaction */
  lastSeenAt: Date;
}

/**
 * Question types for IRT parameter selection
 */
export type QuestionType = "TF" | "MCQ" | "LONG";

/**
 * IRT parameters for different question types
 */
export interface IRTParameters {
  /** Discrimination parameter (a) */
  a: number;
  /** Guessing parameter (c) */
  c: number;
}

/**
 * Practice question interaction
 */
export interface PracticeInteraction {
  type: "practice";
  correct: boolean;
  questionType: QuestionType;
  userConfidence: number; // 0 to 1
  difficulty?: number; // Optional difficulty rating
  responseTimeMs?: number; // Response time in milliseconds
  targetTimeMs?: number; // Target time in milliseconds for this question
  /** Long response only: marks earned (used for partial credit instead of binary correct) */
  score?: number;
  /** Long response only: total marks available (used with score for outcome = score/totalMarks) */
  totalMarks?: number;
  /** Consecutive correct answers for this topic (used for streak bonus so many correct in a row move mastery more) */
  correctStreak?: number;
}

/**
 * Exam interaction (batch of 15+ questions)
 */
export interface ExamInteraction {
  type: "exam";
  questions: Array<{
    correct: boolean;
    questionType: QuestionType;
    difficulty?: number;
    responseTimeMs?: number; // Response time in milliseconds
    targetTimeMs?: number; // Target time in milliseconds for this question
  }>;
}

/**
 * Flashcard interaction (FSRS grade)
 */
export interface FlashcardInteraction {
  type: "flashcard";
  grade: 1 | 2 | 3 | 4; // FSRS grade: 1=Fail, 2=Hard, 3=Good, 4=Easy
}

/**
 * Union type for all interaction types
 */
export type Interaction =
  PracticeInteraction | ExamInteraction | FlashcardInteraction;

/**
 * Result of processing an interaction
 */
export interface InteractionResult {
  /** Mastery score before update (1-100) */
  oldScore: number;
  /** Mastery score after update (1-100) */
  newScore: number;
  /** Change in mastery score */
  delta: number;
  /** Updated state */
  state: TopicMasteryState;
  /** Updated question difficulty (if provided) */
  updatedQuestionDifficulty?: QuestionDifficulty;
}

/**
 * Mastery score breakdown
 */
export interface MasteryBreakdown {
  /** Final mastery score (1-100) */
  mastery: number;
  /** Potential score (ability if tested right now) */
  potential: number;
  /** Retrievability (how much has decayed) */
  retrievability: number;
  /** Days elapsed since last practice */
  daysElapsed: number;
}

/**
 * Question difficulty state for self-calibration
 */
export interface QuestionDifficulty {
  /** IRT difficulty parameter (b) in logit scale */
  b: number;
  /** Uncertainty in difficulty estimate (similar to phi) */
  phi: number;
}

/**
 * Comprehensive topic health report
 */
export interface TopicHealthReport {
  /** Mastery score (1-100) */
  masteryPercent: number;
  /** Whether the user is ready for an exam (phi < 1.0 and mu > 1.5) */
  isExamReady: boolean;
  /** Memory health status based on retrievability */
  memoryHealth: "Fresh" | "Fading" | "Forgotten";
  /** Consistency level based on volatility */
  consistencyLevel: "Erratic" | "Steady" | "Expert";
  /** Days until score drops below 90% of current value */
  daysUntilDecay: number;
  /** Human-readable study advice based on current state */
  studyAdvice: string;
  /** Predicted exam score (0-100) based on (mu × R) */
  predictedExamScore: number;
  /** Additional diagnostic information */
  diagnostics: {
    mu: number;
    phi: number;
    sigma: number;
    stability: number;
    potential: number;
    retrievability: number;
    daysElapsed: number;
  };
}
