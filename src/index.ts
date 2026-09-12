/**
 * Framework-independent adaptive mastery estimation.
 *
 * The engine combines item-response scoring, rating uncertainty, and
 * spaced-repetition decay. It stores no data and makes no network requests.
 */

export { MasteryService } from './mastery-service';
export type {
  ExamInteraction,
  FlashcardInteraction,
  Interaction,
  InteractionResult,
  IRTParameters,
  MasteryBreakdown,
  PracticeInteraction,
  QuestionDifficulty,
  QuestionType,
  TopicHealthReport,
  TopicMasteryState,
} from './types';
export {
  COLD_START_PHI,
  DEFAULT_DIFFICULTY,
  DEFAULT_PHI,
  DEFAULT_QUESTION_PHI,
  DEFAULT_SIGMA,
  DEFAULT_STABILITY,
  FLASHCARD_MU_WEIGHT,
  FSRS_WEIGHTS,
  GLICKO_TAU,
  IRT_PARAMS,
  MAX_MU,
  MIN_MU,
  QUESTION_UPDATE_K,
  TIME_DECAY_THRESHOLD_MINUTES,
} from './constants';
