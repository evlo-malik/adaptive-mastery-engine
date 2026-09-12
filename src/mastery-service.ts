/**
 * Adaptive Mastery Engine
 *
 * Combines ideas from rating systems, 3PL IRT, and spaced-repetition models
 * to calculate practical mastery estimates.
 *
 * Mathematical Foundations:
 * 1. Glicko-2: Tracks ability (mu), uncertainty (phi), and volatility (sigma)
 * 2. 3PL IRT: Models probability of correct answer: E = c + (1-c) / (1 + exp(-a * (mu - b)))
 * 3. FSRS 4.5.1: Tracks memory stability and difficulty for spaced repetition
 * 4. Mastery Score: Potential × Retrievability, where:
 *    - Potential = 100 / (1 + exp(-mu))
 *    - Retrievability = (1 + daysElapsed / (9 * stability))^(-1)
 */

import type {
  TopicMasteryState,
  Interaction,
  PracticeInteraction,
  ExamInteraction,
  FlashcardInteraction,
  InteractionResult,
  MasteryBreakdown,
} from "./types";
import {
  DEFAULT_PHI,
  DEFAULT_SIGMA,
  DEFAULT_STABILITY,
  DEFAULT_DIFFICULTY,
  COLD_START_PHI,
  TIME_DECAY_THRESHOLD_MINUTES,
  FSRS_WEIGHTS,
  IRT_PARAMS,
  FLASHCARD_MU_WEIGHT,
  MAX_MU,
  MIN_MU,
  QUESTION_UPDATE_K,
  LONG_RESPONSE_BOOST_BASE,
  MIN_DELTA_MU_CORRECT_LONG,
  MAX_REWARD_MU_LONG,
  MAX_PENALTY_MU_LONG,
  MIN_DELTA_MU_LONG_QUESTION,
  MAX_DELTA_MU_LONG_QUESTION,
  MAX_DELTA_MU_LONG_QUESTION_NORMAL,
  MAX_DELTA_MU_PER_QUESTION,
  MIN_DELTA_MU_PER_QUESTION,
  MAX_DELTA_MU_LOW_CONFIDENCE,
  MIN_DELTA_MU_LOW_CONFIDENCE,
  LOW_CONFIDENCE_THRESHOLD,
  MIN_DELTA_MU_CORRECT_ANY,
  MIN_DELTA_MU_CORRECT_MCQ_TF,
  MU_THRESHOLD_MCQ_TF_DISCOUNT,
  MCQ_TF_DELTA_SCALE_AT_HIGH_MU,
  MIN_DELTA_MU_WRONG_ANY,
  CAP_EXPECTED_FOR_CORRECT,
  EXAM_DELTA_MULTIPLIER,
  EXAM_PERFORMANCE_FACTOR_CAP,
  STREAK_BONUS_PER_CORRECT,
  MAX_STREAK_FOR_BONUS,
  STREAK_MIN_SCALE,
} from "./constants";

export class MasteryService {
  /**
   * Create a default state for a new topic
   * Uses "Cold Start" with high phi to ensure large deltas on first answers
   */
  static createDefaultState(): TopicMasteryState {
    return {
      mu: 0.0,
      phi: COLD_START_PHI, // High uncertainty for cold start
      sigma: DEFAULT_SIGMA,
      stability: DEFAULT_STABILITY,
      difficulty: DEFAULT_DIFFICULTY,
      lastSeenAt: new Date(),
    };
  }

  /**
   * Process an interaction and update the mastery state
   *
   * @param userState Current mastery state
   * @param interaction The interaction to process
   * @param questionDifficulty Optional question difficulty to update (self-calibration)
   * @returns Updated state and score change, plus updated question difficulty if provided
   */
  static processInteraction(
    userState: TopicMasteryState,
    interaction: Interaction,
    questionDifficulty?: import("./types").QuestionDifficulty,
  ): InteractionResult {
    // Sanitize input state first to prevent NaN propagation
    const sanitizedState = this.sanitizeState(userState);

    // Apply time decay if needed
    const stateWithDecay = this.applyTimeDecay(sanitizedState);

    // Sanitize again after time decay (in case decay produced invalid values)
    const safeStateWithDecay = this.sanitizeState(stateWithDecay);

    const oldScore = this.getDisplayScore(safeStateWithDecay);
    let updatedState: TopicMasteryState;
    let updatedQuestionDifficulty:
      import("./types").QuestionDifficulty | undefined;

    switch (interaction.type) {
      case "practice":
        updatedState = this.updateFromPractice(safeStateWithDecay, interaction);
        // Sanitize updated state to ensure no NaN values
        updatedState = this.sanitizeState(updatedState);
        // Perform reverse update on question difficulty if provided
        if (questionDifficulty && interaction.questionType) {
          updatedQuestionDifficulty = this.updateQuestionDifficulty(
            questionDifficulty,
            updatedState.mu,
            interaction.correct,
            interaction.questionType,
          );
        }
        break;
      case "exam":
        updatedState = this.updateFromExam(safeStateWithDecay, interaction);
        // Sanitize updated state to ensure no NaN values
        updatedState = this.sanitizeState(updatedState);
        // For exams, we could update difficulty based on aggregate performance
        // For now, we'll skip exam-level difficulty updates
        break;
      case "flashcard":
        updatedState = this.updateFromFlashcard(
          safeStateWithDecay,
          interaction,
        );
        // Sanitize updated state to ensure no NaN values
        updatedState = this.sanitizeState(updatedState);
        break;
      default:
        updatedState = safeStateWithDecay;
    }

    const newScore = this.getDisplayScore(updatedState);
    const delta = newScore - oldScore;

    return {
      oldScore,
      newScore,
      delta,
      state: updatedState,
      updatedQuestionDifficulty,
    };
  }

  /**
   * Update state from a single practice question
   *
   * Uses 3PL IRT formula: E = c + (1-c) / (1 + exp(-a * (mu - b)))
   *
   * Special handling:
   * - If userConfidence < 0.4, multiply phi by 1.5 before update (High Delta)
   * - Different IRT parameters for TF, MCQ, LONG
   *
   * @param state Current state
   * @param interaction Practice question interaction
   * @returns Updated state
   */
  static updateFromPractice(
    state: TopicMasteryState,
    interaction: PracticeInteraction,
  ): TopicMasteryState {
    const {
      correct,
      questionType,
      userConfidence,
      difficulty = 0,
    } = interaction;

    // Validate questionType
    if (!questionType || !(questionType in IRT_PARAMS)) {
      console.error(
        "[MasteryService] Invalid questionType:",
        questionType,
        "Available:",
        Object.keys(IRT_PARAMS),
      );
      // Return state unchanged if question type is invalid
      return {
        ...state,
        lastSeenAt: new Date(),
      };
    }

    // Get IRT parameters for question type
    const { a, c } = IRT_PARAMS[questionType];

    // Validate IRT parameters
    if (!isFinite(a) || !isFinite(c) || a <= 0 || c < 0 || c > 1) {
      console.error("[MasteryService] Invalid IRT parameters:", {
        a,
        c,
        questionType,
      });
      // Return state unchanged if IRT parameters are invalid
      return {
        ...state,
        lastSeenAt: new Date(),
      };
    }

    // Validate and sanitize difficulty
    const safeDifficulty =
      isFinite(difficulty) && difficulty >= 0 && difficulty <= 100
        ? difficulty
        : 50; // Default to medium difficulty

    // Map difficulty to IRT b parameter (assuming difficulty is 0-100 scale)
    // b represents item difficulty in logit space
    const b = safeDifficulty / 50.0 - 1.0; // Map 0-100 to approximately -1 to 1

    // Validate b
    if (!isFinite(b)) {
      console.error("[MasteryService] Invalid b calculated:", {
        b,
        safeDifficulty,
        difficulty,
      });
      return {
        ...state,
        lastSeenAt: new Date(),
      };
    }

    // Apply confidence-based phi adjustment for "High Delta" effect
    // Low confidence acts as a volatility multiplier
    let adjustedPhi = state.phi;
    if (userConfidence < 0.4) {
      if (correct) {
        // Low confidence but correct -> high uncertainty, big jump
        // Increase phi more aggressively to ensure at least 1.4x boost
        adjustedPhi = state.phi * 1.6; // Increased from 1.5 to 1.6
      } else {
        // Low confidence and incorrect -> mitigate penalty
        // Reduce phi slightly to reduce the impact of the failure
        // This reflects that admitting uncertainty is less damning
        adjustedPhi = state.phi * 0.9; // Slightly reduce uncertainty to mitigate penalty
      }
    }

    // Calculate expected probability using 3PL IRT
    const expectedProb = this.calculateIRTProbability(state.mu, a, b, c);

    // Calculate outcome: use partial credit for long response when score/totalMarks provided
    let outcome: number;
    if (
      interaction.questionType === "LONG" &&
      interaction.score != null &&
      interaction.totalMarks != null &&
      interaction.totalMarks > 0
    ) {
      outcome = Math.max(
        0,
        Math.min(1, interaction.score / interaction.totalMarks),
      );
    } else {
      outcome = correct ? 1.0 : 0.0;
    }

    // Calculate Fisher Information (measure of how informative this question is)
    const information = this.calculateFisherInformation(state.mu, a, b, c);

    // Glicko-2 update for mu (ability)
    // Using simplified Glicko-2 update for single question

    // Guard against invalid adjustedPhi before calculating g
    if (!isFinite(adjustedPhi) || adjustedPhi <= 0) {
      console.error("[MasteryService] Invalid adjustedPhi:", {
        adjustedPhi: String(adjustedPhi),
        statePhi: String(state.phi),
        userConfidence: interaction.userConfidence,
      });
      // Return state with slightly increased uncertainty
      const fallbackPhi = Math.sqrt(Math.min(state.phi * state.phi * 1.1, 4.0));
      return {
        ...state,
        phi: Math.max(0.1, Math.min(fallbackPhi, 4.0)),
        lastSeenAt: new Date(),
      };
    }

    const g = this.glickoG(adjustedPhi);

    // Guard against invalid g
    if (!isFinite(g) || g <= 0) {
      console.error("[MasteryService] Invalid g calculated:", {
        g: String(g),
        adjustedPhi: String(adjustedPhi),
      });
      // Return state with slightly increased uncertainty
      const fallbackPhi = Math.sqrt(
        Math.min(adjustedPhi * adjustedPhi * 1.1, 4.0),
      );
      return {
        ...state,
        phi: Math.max(0.1, Math.min(fallbackPhi, 4.0)),
        lastSeenAt: new Date(),
      };
    }

    // When correct/partial, cap effective expected so delta stays substantial at high mastery (weaker diminishing returns)
    const effectiveExpected =
      outcome > 0 && expectedProb > CAP_EXPECTED_FOR_CORRECT
        ? CAP_EXPECTED_FOR_CORRECT
        : expectedProb;
    const expectedScore = effectiveExpected;

    // Guard against invalid expectedProb
    if (!isFinite(expectedProb) || expectedProb < 0 || expectedProb > 1) {
      console.error("[MasteryService] Invalid expectedProb:", {
        expectedProb: String(expectedProb),
        stateMu: String(state.mu),
        a: String(a),
        b: String(b),
        c: String(c),
      });
      // Return state with slightly increased uncertainty
      const fallbackPhi = Math.sqrt(
        Math.min(adjustedPhi * adjustedPhi * 1.1, 4.0),
      );
      return {
        ...state,
        phi: Math.max(0.1, Math.min(fallbackPhi, 4.0)),
        lastSeenAt: new Date(),
      };
    }

    // Guard against invalid information (0, NaN, Infinity)
    // If information is too small, use a minimum value to prevent division by zero
    const safeInformation = Math.max(information, 1e-6); // Minimum information threshold
    let variance = 1.0 / (g * g * safeInformation);

    // Guard against invalid variance (NaN, Infinity)
    if (!isFinite(variance) || variance <= 0) {
      console.warn("[MasteryService] Invalid variance calculated:", {
        variance: String(variance),
        g: String(g),
        information: String(information),
        safeInformation: String(safeInformation),
      });
      variance = adjustedPhi * adjustedPhi; // Use phi^2 as fallback
    }

    // Calculate base delta
    // Guard against division by zero or invalid values
    const phiTerm = 1.0 / (adjustedPhi * adjustedPhi);
    const varianceTerm = 1.0 / variance;
    const denominator = phiTerm + varianceTerm;

    if (!isFinite(denominator) || denominator <= 0) {
      console.error(
        "[MasteryService] Invalid denominator in delta calculation:",
        {
          phiTerm,
          varianceTerm,
          denominator,
          adjustedPhi,
          variance,
          information,
        },
      );
      // Return state with only phi update to prevent corruption
      const fallbackPhi = Math.sqrt(
        Math.min(adjustedPhi * adjustedPhi * 1.1, 4.0),
      ); // Slight increase in uncertainty
      return {
        ...state,
        phi: Math.max(0.1, Math.min(fallbackPhi, 4.0)),
        lastSeenAt: new Date(),
      };
    }

    let delta = (1.0 / denominator) * g * (outcome - expectedScore);

    // Guard against invalid delta
    if (!isFinite(delta)) {
      // Use a try-catch to ensure we can log even if some values are problematic
      try {
        const logData: Record<string, number | string> = {
          delta: isNaN(delta) ? "NaN" : isFinite(delta) ? delta : "Infinity",
          g: isNaN(g) ? "NaN" : isFinite(g) ? g : "Infinity",
          outcome: isNaN(outcome)
            ? "NaN"
            : isFinite(outcome)
              ? outcome
              : "Infinity",
          expectedScore: isNaN(expectedScore)
            ? "NaN"
            : isFinite(expectedScore)
              ? expectedScore
              : "Infinity",
          expectedProb: isNaN(expectedProb)
            ? "NaN"
            : isFinite(expectedProb)
              ? expectedProb
              : "Infinity",
          denominator: isNaN(denominator)
            ? "NaN"
            : isFinite(denominator)
              ? denominator
              : "Infinity",
          phiTerm: isNaN(phiTerm)
            ? "NaN"
            : isFinite(phiTerm)
              ? phiTerm
              : "Infinity",
          varianceTerm: isNaN(varianceTerm)
            ? "NaN"
            : isFinite(varianceTerm)
              ? varianceTerm
              : "Infinity",
          variance: isNaN(variance)
            ? "NaN"
            : isFinite(variance)
              ? variance
              : "Infinity",
          information: isNaN(information)
            ? "NaN"
            : isFinite(information)
              ? information
              : "Infinity",
          safeInformation: isNaN(safeInformation)
            ? "NaN"
            : isFinite(safeInformation)
              ? safeInformation
              : "Infinity",
          adjustedPhi: isNaN(adjustedPhi)
            ? "NaN"
            : isFinite(adjustedPhi)
              ? adjustedPhi
              : "Infinity",
          stateMu: isNaN(state.mu)
            ? "NaN"
            : isFinite(state.mu)
              ? state.mu
              : "Infinity",
          statePhi: isNaN(state.phi)
            ? "NaN"
            : isFinite(state.phi)
              ? state.phi
              : "Infinity",
          a: isNaN(a) ? "NaN" : isFinite(a) ? a : "Infinity",
          b: isNaN(b) ? "NaN" : isFinite(b) ? b : "Infinity",
          c: isNaN(c) ? "NaN" : isFinite(c) ? c : "Infinity",
          correct: String(correct),
          questionType: interaction.questionType || "unknown",
        };
        console.error("[MasteryService] Invalid delta calculated:", logData);

        // Additional diagnostic checks
        if (!isFinite(g)) {
          console.error(
            "[MasteryService] g is invalid:",
            g,
            "for adjustedPhi:",
            adjustedPhi,
          );
        }
        if (!isFinite(expectedProb)) {
          console.error(
            "[MasteryService] expectedProb is invalid:",
            expectedProb,
            "for mu:",
            state.mu,
            "a:",
            a,
            "b:",
            b,
            "c:",
            c,
          );
        }
        if (!isFinite(information)) {
          console.error(
            "[MasteryService] information is invalid:",
            information,
            "for mu:",
            state.mu,
            "a:",
            a,
            "b:",
            b,
            "c:",
            c,
          );
        }
        if (!isFinite(denominator)) {
          console.error(
            "[MasteryService] denominator is invalid:",
            denominator,
            "phiTerm:",
            phiTerm,
            "varianceTerm:",
            varianceTerm,
          );
        }
      } catch (logError) {
        console.error(
          "[MasteryService] Failed to log error details:",
          logError,
        );
        console.error(
          "[MasteryService] Invalid delta calculated - unable to serialize values",
        );
      }

      delta = 0; // No change if calculation failed
    }

    // Adjust for guessing parameter: when c > 0, only (1-c) of the outcome
    // is due to ability, not guessing. Weight the update accordingly.
    // This ensures that getting a TF question right gives a smaller boost
    // than getting a LONG question right, because part of TF success is luck.
    if (c > 0) {
      if (correct) {
        // For correct answers with guessing, scale more aggressively
        // Use (1-c)^2 to ensure TF questions give smaller boosts
        delta = delta * (1 - c) * (1 - c);
      } else {
        // For incorrect answers, keep full penalty (guessing makes failure worse)
        // Don't scale - missing a question with 50% guess chance is very bad
      }
    }

    // Apply fluency multiplier if response time is provided
    let fluencyMultiplier = 1.0;
    if (
      interaction.responseTimeMs !== undefined &&
      interaction.targetTimeMs !== undefined
    ) {
      fluencyMultiplier = this.calculateFluencyMultiplier(
        interaction.responseTimeMs,
        interaction.targetTimeMs,
      );

      // If fluency multiplier is 0 (very fast response <500ms), treat as possible mis-click only for *correct* answers.
      if (fluencyMultiplier === 0 && correct) {
        const phiDenominator = phiTerm + varianceTerm;
        const newPhi =
          isFinite(phiDenominator) && phiDenominator > 0
            ? Math.sqrt(1.0 / phiDenominator)
            : Math.sqrt(Math.min(adjustedPhi * adjustedPhi * 1.1, 4.0)); // Fallback
        return {
          ...state,
          phi: Math.max(0.1, Math.min(newPhi, 4.0)), // Clamp phi to valid range
          lastSeenAt: new Date(),
        };
      }
      // Apply fluency multiplier only when correct. Wrong answers keep full penalty so 0/5 always affects mastery.
      delta = delta * (correct ? fluencyMultiplier : 1.0);

      // Re-check delta after fluency multiplier
      if (!isFinite(delta)) {
        console.warn(
          "[MasteryService] Delta became invalid after fluency multiplier:",
          { delta, fluencyMultiplier },
        );
        delta = 0;
      }
    }

    // Long-response: scale delta by question weight (totalMarks) and outcome so harder/longer questions and full marks matter more
    if (interaction.questionType === "LONG" && delta > 0 && outcome > 0) {
      const totalMarks = Math.max(1, Math.min(10, interaction.totalMarks ?? 5));
      const marksWeight = totalMarks / 5; // 5-marker = 1x, 4-marker = 0.8x, 10-marker = 2x
      delta = delta * LONG_RESPONSE_BOOST_BASE * marksWeight * outcome;
      delta = Math.max(delta, MIN_DELTA_MU_CORRECT_LONG); // Guarantee visible move so mastery feels real-time
      delta = Math.min(delta, MAX_REWARD_MU_LONG); // Cap so one question can't jump 12%→100%
    } else if (
      interaction.questionType === "LONG" &&
      delta < 0 &&
      (outcome === 0 || (interaction.score != null && interaction.score === 0))
    ) {
      // 0/5 long-response: apply penalty but cap so one wrong answer can't tank 98%→2%
      const totalMarks = Math.max(1, Math.min(10, interaction.totalMarks ?? 5));
      const marksWeight = totalMarks / 5;
      delta = delta * LONG_RESPONSE_BOOST_BASE * marksWeight;
      delta = Math.min(delta, -MIN_DELTA_MU_CORRECT_LONG); // Minimum penalty = same magnitude as min boost
      delta = Math.max(delta, -MAX_PENALTY_MU_LONG); // Cap penalty so one question doesn't wipe mastery
    } else {
      // MCQ/TF: at high ability, scale down correct delta so high mastery requires long-form or exam
      const isMcqOrTf =
        interaction.questionType === "MCQ" || interaction.questionType === "TF";
      if (
        correct &&
        delta > 0 &&
        isMcqOrTf &&
        state.mu > MU_THRESHOLD_MCQ_TF_DISCOUNT
      ) {
        delta = delta * MCQ_TF_DELTA_SCALE_AT_HIGH_MU;
      }
      if (correct && delta > 0) {
        // Long gets full min; MCQ/TF get lower min so grinding MCQ/TF alone doesn't push mastery too high
        const minCorrect = isMcqOrTf
          ? MIN_DELTA_MU_CORRECT_MCQ_TF
          : MIN_DELTA_MU_CORRECT_ANY;
        delta = Math.max(delta, minCorrect);
      } else if (!correct && delta < 0) {
        // Any wrong answer (MCQ/TF or LONG partial): ensure visible drop in real time, even at high mastery
        delta = Math.min(delta, -MIN_DELTA_MU_WRONG_ANY);
      }
    }

    // Streak bonus: many correct in a row should keep moving mastery up (real-time representation)
    const streakCount = interaction.correctStreak ?? 0;
    if (correct && delta > 0 && streakCount >= 2) {
      const streak = Math.min(streakCount - 1, MAX_STREAK_FOR_BONUS - 1);
      delta = delta * (1 + STREAK_BONUS_PER_CORRECT * streak);
    }
    // Streak-based floor: on long correct streaks, guarantee a minimum move so mastery stays responsive
    if (correct && delta > 0 && streakCount >= 4) {
      const isMcqOrTfStreak =
        interaction.questionType === "MCQ" || interaction.questionType === "TF";
      const baseMin =
        interaction.questionType === "LONG" && interaction.totalMarks != null
          ? MIN_DELTA_MU_CORRECT_LONG
          : isMcqOrTfStreak
            ? MIN_DELTA_MU_CORRECT_MCQ_TF
            : MIN_DELTA_MU_CORRECT_ANY;
      const streakExtra = Math.min(streakCount - 3, 7);
      const floor = baseMin * (1 + STREAK_MIN_SCALE * streakExtra);
      delta = Math.max(delta, floor);
    }

    // Per-question delta cap: written 7% min; 37% max only when very low confidence, else ~15%
    const isExtremelyLowConfidence =
      (interaction as PracticeInteraction).userConfidence !== undefined &&
      (interaction as PracticeInteraction).userConfidence <
        LOW_CONFIDENCE_THRESHOLD;
    if (interaction.questionType === "LONG") {
      const longCap = isExtremelyLowConfidence
        ? MAX_DELTA_MU_LONG_QUESTION
        : MAX_DELTA_MU_LONG_QUESTION_NORMAL;
      if (delta >= 0) {
        delta = Math.max(MIN_DELTA_MU_LONG_QUESTION, Math.min(longCap, delta));
      } else {
        delta = Math.max(
          -longCap,
          Math.min(-MIN_DELTA_MU_LONG_QUESTION, delta),
        );
      }
    } else {
      const cap = isExtremelyLowConfidence
        ? MAX_DELTA_MU_LOW_CONFIDENCE
        : MAX_DELTA_MU_PER_QUESTION;
      const floor = isExtremelyLowConfidence
        ? MIN_DELTA_MU_LOW_CONFIDENCE
        : MIN_DELTA_MU_PER_QUESTION;
      delta = Math.max(floor, Math.min(cap, delta));
    }

    // Update mu with clamping
    const newMu = Math.max(MIN_MU, Math.min(MAX_MU, state.mu + delta));

    // Update phi (reduce uncertainty after answering)
    // Use calculated variance to prevent NaN/Infinity
    const phiDenominator = phiTerm + varianceTerm;
    let newPhi: number;
    if (isFinite(phiDenominator) && phiDenominator > 0) {
      newPhi = Math.sqrt(1.0 / phiDenominator);
    } else {
      // Fallback: slight increase in uncertainty
      newPhi = Math.sqrt(Math.min(adjustedPhi * adjustedPhi * 1.1, 4.0));
      console.warn(
        "[MasteryService] Invalid phi calculation, using fallback:",
        {
          phiTerm,
          varianceTerm,
          phiDenominator,
          variance,
        },
      );
    }
    // Clamp phi to valid range
    newPhi = Math.max(0.1, Math.min(newPhi, 4.0));

    // Cross-pollination: Practice failures should reduce FSRS stability
    // Failing to apply knowledge in practice implies memory stability was overestimated
    let newStability = state.stability;
    let newDifficulty = state.difficulty;

    if (!correct) {
      // Practice failure → treat as FSRS "Again" (grade 1)
      // This creates cross-pollination: Glicko failures → FSRS stability reduction
      const w = FSRS_WEIGHTS;

      // Apply FSRS failure logic (grade 1 = Again)
      if (state.stability > DEFAULT_STABILITY) {
        // Update stability using FSRS failure formula
        newStability =
          w[12] *
          Math.pow(state.difficulty, -w[13]) *
          Math.pow(state.stability, -w[14]) *
          Math.exp((1 - w[15]) * w[16]);
        newStability = Math.max(0.1, newStability);

        // Update difficulty (failure increases difficulty)
        const nextD = state.difficulty - w[6] * (1 - 3); // grade 1, so (1-3) = -2
        newDifficulty = Math.max(
          1.0,
          Math.min(10.0, w[7] * state.difficulty + (1 - w[7]) * nextD),
        );
      }
    }

    // Update last seen
    const newState: TopicMasteryState = {
      ...state,
      mu: newMu,
      phi: newPhi,
      stability: newStability,
      difficulty: newDifficulty,
      lastSeenAt: new Date(),
    };

    return newState;
  }

  /**
   * Update state from a full exam (batch of 15+ questions)
   *
   * Uses Glicko-2 Rating Period logic:
   * - Calculate aggregate outcome vs expected score
   * - Apply Glicko-2 volatility update (Illinois algorithm) to refine sigma
   * - Drastically reduce phi after exam to "lock in" the score
   *
   * @param state Current state
   * @param interaction Exam interaction
   * @returns Updated state
   */
  static updateFromExam(
    state: TopicMasteryState,
    interaction: ExamInteraction,
  ): TopicMasteryState {
    const { questions } = interaction;

    if (questions.length < 15) {
      // If less than 15 questions, treat as practice questions
      // (Could also throw error or handle differently)
      let currentState = state;
      for (const q of questions) {
        const practiceInteraction: PracticeInteraction = {
          type: "practice",
          correct: q.correct,
          questionType: q.questionType,
          userConfidence: 0.5, // Default confidence for exam questions
          difficulty: q.difficulty,
        };
        currentState = this.updateFromPractice(
          currentState,
          practiceInteraction,
        );
      }
      return currentState;
    }

    // Calculate aggregate statistics; weight outcome by question type (LONG > MCQ > TF) so difficulty/type matter
    let totalExpected = 0;
    let totalOutcome = 0;
    let totalInformation = 0;
    const outcomeWeight = (qt: string) =>
      qt === "LONG" ? 1.3 : qt === "MCQ" ? 1.1 : 1.0;

    for (const q of questions) {
      const { a, c } = IRT_PARAMS[q.questionType];
      const b = q.difficulty ? q.difficulty / 50.0 - 1.0 : 0;

      const expectedProb = this.calculateIRTProbability(state.mu, a, b, c);
      const information = this.calculateFisherInformation(state.mu, a, b, c);

      totalExpected += expectedProb;
      totalOutcome += q.correct ? outcomeWeight(q.questionType) : 0;
      totalInformation += information;
    }

    // Glicko-2 batch update
    const g = this.glickoG(state.phi);
    const variance = 1.0 / (g * g * totalInformation);
    let delta =
      (1.0 / (1.0 / (state.phi * state.phi) + 1.0 / variance)) *
      g *
      (totalOutcome - totalExpected);

    // Exam boost: high scores and outperforming expectation GREATLY increase mastery
    const n = questions.length;
    const outperformance = (totalOutcome - totalExpected) / Math.max(1, n);
    const performanceFactor =
      outperformance > 0
        ? Math.min(EXAM_PERFORMANCE_FACTOR_CAP, 1 + outperformance)
        : 1.0;
    delta = delta * EXAM_DELTA_MULTIPLIER * performanceFactor;

    // Update mu
    const newMu = Math.max(MIN_MU, Math.min(MAX_MU, state.mu + delta));

    // Update volatility (sigma) using Illinois algorithm
    const newSigma = this.updateVolatility(
      state.mu,
      state.phi,
      state.sigma,
      totalOutcome,
      totalExpected,
      totalInformation,
    );

    // Update phi (drastically reduce after exam to "lock in" score)
    const newPhi = Math.sqrt(
      1.0 / (1.0 / (state.phi * state.phi) + 1.0 / variance),
    );
    // Additional reduction for exam completion
    const lockedPhi = newPhi * 0.5; // Reduce by 50% to lock in

    return {
      ...state,
      mu: newMu,
      phi: lockedPhi,
      sigma: newSigma,
      lastSeenAt: new Date(),
    };
  }

  /**
   * Update state from a flashcard review
   *
   * Uses FSRS 4.5.1 algorithm to update stability and difficulty.
   * Updates mu with low weighting (w=0.25) to track memory retention
   * without over-inflating ability.
   *
   * @param state Current state
   * @param interaction Flashcard interaction
   * @returns Updated state
   */
  static updateFromFlashcard(
    state: TopicMasteryState,
    interaction: FlashcardInteraction,
  ): TopicMasteryState {
    const { grade } = interaction; // 1=Fail, 2=Hard, 3=Good, 4=Easy
    const w = FSRS_WEIGHTS;
    const now = new Date();

    let newStability = state.stability;
    let newDifficulty = state.difficulty;

    // FSRS 4.5.1 update logic
    if (
      state.stability === DEFAULT_STABILITY &&
      state.difficulty === DEFAULT_DIFFICULTY
    ) {
      // First review
      newDifficulty = w[4] - (grade - 3) * w[5];
      newStability = w[0] + (grade - 1) * w[1];
    } else {
      // Update difficulty
      const nextD = state.difficulty - w[6] * (grade - 3);
      newDifficulty = Math.max(
        1.0,
        Math.min(10.0, w[7] * state.difficulty + (1 - w[7]) * nextD),
      );

      // Update stability
      if (grade >= 2) {
        // Success (Hard, Good, or Easy)
        const expFactor =
          Math.exp(w[8]) *
          (11 - state.difficulty) *
          Math.pow(state.stability, -w[9]) *
          (Math.exp((1 - w[10]) * w[11] * (grade - 1)) - 1);
        newStability = state.stability * (1 + expFactor);
        newStability = Math.min(36500.0, newStability); // Cap at 100 years
      } else {
        // Fail (grade = 1)
        newStability =
          w[12] *
          Math.pow(state.difficulty, -w[13]) *
          Math.pow(state.stability, -w[14]) *
          Math.exp((1 - w[15]) * w[16]);
        newStability = Math.max(0.1, newStability);
      }
    }

    // Update mu with low weighting
    // Map FSRS grade to ability adjustment
    // Grade 1 (Fail) -> negative, Grade 4 (Easy) -> positive
    const gradeAdjustment = (grade - 2.5) * 0.5; // Scale: -0.75 to +0.75
    // Use even lower weighting for flashcards to keep mastery in 30-40 range
    const muDelta = gradeAdjustment * FLASHCARD_MU_WEIGHT * 0.5; // Further reduced
    let newMu = Math.max(MIN_MU, Math.min(MAX_MU, state.mu + muDelta));

    // Soft cap: Flashcards alone cannot push mu beyond ~0.2 (~55% mastery)
    // This ensures flashcards build stability and basic knowledge, but
    // actual practice questions are needed to prove higher ability
    // With mu=0.2, potential ≈ 55, which with high stability gives mastery ~30-40
    const FLASHCARD_SOFT_CAP = 0.2;
    if (newMu > FLASHCARD_SOFT_CAP) {
      newMu = Math.min(newMu, FLASHCARD_SOFT_CAP);
    }

    return {
      ...state,
      mu: newMu,
      stability: newStability,
      difficulty: newDifficulty,
      lastSeenAt: now,
    };
  }

  /**
   * Apply time decay to uncertainty (phi)
   *
   * Formula: phi_new = sqrt(phi^2 + sigma^2 * ln(1 + daysElapsed * 350 / stability))
   *
   * Only applies if more than 20 minutes have passed since last interaction.
   *
   * @param state Current state
   * @returns State with updated phi if time decay applies
   */
  static applyTimeDecay(state: TopicMasteryState): TopicMasteryState {
    // Sanitize input state first
    const safeState = this.sanitizeState(state);

    const now = new Date();
    const minutesElapsed =
      (now.getTime() - safeState.lastSeenAt.getTime()) / (1000 * 60);

    if (minutesElapsed <= TIME_DECAY_THRESHOLD_MINUTES) {
      return safeState; // No decay if within threshold
    }

    const daysElapsed = minutesElapsed / (60 * 24);
    const stability = Math.max(0.1, safeState.stability);

    // Time decay formula
    const decayTerm =
      safeState.sigma *
      safeState.sigma *
      Math.log(1 + (daysElapsed * 350) / stability);

    // Guard against invalid decay term
    if (!isFinite(decayTerm) || decayTerm < 0) {
      console.warn("[MasteryService] Invalid decay term:", {
        decayTerm,
        sigma: safeState.sigma,
        stability,
        daysElapsed,
      });
      return safeState; // Return unchanged if decay calculation fails
    }

    const newPhi = Math.sqrt(safeState.phi * safeState.phi + decayTerm);

    // Guard against invalid newPhi
    if (!isFinite(newPhi) || newPhi <= 0) {
      console.warn("[MasteryService] Invalid newPhi after decay:", {
        newPhi,
        phi: safeState.phi,
        decayTerm,
      });
      return safeState; // Return unchanged if phi calculation fails
    }

    // Clamp phi to valid range
    const clampedPhi = Math.max(0.1, Math.min(newPhi, 4.0));

    return {
      ...safeState,
      phi: clampedPhi,
    };
  }

  /**
   * Calculate the display score (1-100)
   *
   * Formula:
   * - Potential = 100 / (1 + exp(-mu))
   * - Retrievability = (1 + daysElapsed / (9 * stability))^(-1)
   * - FinalMastery = Potential × Retrievability
   *
   * @param state Mastery state
   * @returns Mastery score (1-100)
   */
  static getDisplayScore(state: TopicMasteryState): number {
    // Validate and sanitize state before calculation
    const sanitizedState = this.sanitizeState(state);
    const breakdown = this.getMasteryBreakdown(sanitizedState);
    const score = Math.round(Math.max(0, Math.min(100, breakdown.mastery)));

    // Guard against NaN/Infinity
    if (!isFinite(score)) {
      console.error("[MasteryService] Invalid mastery score calculated:", {
        score,
        breakdown,
        state: sanitizedState,
      });
      return 50; // Default to 50% if calculation fails
    }

    return score;
  }

  /**
   * Sanitize state to ensure all values are valid (no NaN, Infinity, etc.)
   * This prevents cascading failures from corrupted state
   */
  static sanitizeState(state: TopicMasteryState): TopicMasteryState {
    return {
      mu: isFinite(state.mu)
        ? Math.max(MIN_MU, Math.min(MAX_MU, state.mu))
        : 0.0,
      phi:
        isFinite(state.phi) && state.phi > 0
          ? Math.max(0.1, Math.min(4.0, state.phi))
          : DEFAULT_PHI,
      sigma:
        isFinite(state.sigma) && state.sigma > 0
          ? Math.max(0.01, Math.min(0.5, state.sigma))
          : DEFAULT_SIGMA,
      stability:
        isFinite(state.stability) && state.stability > 0
          ? Math.max(0.1, Math.min(36500, state.stability))
          : DEFAULT_STABILITY,
      difficulty:
        isFinite(state.difficulty) &&
        state.difficulty >= 1 &&
        state.difficulty <= 10
          ? state.difficulty
          : DEFAULT_DIFFICULTY,
      lastSeenAt:
        state.lastSeenAt instanceof Date && !isNaN(state.lastSeenAt.getTime())
          ? state.lastSeenAt
          : new Date(),
    };
  }

  /**
   * Get detailed mastery breakdown
   *
   * @param state Mastery state
   * @returns Breakdown with potential, retrievability, and final mastery
   */
  static getMasteryBreakdown(state: TopicMasteryState): MasteryBreakdown {
    // Calculate Potential (ability if tested right now)
    const potential = 100 / (1 + Math.exp(-state.mu));

    // Calculate days elapsed
    const now = new Date();
    const daysElapsed = Math.max(
      0,
      (now.getTime() - state.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Calculate Retrievability (forgetting curve)
    const stability = Math.max(0.1, state.stability);
    const retrievability = Math.pow(1 + daysElapsed / (9 * stability), -1);

    // Final Mastery = Potential × Retrievability
    const mastery = potential * retrievability;

    return {
      mastery,
      potential,
      retrievability,
      daysElapsed,
    };
  }

  /**
   * Calculate delta (change in mastery score)
   *
   * @param oldState State before update
   * @param newState State after update
   * @returns Change in mastery score
   */
  static calculateDelta(
    oldState: TopicMasteryState,
    newState: TopicMasteryState,
  ): number {
    const oldScore = this.getDisplayScore(oldState);
    const newScore = this.getDisplayScore(newState);
    return newScore - oldScore;
  }

  /**
   * Calculate fluency multiplier based on response time
   *
   * Fluency measures how quickly and confidently a user can answer,
   * which is an indicator of true mastery vs. slow problem-solving.
   *
   * @param responseTimeMs Response time in milliseconds
   * @param targetTimeMs Target time in milliseconds for this question
   * @returns Multiplier (0 to 1.2) to apply to ability delta
   */
  static calculateFluencyMultiplier(
    responseTimeMs: number,
    targetTimeMs: number,
  ): number {
    // If response time is too fast (< 500ms), flag as mis-click/invalid
    if (responseTimeMs < 500) {
      return 0;
    }

    // If response time is within target (<= targetTime)
    if (responseTimeMs <= targetTimeMs) {
      // Linear scale from 1.2x (at 25% of target) to 1.0x (at 100% of target)
      // At 25% of target: multiplier = 1.2
      // At 100% of target: multiplier = 1.0
      // Linear interpolation: m = 1.2 - (responseTime / targetTime - 0.25) * (0.2 / 0.75)
      const ratio = responseTimeMs / targetTimeMs;
      if (ratio <= 0.25) {
        return 1.2; // Maximum bonus for very fast responses
      } else {
        // Linear interpolation from 1.2 at 25% to 1.0 at 100%
        const slope = (1.0 - 1.2) / (1.0 - 0.25); // -0.2 / 0.75
        return 1.2 + slope * (ratio - 0.25);
      }
    }

    // If response time exceeds target (> targetTime)
    // Decay from 1.0x to 0.5x, capped at 3x target time
    const maxTime = targetTimeMs * 3;
    if (responseTimeMs >= maxTime) {
      return 0.5; // Minimum multiplier for very slow responses
    }

    // Linear decay from 1.0 at targetTime to 0.5 at 3x targetTime
    const excessTime = responseTimeMs - targetTimeMs;
    const decayRange = maxTime - targetTimeMs; // 2 * targetTimeMs
    const decayAmount = (excessTime / decayRange) * 0.5; // Decay by 0.5 over the range
    return 1.0 - decayAmount;
  }

  /**
   * Get comprehensive topic health report
   *
   * Provides diagnostic information about the topic's mastery state,
   * including readiness for exams, memory health, and consistency.
   *
   * @param state Mastery state
   * @returns Comprehensive health report
   */
  static getTopicHealthReport(
    state: TopicMasteryState,
  ): import("./types").TopicHealthReport {
    const breakdown = this.getMasteryBreakdown(state);
    const masteryPercent = this.getDisplayScore(state);

    // Exam readiness: phi < 1.0 (low uncertainty) and mu > 1.5 (high ability)
    const isExamReady = state.phi < 1.0 && state.mu > 1.5;

    // Memory health based on retrievability
    // Fresh: R > 0.8, Fading: 0.5 < R <= 0.8, Forgotten: R <= 0.5
    let memoryHealth: "Fresh" | "Fading" | "Forgotten";
    if (breakdown.retrievability > 0.8) {
      memoryHealth = "Fresh";
    } else if (breakdown.retrievability > 0.5) {
      memoryHealth = "Fading";
    } else {
      memoryHealth = "Forgotten";
    }

    // Consistency level based on volatility (sigma)
    // Erratic: sigma > 0.1, Steady: 0.05 < sigma <= 0.1, Expert: sigma <= 0.05
    let consistencyLevel: "Erratic" | "Steady" | "Expert";
    if (state.sigma > 0.1) {
      consistencyLevel = "Erratic";
    } else if (state.sigma > 0.05) {
      consistencyLevel = "Steady";
    } else {
      consistencyLevel = "Expert";
    }

    // Calculate days until score drops below 90% of current value
    // Score = Potential × Retrievability
    // We need: Potential × R(t) = 0.9 × (Potential × R(0))
    // Since Potential doesn't change with time, we need: R(t) = 0.9 × R(0)
    // R(t) = (1 + t / (9 * S))^(-1)
    // 0.9 × R(0) = (1 + t / (9 * S))^(-1)
    // Solving for t: t = 9 * S * ((1 / (0.9 * R(0))) - 1)
    const currentRetrievability = breakdown.retrievability;
    const stability = Math.max(0.1, state.stability);

    let daysUntilDecay: number;
    if (currentRetrievability > 0.9) {
      // Calculate when retrievability drops to 0.9 * currentRetrievability
      const targetRetrievability = 0.9 * currentRetrievability;
      if (targetRetrievability > 0) {
        daysUntilDecay =
          9 * stability * (1 / targetRetrievability - 1) -
          breakdown.daysElapsed;
        daysUntilDecay = Math.max(0, daysUntilDecay);
      } else {
        daysUntilDecay = 0;
      }
    } else {
      // Already below 90%, so decay has started
      daysUntilDecay = 0;
    }

    // Generate human-readable study advice
    const studyAdvice = this.generateStudyAdvice(
      state.phi,
      breakdown.retrievability,
      state.sigma,
      state.mu,
      breakdown.retrievability,
    );

    // Calculate predicted exam score based on (mu × R) mapped to 0-100
    // mu is in logit scale [-4, 4], R is [0, 1]
    // We want: predictedScore = f(mu × R) where f maps to [0, 100]
    // Using sigmoid: predictedScore = 100 / (1 + exp(-mu × R))
    // This gives a score that accounts for both ability and memory retention
    const muTimesR = state.mu * breakdown.retrievability;
    const predictedExamScore = Math.round(
      Math.max(0, Math.min(100, 100 / (1 + Math.exp(-muTimesR)))),
    );

    return {
      masteryPercent,
      isExamReady,
      memoryHealth,
      consistencyLevel,
      daysUntilDecay: Math.round(daysUntilDecay * 10) / 10, // Round to 1 decimal
      studyAdvice,
      predictedExamScore,
      diagnostics: {
        mu: state.mu,
        phi: state.phi,
        sigma: state.sigma,
        stability: state.stability,
        potential: breakdown.potential,
        retrievability: breakdown.retrievability,
        daysElapsed: breakdown.daysElapsed,
      },
    };
  }

  /**
   * Generate human-readable study advice based on current state
   *
   * Provides personalized coaching messages to guide the user's study.
   *
   * @param phi Uncertainty (high = still learning)
   * @param retrievability Memory retention (low = about to forget)
   * @param sigma Volatility (high = inconsistent)
   * @param mu Ability (high = ready for exam)
   * @param R Retrievability (for fluency check)
   * @returns Human-readable study advice
   */
  private static generateStudyAdvice(
    phi: number,
    retrievability: number,
    sigma: number,
    mu: number,
    R: number,
  ): string {
    const advice: string[] = [];

    // Priority 1: High uncertainty (phi) - still learning level
    if (phi > 2.0) {
      advice.push("We're still learning your level. Keep practicing!");
    }

    // Priority 2: Low retrievability (R) - about to forget
    if (retrievability < 0.5) {
      advice.push("You're about to forget this. Review now!");
    }

    // Priority 3: High volatility (sigma) - inconsistent performance
    if (sigma > 0.1) {
      advice.push(
        "Your performance is a bit inconsistent. Try some easier foundation questions.",
      );
    }

    // Priority 4: High fluency (mu × R is high) - achieved automaticity
    // Fluency = high ability (mu > 1.5) with high retention (R > 0.8)
    if (mu > 1.5 && R > 0.8 && phi < 1.0) {
      advice.push("You've achieved automaticity! You're ready for the exam.");
    }

    // If no specific advice, provide general encouragement
    if (advice.length === 0) {
      if (mu > 0 && retrievability > 0.7) {
        advice.push("You're making good progress! Keep it up.");
      } else if (mu < 0) {
        advice.push("Start with some easier questions to build confidence.");
      } else {
        advice.push("Continue practicing to strengthen your understanding.");
      }
    }

    // Return the first (highest priority) advice, or combine if multiple
    return advice[0] ?? "Keep practicing to improve your mastery.";
  }

  // ========== Private Helper Methods ==========

  /**
   * Calculate 3PL IRT probability
   *
   * Formula: E = c + (1-c) / (1 + exp(-a * (mu - b)))
   *
   * @param mu Ability (logit scale)
   * @param a Discrimination parameter
   * @param b Difficulty parameter
   * @param c Guessing parameter
   * @returns Expected probability of correct answer
   */
  private static calculateIRTProbability(
    mu: number,
    a: number,
    b: number,
    c: number,
  ): number {
    // Validate all inputs
    if (!isFinite(mu) || !isFinite(a) || !isFinite(b) || !isFinite(c)) {
      console.warn("[MasteryService] Invalid IRT parameters:", { mu, a, b, c });
      // Return a default probability (0.5) if inputs are invalid
      return 0.5;
    }

    // Clamp c to valid range [0, 1]
    const safeC = Math.max(0, Math.min(1, c));

    try {
      const exponent = -a * (mu - b);

      // Guard against overflow/underflow in exp
      if (!isFinite(exponent)) {
        console.warn("[MasteryService] Invalid exponent in IRT:", {
          exponent,
          mu,
          a,
          b,
        });
        return safeC + (1 - safeC) * 0.5; // Default to middle probability
      }

      const expValue = Math.exp(exponent);

      // Guard against invalid exp value
      if (!isFinite(expValue)) {
        // If exponent is very negative, expValue → 0, sigmoid → 1
        // If exponent is very positive, expValue → Infinity, sigmoid → 0
        if (exponent < -700) {
          return safeC + (1 - safeC) * 1.0; // High probability
        } else if (exponent > 700) {
          return safeC + (1 - safeC) * 0.0; // Low probability (guessing only)
        }
        console.warn("[MasteryService] Invalid exp value in IRT:", {
          expValue,
          exponent,
        });
        return safeC + (1 - safeC) * 0.5; // Default to middle probability
      }

      const sigmoid = 1 / (1 + expValue);

      // Guard against invalid sigmoid
      if (!isFinite(sigmoid) || sigmoid < 0 || sigmoid > 1) {
        console.warn("[MasteryService] Invalid sigmoid in IRT:", {
          sigmoid,
          expValue,
          exponent,
        });
        return safeC + (1 - safeC) * 0.5; // Default to middle probability
      }

      const probability = safeC + (1 - safeC) * sigmoid;

      // Guard against invalid probability
      if (!isFinite(probability) || probability < 0 || probability > 1) {
        console.warn("[MasteryService] Invalid probability in IRT:", {
          probability,
          sigmoid,
          safeC,
        });
        return 0.5; // Default to middle probability
      }

      return probability;
    } catch (error) {
      console.error(
        "[MasteryService] Error in calculateIRTProbability:",
        error,
        { mu, a, b, c },
      );
      return 0.5; // Default to middle probability on error
    }
  }

  /**
   * Calculate Fisher Information for IRT
   *
   * Measures how informative a question is about the user's ability.
   * Higher information = question provides more information about ability.
   *
   * @param mu Ability (logit scale)
   * @param a Discrimination parameter
   * @param b Difficulty parameter
   * @param c Guessing parameter
   * @returns Fisher Information
   */
  private static calculateFisherInformation(
    mu: number,
    a: number,
    b: number,
    c: number,
  ): number {
    const p = this.calculateIRTProbability(mu, a, b, c);
    const q = 1 - p;

    // Derivative of probability with respect to mu
    const exponent = -a * (mu - b);
    const sigmoid = 1 / (1 + Math.exp(exponent));
    const dp = (1 - c) * a * sigmoid * (1 - sigmoid);

    // Fisher Information = (dp/dmu)^2 / (p * q)
    const denominator = Math.max(1e-9, p * q);
    return (dp * dp) / denominator;
  }

  /**
   * Glicko-2 G function
   *
   * Used in Glicko-2 rating updates to weight the impact of uncertainty.
   *
   * @param phi Rating deviation
   * @returns G(phi) value
   */
  private static glickoG(phi: number): number {
    // Guard against invalid phi
    if (!isFinite(phi) || phi <= 0) {
      console.warn("[MasteryService] Invalid phi in glickoG:", phi);
      return 1.0; // Default g value
    }

    const denominator = Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

    // Guard against invalid denominator (should never happen but safety check)
    if (!isFinite(denominator) || denominator <= 0) {
      console.warn(
        "[MasteryService] Invalid denominator in glickoG:",
        denominator,
        "for phi:",
        phi,
      );
      return 1.0; // Default g value
    }

    const result = 1 / denominator;

    // Guard against invalid result
    if (!isFinite(result) || result <= 0) {
      console.warn(
        "[MasteryService] Invalid g result:",
        result,
        "for phi:",
        phi,
      );
      return 1.0; // Default g value
    }

    return result;
  }

  /**
   * Update question difficulty using reverse Glicko-2
   *
   * Treats the question as a "player" and updates its difficulty (b)
   * based on user performance. This enables self-calibrating difficulty.
   *
   * Logic:
   * - If high-mastery user gets it wrong → question is harder (increase b)
   * - If low-mastery user gets it right → question is easier (decrease b)
   *
   * @param questionDifficulty Current question difficulty state
   * @param userMu User's ability (mu) after the interaction
   * @param correct Whether the user got it correct
   * @param questionType Type of question (for IRT parameters)
   * @returns Updated question difficulty
   */
  static updateQuestionDifficulty(
    questionDifficulty: import("./types").QuestionDifficulty,
    userMu: number,
    correct: boolean,
    questionType: import("./types").QuestionType,
  ): import("./types").QuestionDifficulty {
    const { b: currentB, phi: currentPhi } = questionDifficulty;
    const { a, c } = IRT_PARAMS[questionType];

    // Calculate expected probability for the user
    const expectedProb = this.calculateIRTProbability(userMu, a, currentB, c);
    const outcome = correct ? 1.0 : 0.0;

    // Calculate Fisher Information
    const information = this.calculateFisherInformation(userMu, a, currentB, c);

    // Glicko-2 reverse update (question is the "player")
    const g = this.glickoG(currentPhi);
    const variance = 1.0 / (g * g * information);

    // Calculate delta for question difficulty
    // In reverse Glicko-2, the question is the "player"
    // If user mu > question b and user fails → question is harder (increase b)
    // If user mu < question b and user succeeds → question is easier (decrease b)
    const delta =
      (1.0 / (1.0 / (currentPhi * currentPhi) + 1.0 / variance)) *
      g *
      (outcome - expectedProb);

    // Apply K-factor to prevent wild swings (question difficulty should change slowly)
    const K = QUESTION_UPDATE_K;
    const adjustedDelta = delta * K;

    // Update question difficulty (b)
    // Reverse Glicko-2 logic: question is the "player"
    // For correct answers:
    //   - If low-mastery user (mu < b) succeeds → question is easier than we thought → decrease b
    //   - Delta will be positive (exceeded expectation) → negate to decrease b
    // For wrong answers:
    //   - If high-mastery user (mu > b) fails → question is harder than we thought → increase b
    //   - Delta will be negative (fell short of expectation) → negate to increase b
    // In both cases where we need to adjust b, we negate the delta
    const newB = currentB - adjustedDelta;

    // Clamp b to reasonable range (typically -3 to +3 in IRT)
    const MIN_B = -3.0;
    const MAX_B = 3.0;
    const clampedB = Math.max(MIN_B, Math.min(MAX_B, newB));

    // Update uncertainty (phi) - reduce uncertainty as we get more data
    const newPhi = Math.sqrt(
      1.0 / (1.0 / (currentPhi * currentPhi) + 1.0 / variance),
    );

    return {
      b: clampedB,
      phi: newPhi,
    };
  }

  /**
   * Update volatility (sigma) using Illinois algorithm
   *
   * This is the Glicko-2 volatility update algorithm that finds the optimal
   * sigma value that maximizes the likelihood of the observed outcomes.
   *
   * @param mu Current ability
   * @param phi Current rating deviation
   * @param sigma Current volatility
   * @param outcome Total outcome (sum of correct answers)
   * @param expected Total expected score
   * @param information Total Fisher Information
   * @returns Updated volatility
   */
  private static updateVolatility(
    mu: number,
    phi: number,
    sigma: number,
    outcome: number,
    expected: number,
    information: number,
  ): number {
    // Simplified volatility update
    // Full Illinois algorithm is more complex, this is a reasonable approximation
    const g = this.glickoG(phi);
    const variance = 1.0 / (g * g * information);
    const delta =
      (1.0 / (1.0 / (phi * phi) + 1.0 / variance)) * g * (outcome - expected);

    // Update sigma based on how much mu changed
    // If large change, increase volatility; if small, decrease
    const muChange = Math.abs(delta);
    // Simplified: adjust sigma based on magnitude of change
    if (muChange > 0.5) {
      return Math.min(0.5, sigma * 1.1); // Increase volatility
    } else if (muChange < 0.1) {
      return Math.max(0.01, sigma * 0.95); // Decrease volatility
    }

    return sigma; // Keep current volatility
  }
}
