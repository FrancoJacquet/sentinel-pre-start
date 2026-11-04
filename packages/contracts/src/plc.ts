export const PLC_STATES = ['IDLE', 'START_REQUESTED', 'BLOCKED', 'ENABLED', 'RUNNING', 'STOPPED'] as const;
export type PlcState = (typeof PLC_STATES)[number];

// Motivos de bloqueo propios del PLC; además puede bloquear con cualquier
// PerceptionStatus que no permita arrancar.
export const PLC_BLOCK_REASONS = ['AUTHORIZATION_REUSED', 'INVALID_TRANSITION'] as const;
export type PlcBlockReason = (typeof PLC_BLOCK_REASONS)[number];
