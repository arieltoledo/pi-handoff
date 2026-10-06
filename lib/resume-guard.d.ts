export interface ResumeGuardState {
  version: 1;
  handoffFingerprint: string;
  consumed: true;
  consumedAt: string;
  [key: string]: unknown;
}

export function readResumeGuard(cwd: string): Promise<Record<string, unknown> | null>;
export function isResumeConsumed(cwd: string, handoffFingerprint: string): Promise<boolean>;
export function claimResume(
  cwd: string,
  handoffFingerprint: string,
  metadata?: Record<string, unknown>,
): Promise<ResumeGuardState | null>;
export function consumeResume(
  cwd: string,
  handoffFingerprint: string,
  metadata?: Record<string, unknown>,
): Promise<ResumeGuardState | null>;
export function releaseResume(cwd: string, handoffFingerprint: string): Promise<boolean>;
