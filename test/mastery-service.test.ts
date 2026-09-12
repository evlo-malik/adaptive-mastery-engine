import { describe, expect, it, vi } from 'vitest';

import { MAX_MU, MIN_MU, MasteryService } from '../src/index';
import type { TopicMasteryState } from '../src/index';

const stateAt = (date: Date): TopicMasteryState => ({
  ...MasteryService.createDefaultState(),
  lastSeenAt: date,
});

describe('MasteryService', () => {
  it('creates a finite cold-start state', () => {
    const state = MasteryService.createDefaultState();

    expect(state.mu).toBe(0);
    expect(state.phi).toBeGreaterThan(0);
    expect(state.stability).toBeGreaterThan(0);
    expect(state.lastSeenAt).toBeInstanceOf(Date);
  });

  it('raises mastery after a correct response', () => {
    const result = MasteryService.processInteraction(
      MasteryService.createDefaultState(),
      {
        type: 'practice',
        correct: true,
        questionType: 'MCQ',
        userConfidence: 0.8,
        difficulty: 50,
      },
    );

    expect(result.delta).toBeGreaterThan(0);
    expect(result.state.mu).toBeGreaterThan(0);
  });

  it('lowers mastery after an incorrect response', () => {
    const result = MasteryService.processInteraction(
      MasteryService.createDefaultState(),
      {
        type: 'practice',
        correct: false,
        questionType: 'MCQ',
        userConfidence: 0.8,
        difficulty: 50,
      },
    );

    expect(result.delta).toBeLessThan(0);
    expect(result.state.mu).toBeLessThan(0);
  });

  it('supports partial credit for long-form responses', () => {
    const low = MasteryService.processInteraction(
      MasteryService.createDefaultState(),
      {
        type: 'practice',
        correct: true,
        questionType: 'LONG',
        userConfidence: 0.7,
        score: 2,
        totalMarks: 10,
      },
    );
    const high = MasteryService.processInteraction(
      MasteryService.createDefaultState(),
      {
        type: 'practice',
        correct: true,
        questionType: 'LONG',
        userConfidence: 0.7,
        score: 9,
        totalMarks: 10,
      },
    );

    expect(high.state.mu).toBeGreaterThan(low.state.mu);
  });

  it('keeps scores and ability inside public bounds', () => {
    let state = MasteryService.createDefaultState();

    for (let index = 0; index < 200; index += 1) {
      state = MasteryService.processInteraction(state, {
        type: 'practice',
        correct: index % 3 !== 0,
        questionType: index % 2 === 0 ? 'MCQ' : 'TF',
        userConfidence: (index % 10) / 10,
        difficulty: index % 101,
      }).state;

      expect(state.mu).toBeGreaterThanOrEqual(MIN_MU);
      expect(state.mu).toBeLessThanOrEqual(MAX_MU);
      expect(MasteryService.getDisplayScore(state)).toBeGreaterThanOrEqual(1);
      expect(MasteryService.getDisplayScore(state)).toBeLessThanOrEqual(100);
    }
  });

  it('decays retrievability as time passes', () => {
    vi.useFakeTimers();
    const learnedAt = new Date('2026-01-01T00:00:00.000Z');
    const state = { ...stateAt(learnedAt), mu: 2, stability: 2 };

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const dayOne = MasteryService.getMasteryBreakdown(state);
    vi.setSystemTime(new Date('2026-01-11T00:00:00.000Z'));
    const dayTen = MasteryService.getMasteryBreakdown(state);

    expect(dayTen.retrievability).toBeLessThan(dayOne.retrievability);
    expect(dayTen.mastery).toBeLessThan(dayOne.mastery);
    vi.useRealTimers();
  });

  it('sanitizes malformed persisted state', () => {
    const sanitized = MasteryService.sanitizeState({
      mu: Number.NaN,
      phi: Number.POSITIVE_INFINITY,
      sigma: -2,
      stability: 0,
      difficulty: 999,
      lastSeenAt: new Date('invalid'),
    });

    expect(Object.values(sanitized).every((value) => value instanceof Date || Number.isFinite(value))).toBe(true);
    expect(sanitized.stability).toBeGreaterThan(0);
  });
});
