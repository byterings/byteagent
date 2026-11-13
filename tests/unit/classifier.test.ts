import { describe, expect, it } from 'vitest';
import { checkEscalation, classifyTask } from '../../src/agent/classifier';
import type { Attachment, ExecutionMode } from '../../src/shared/protocol';

const classify = (prompt: string, attachments: Attachment[] = []) => classifyTask({ prompt, attachments, setting: 'auto' });

describe('classifyTask: regression table', () => {
  const cases: Array<[string, ExecutionMode]> = [
    // Scenario A: read-only questions
    ['What does the orderTotal function do?', 'quick'],
    ['Explain this file', 'quick'],
    ['Where is the tax rate defined?', 'quick'],
    ['How do I run the tests?', 'quick'],
    ['Why does this throw when the list is empty?', 'quick'],
    ['Is there a helper for date formatting?', 'quick'],
    ['how does the login flow work?', 'quick'],
    ['Summarize what src/app.ts does', 'quick'],
    ['How can I add a new route?', 'quick'],
    ['hello', 'quick'],
    ['thanks, that works', 'quick'],
    // Scenario B: small local edits
    ['Change the button color to blue', 'quick'],
    ['Fix the typo in the README', 'quick'],
    ['Rename the variable tmp to total in this function', 'quick'],
    ['Increase the request timeout to 30 seconds', 'quick'],
    ['Add a comment explaining this line', 'quick'],
    ['Make the header padding 16px', 'quick'],
    ['Change the default page size constant to 50', 'quick'],
    ['Update the placeholder text on the search box', 'quick'],
    ['Remove the unused import', 'quick'],
    ['Run the tests', 'quick'],
    ['bump the version number to 2.1.0', 'quick'],
    // Scenario C: moderate, related files
    ['Add an API endpoint for listing orders and tests for it', 'standard'],
    ['Add a new endpoint GET /users/:id', 'standard'],
    ['Fix the bug where the cart total is wrong after removing an item', 'standard'],
    ['Add unit tests for the pricing service', 'standard'],
    ['Add a "remember me" checkbox to the settings form component', 'standard'],
    ['Refactor parseConfig and update all callers', 'standard'],
    ['The app crashes when the config file is missing. Fix it.', 'standard'],
    ['Add validation to the signup form and show the errors', 'standard'],
    ['Update src/a.ts and src/b.ts to use the new logger', 'standard'],
    ['Add a --verbose CLI option', 'standard'],
    ['Fix the password reset email subject', 'standard'],
    ['Can you add pagination to the products endpoint?', 'standard'],
    // Scenario D: large, cross-module
    ['Add token-based authentication across the API, with login, refresh and protected routes', 'project'],
    ['Implement a cross-module authentication system', 'project'],
    ['Migrate the project from JavaScript to TypeScript', 'project'],
    ['Redesign the data layer to support multi-tenancy', 'project'],
    ['Add role-based access control to every endpoint', 'project'],
    ['Refactor the entire codebase to use async/await', 'project'],
    ['Add internationalization to the whole application', 'project'],
    ['Build a notification system with a database table, an API, a background worker, a settings page and tests', 'project'],
    ['Rewrite the architecture so the frontend talks to the backend through a typed API client, and update the database models and tests', 'project'],
    ['1. Add a users table\n2. Add a signup endpoint\n3. Add a login page\n4. Add tests for all of it', 'project'],
    ['Add a payment flow: database schema, API endpoints and the checkout page', 'project'],
  ];

  it.each(cases)('"%s" → %s', (prompt, expected) => {
    const result = classify(prompt);
    expect(result.mode, `${result.reasons.join('; ')} [intent=${result.intent} scope=${result.scope} risk=${result.risk}]`).toBe(expected);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.2);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.source).toBe('heuristic');
  });
});

describe('classifyTask: details', () => {
  it('tells questions from polite requests', () => {
    expect(classify('Can you explain what this does?').intent).toBe('question');
    expect(classify('Can you add a retry to this call?').intent).toBe('edit');
    expect(classify('Could you fix the failing test?').intent).toBe('edit');
    expect(classify('How do I add a new command?').intent).toBe('question');
    expect(classify('Run npm test').intent).toBe('command');
  });

  it('requires verification for non-trivial edits but not for questions', () => {
    expect(classify('What does this do?').needsVerification).toBe(false);
    expect(classify('Fix the typo in the README').needsVerification).toBe(false);
    expect(classify('Add an API endpoint for listing orders and tests for it').needsVerification).toBe(true);
    expect(classify('Fix the password hashing in this function').needsVerification).toBe(true);
  });

  it('raises a local change in a sensitive area to Standard', () => {
    const result = classify('Change the token expiry constant to 15 minutes');
    expect(result.mode).toBe('standard');
    expect(result.risk).toBe('medium');
    expect(result.reasons.join(' ')).toMatch(/Security-sensitive/);
  });

  it('keeps a change to a selection local', () => {
    const selection: Attachment = { path: 'src/a.ts', startLine: 3, endLine: 9, source: 'selection' };
    expect(classify('Simplify this', [selection]).mode).toBe('quick');
    expect(classify('Make this function handle null', [selection]).scope).toBe('local');
  });

  it('treats several attached files as related work', () => {
    const files: Attachment[] = [
      { path: 'src/a.ts', source: 'mention' },
      { path: 'src/b.ts', source: 'mention' },
    ];
    expect(classify('Make these consistent', files).mode).toBe('standard');
    // The file that merely happens to be open is not a signal.
    expect(classify('Make the title bold', [{ path: 'src/a.ts', source: 'active' }]).mode).toBe('quick');
  });

  it('gives low confidence to vague requests and higher confidence to clear ones', () => {
    const vague = classify('do the thing');
    const clear = classify('Migrate the whole project from JavaScript to TypeScript, including every module and the tests');
    expect(vague.mode).toBe('quick');
    expect(vague.confidence).toBeLessThan(0.5);
    expect(clear.confidence).toBeGreaterThan(vague.confidence);
    expect(clear.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('is deterministic', () => {
    const prompt = 'Add an API endpoint for listing orders and tests for it';
    expect(classify(prompt)).toEqual(classify(prompt));
  });

  it('handles empty and very long input', () => {
    expect(classify('').mode).toBe('quick');
    expect(classify('   \n  ').mode).toBe('quick');
    const long = `Please update the report module. ${'It should also handle another special case in the export step. '.repeat(40)}`;
    expect(['standard', 'project']).toContain(classify(long).mode);
  });

  it('uses the mode chosen by the user and says what it would have picked', () => {
    const forced = classifyTask({ prompt: 'Migrate the project from JavaScript to TypeScript', attachments: [], setting: 'quick' });
    expect(forced).toMatchObject({ mode: 'quick', source: 'user', confidence: 1 });
    expect(forced.reasons).toEqual(['You chose Quick mode', 'ByteAgent would have picked Project']);
    const same = classifyTask({ prompt: 'What does this do?', attachments: [], setting: 'quick' });
    expect(same.reasons).toEqual(['You chose Quick mode']);
    expect(classifyTask({ prompt: 'fix typo', attachments: [], setting: 'project' }).mode).toBe('project');
  });
});

describe('checkEscalation', () => {
  const files = (n: number, dir = 'src/a'): string[] => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);

  it('does not escalate small work', () => {
    expect(checkEscalation('quick', { filesProposed: files(2), steps: 3, filesRead: 2 })).toBeUndefined();
    expect(checkEscalation('standard', { filesProposed: files(5), steps: 10, filesRead: 9 })).toBeUndefined();
    expect(checkEscalation('project', { filesProposed: files(30), steps: 40, filesRead: 50 })).toBeUndefined();
  });

  it('moves Quick to Standard when the change or the investigation grows', () => {
    expect(checkEscalation('quick', { filesProposed: files(3), steps: 2, filesRead: 1 })).toEqual({ to: 'standard', reason: 'The change touches 3 files' });
    expect(checkEscalation('quick', { filesProposed: [], steps: 2, filesRead: 8 })?.to).toBe('standard');
    expect(checkEscalation('quick', { filesProposed: [], steps: 9, filesRead: 1 })?.to).toBe('standard');
    expect(checkEscalation('quick', { filesProposed: ['a.ts', 'a.ts', 'a.ts'], steps: 1, filesRead: 0 })).toBeUndefined();
  });

  it('moves straight to Project for a wide change', () => {
    expect(checkEscalation('quick', { filesProposed: files(6), steps: 1, filesRead: 0 })?.to).toBe('project');
    expect(checkEscalation('quick', { filesProposed: ['src/a/x.ts', 'src/b/x.ts', 'tests/x.ts', 'docs/x.md'], steps: 1, filesRead: 0 })?.to).toBe('project');
    expect(checkEscalation('standard', { filesProposed: files(8), steps: 5, filesRead: 3 })?.to).toBe('project');
    expect(checkEscalation('standard', { filesProposed: files(2), steps: 20, filesRead: 3 })?.to).toBe('project');
  });
});
