export const sections: string[];
export function readHandoff(cwd: string): Promise<string | null>;
export function fingerprint(text: string | null): string | null;
export function validateHandoff(text: string | null): string | null;
export const preparePrompt: string;
export const resumePrompt: string;
