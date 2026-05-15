import type { SqlitePersistence } from "../multi-agent/persistence.ts";

// Seeded, deterministic permuted-block assignment over the 12 strata
// (Mode × Role × Opponent). Pure: no I/O, no Date, no globals. Same
// (seed, position) ⇒ identical output. Every block of 12 consecutive
// positions contains each stratum exactly once (exact balance at every
// block boundary). Spec: docs/superpowers/specs/2026-05-15-clean-
// experimental-design-platform-code-design.md (3/4).

export type ConditionMode = "delegated" | "direct";
export type ConditionRole = "buyer" | "seller";
export type OpponentBlock = "easygoing" | "moderate" | "tough";

export interface Stratum {
  conditionMode: ConditionMode;
  conditionRole: ConditionRole;
  opponentBlock: OpponentBlock;
}

export interface Assignment extends Stratum {
  assignmentBlockIndex: number;
  replicateId: number;
}

const MODES: ConditionMode[] = ["delegated", "direct"];
const ROLES: ConditionRole[] = ["buyer", "seller"];
const OPPS: OpponentBlock[] = ["easygoing", "moderate", "tough"];

/** The 12 strata in a fixed canonical order. */
export const STRATA: readonly Stratum[] = MODES.flatMap((conditionMode) =>
  ROLES.flatMap((conditionRole) =>
    OPPS.map((opponentBlock) => ({ conditionMode, conditionRole, opponentBlock })),
  ),
);

// --- tiny deterministic PRNG (no deps) ---
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic permutation of [0..11] for a given seed + block index. */
function blockPermutation(seed: string, blockIndex: number): number[] {
  const seedFn = xmur3(`${seed}:${blockIndex}`);
  const rng = mulberry32(seedFn());
  const idx = STRATA.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/** Resolve the assignment for a 0-based sequence position. */
export function nextAssignment(seed: string, position: number): Assignment {
  const blockLen = STRATA.length; // 12
  const blockIndex = Math.floor(position / blockLen);
  const within = position % blockLen;
  const perm = blockPermutation(seed, blockIndex);
  const stratum = STRATA[perm[within]!]!;
  return {
    ...stratum,
    assignmentBlockIndex: blockIndex,
    replicateId: blockIndex, // each stratum appears once per block
  };
}

/** Atomically claim the next seeded assignment for a participant and
 *  persist it. Randomization policy lives here; the storage layer only
 *  provides the atomic read-position→write primitive. */
export function claimSeededAssignment(
  db: SqlitePersistence,
  participantId: string,
  seed: string,
): Assignment {
  const result = db.claimAssignment(participantId, (position) => {
    const a = nextAssignment(seed, position);
    return {
      conditionMode: a.conditionMode,
      conditionRole: a.conditionRole,
      opponentBlock: a.opponentBlock,
      assignmentSeed: seed,
      assignmentBlockIndex: a.assignmentBlockIndex,
      replicateId: a.replicateId,
      assignedAt: new Date().toISOString(),
    };
  });
  // result structurally satisfies Assignment; the extra fields
  // (assignmentSeed, assignedAt) are benign — narrowing cast only sheds
  // them from the public return type.
  return result as Assignment;
}
