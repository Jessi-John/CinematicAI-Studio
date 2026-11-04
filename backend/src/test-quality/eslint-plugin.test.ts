/**
 * Meta-tests for the cinematicai-test-quality ESLint plugin.
 *
 * Each test lints a small in-memory source file and asserts that the
 * expected rule fires (or doesn't fire). If these tests ever break,
 * the plugin itself has regressed — the protection it provides to the
 * rest of the codebase is gone.
 *
 * The plugin lives at ../../../eslint-plugins/test-quality.mjs. The
 * RuleTester is provided by ESLint's built-in Linter class.
 */

import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';

import plugin from '../../../eslint-plugins/test-quality.mjs';

const linter = new Linter();

/**
 * Run the named rule against a snippet of source code. Returns only
 * the messages from the cinematicai plugin (filtering out unrelated
 * parse warnings from incomplete snippets).
 *
 * NOTE: ESLint 9 flat config matches `files` against the relative
 * path of the linted file, not the absolute path. We always pass
 * a relative filename so the test-file pattern in the rule
 * (`/\.(test|spec)\.(ts|tsx|...)$/`) matches.
 */
function lintWith(ruleName: string, source: string, relativeFilename = 'test.test.tsx') {
  const config: Linter.Config[] = [
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: {
          ecmaFeatures: { jsx: relativeFilename.endsWith('.tsx') || relativeFilename.endsWith('.jsx') },
        },
      },
      plugins: { 'cinematicai-test-quality': plugin },
      rules: {
        [`cinematicai-test-quality/${ruleName}`]: 'error',
      },
    },
    // A second config block that matches non-test files, so the
    // "inactive on non-test files" tests can verify the rule is
    // scoped to tests only.
    {
      files: ['**/!(test|spec).ts', '**/!(test|spec).tsx'],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaVersion: 'latest' },
      },
      plugins: { 'cinematicai-test-quality': plugin },
      rules: {
        [`cinematicai-test-quality/${ruleName}`]: 'error',
      },
    },
  ];
  const messages = linter.verify(source, config, relativeFilename);
  return messages.filter(
    (m) => typeof m.ruleId === 'string' && m.ruleId.startsWith('cinematicai-test-quality/')
  );
}

describe('cinematicai-test-quality/no-trivial-assertions', () => {
  it('flags `expect(x).toBeDefined()`', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 1; expect(x).toBeDefined();`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe('cinematicai-test-quality/no-trivial-assertions');
  });

  it('flags `expect(x).toBeTruthy()`', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 1; expect(x).toBeTruthy();`
    );
    expect(messages).toHaveLength(1);
  });

  it('allows `expect(x).toBeFalsy()` (precise assertion, M64)', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 0; expect(x).toBeFalsy();`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows `expect(x).toBeUndefined()` (precise assertion, M64)', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = undefined; expect(x).toBeUndefined();`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows `expect(x).not.toBeDefined()` (negated form is meaningful)', () => {
    // `not.toBeDefined()` asserts the value is NOT defined — useful for
    // asserting a ref was cleared, a memo was invalidated, etc. The
    // rule allows this form because it's a real assertion about state.
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = undefined; expect(x).not.toBeDefined();`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows `expect(x).not.toBeUndefined()` (negated form is meaningful)', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 1; expect(x).not.toBeUndefined();`
    );
    expect(messages).toHaveLength(0);
  });

  it('does not flag `toBe(x)` / `toEqual(x)` / `toMatch(x)`', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 1; expect(x).toBe(1); expect(x).toEqual(1); expect(x).toMatch(/1/);`
    );
    expect(messages).toHaveLength(0);
  });

  it('is inactive on non-test files', () => {
    const messages = lintWith(
      'no-trivial-assertions',
      `const x = 1; expect(x).toBeDefined();`,
      'lib/utils/source.ts'
    );
    expect(messages).toHaveLength(0);
  });
});

describe('cinematicai-test-quality/click-needs-assertion', () => {
  it('flags user.click with no expect afterwards', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it } from 'vitest';
       it('clicks but does not assert', async () => {
         const user = { click: () => {} };
         await user.click({});
       });`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe('noAssertion');
  });

  it('flags fireEvent.click with no expect afterwards', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it } from 'vitest';
       it('fires but does not assert', () => {
         const fireEvent = { click: () => {} };
         fireEvent.click({});
       });`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe('noAssertion');
  });

  it('flags expect BEFORE click with no expect AFTER click', () => {
    // The user interaction is what we're trying to verify. An expect
    // before the click just confirms the initial state.
    const messages = lintWith(
      'click-needs-assertion',
      `import { it } from 'vitest';
       it('asserts before click', async () => {
         const user = { click: () => {} };
         const x = { container: {} };
         expect(x.container).toBeTruthy();
         await user.click({});
       });`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe('expectBeforeClick');
  });

  it('allows user.click followed by expect (the good pattern)', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it, expect } from 'vitest';
       it('clicks and asserts', async () => {
         const user = { click: () => {} };
         const x = { container: { textContent: 'Hi' } };
         await user.click({});
         expect(x.container.textContent).toEqual('Hi');
       });`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows fireEvent.click followed by expect', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it, expect } from 'vitest';
       it('fires and asserts', () => {
         const fireEvent = { click: () => {} };
         const x = {};
         fireEvent.click({});
         expect(x).toEqual({});
       });`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows other user-event actions followed by expect (type, hover, etc.)', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it, expect } from 'vitest';
       it('types and asserts', async () => {
         const user = { type: () => {} };
         const x = { value: 'hello' };
         await user.type({});
         expect(x.value).toEqual('hello');
       });`
    );
    expect(messages).toHaveLength(0);
  });

  it('is inactive on non-test files', () => {
    const messages = lintWith(
      'click-needs-assertion',
      `import { it } from 'vitest';
       it('clicks but no assert', async () => {
         const user = { click: () => {} };
         await user.click({});
       });`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(0);
  });
});

describe('cinematicai-test-quality/test-against-project-middleware', () => {
  it('flags direct import of express-rate-limit in a test file', () => {
    const messages = lintWith(
      'test-against-project-middleware',
      `import rateLimit from 'express-rate-limit';`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe('cinematicai-test-quality/test-against-project-middleware');
  });

  it('allows importing the project middleware (relative path)', () => {
    const messages = lintWith(
      'test-against-project-middleware',
      `import { generalLimiter } from '../middleware/rate-limit.js';`
    );
    expect(messages).toHaveLength(0);
  });

  it('allows importing the project middleware (alias)', () => {
    const messages = lintWith(
      'test-against-project-middleware',
      `import { generalLimiter } from '@/middleware/rate-limit';`
    );
    expect(messages).toHaveLength(0);
  });

  it('is inactive on non-test files', () => {
    const messages = lintWith(
      'test-against-project-middleware',
      `import rateLimit from 'express-rate-limit';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(0);
  });
});

describe('cinematicai-test-quality/no-module-level-process-env', () => {
  it('flags `const FOO = process.env.BAR` at module scope', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const FOO = process.env.BAR || 'default';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe('cinematicai-test-quality/no-module-level-process-env');
  });

  it('flags `let X = process.env.Y` at module scope', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `let API_KEY = process.env.API_KEY;`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(1);
  });

  it('allows `process.env.NODE_ENV` (always available)', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const isDev = process.env.NODE_ENV !== 'production';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(0);
  });

  it('flags `const PORT = parseInt(process.env.PORT || \'34567\', 10)` (CallExpression wrapping process.env)', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const PORT = parseInt(process.env.PORT || '34567', 10);`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe('cinematicai-test-quality/no-module-level-process-env');
  });

  it('flags `const FOO = process.env.BAR || \'default\'` (LogicalExpression wrapping process.env)', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const FOO = process.env.BAR || 'default';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags `const X = process.env.Y ?? \'default\'` (nullish coalescing)', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const X = process.env.Y ?? 'default';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(1);
  });

  it('allows `process.env` reads inside a function (lazy evaluation)', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `function getPort() { return parseInt(process.env.PORT || '34567', 10); }`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(0);
  });

  it('allows `process.env` reads inside an arrow function', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const getApiKey = () => process.env.API_KEY || '';`,
      'lib/source.ts'
    );
    expect(messages).toHaveLength(0);
  });

  it('allows in env.ts config file', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const FOO = process.env.FOO || 'default';`,
      'src/config/env.ts'
    );
    expect(messages).toHaveLength(0);
  });

  it('allows in test setup file', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `process.env.DATABASE_URL = 'test';`,
      'src/test/setup.ts'
    );
    expect(messages).toHaveLength(0);
  });

  it('is inactive on test files', () => {
    const messages = lintWith(
      'no-module-level-process-env',
      `const FOO = process.env.FOO || 'default';`,
      'lib/source.test.ts'
    );
    expect(messages).toHaveLength(0);
  });
});
