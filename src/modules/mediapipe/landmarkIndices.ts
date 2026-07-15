/**
 * modules/mediapipe/landmarkIndices.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   UI-layer code (e.g. a debug mesh overlay) that works with MediaPipe
 *   output conceptually belongs to "the mediapipe module" — but the actual
 *   index constants live in `core/math` because the topology is a published
 *   spec, not an SDK detail, and the math layer must stay dependency-free.
 *   This file re-exports them so module boundaries stay intuitive.
 * ---------------------------------------------------------------------------
 */

export * from '../../core/math/landmarkIndices';
