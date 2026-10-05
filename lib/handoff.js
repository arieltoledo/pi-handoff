import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sections = ['Current Goal', 'Completed', 'Decisions', 'Files Changed', 'Tests', 'Current State', 'Blockers', 'Next Step'];
export async function readHandoff(cwd) {
  try { return await readFile(join(cwd, '.agent', 'HANDOFF.md'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function fingerprint(text) {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}
export function validateHandoff(text) {
  if (!text?.trim()) return 'HANDOFF.md is missing or empty';
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (const section of sections) {
    const index = headings.findIndex(match => match[1] === section);
    if (index < 0) return `Missing section: ${section}`;
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? text.length;
    if (!text.slice(start, end).trim()) return `Empty section: ${section}`;
  }
  return null;
}
export const preparePrompt = `Prepare a session handoff. Use CodeGraph first and verify actual repository state, including Git status/diff when available.
Update .agent/HANDOFF.md with these nonempty sections: ${sections.join(', ')}.
Record the exact goal, completed work, decisions, changed files, test commands and results, current state, real blockers, and one explicit next action. Use "None" where appropriate.
Run relevant tests only if their current status is uncertain. Do not modify application code during handoff. Do not invent successful tests or omit unfinished work. Keep the file compact and operational.
Refresh the handoff even if only its verification timestamp changes. Finish by confirming the file is ready.`;
export const resumePrompt = `Read .agent/HANDOFF.md first. Use CodeGraph to orient yourself. Verify current repository files and Git status/diff when available. Continue from the exact Next Step. Do not rely on previous conversation history or repeat completed work. Repository state is authoritative when it conflicts with the handoff. Keep context focused and operational.`;
