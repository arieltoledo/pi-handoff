export const sections: string[];
export const workStatuses: Array<'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'AWAITING_USER'>;
export function readHandoff(cwd: string): Promise<string | null>;
export function fingerprint(text: string | null): string | null;
export function validateHandoff(text: string | null): string | null;
export function getWorkStatus(text: string | null): 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'AWAITING_USER' | null;
export const preparePrompt: string;
export const resumePrompt: string;
