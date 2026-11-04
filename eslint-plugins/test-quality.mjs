/**
 * eslint-plugin-cinematicai-test-quality
 *
 * Permanent guardrails against the test-quality issues that bit the
 * codebase in the 2026-06-28 test audit. Each rule addresses the
 * specific pattern that allowed a useless test to pass:
 *
 *   - no-trivial-assertions:  flags `expect(x).toBeDefined()` and similar
 *     always-true assertions. (Caught `require-auth.test.tsx` v1, where
 *     the entire test was `expect(container).toBeDefined()`.)
 *
 *   - click-needs-assertion:  flags user.click / fireEvent calls that
 *     have no `expect()` between the click and end of the test. (Caught
 *     the v1 "switches tabs" test in `story/[id]/page.test.tsx` that
 *     clicked a tab button and then asserted the button still existed.)
 *
 *   - test-against-project-middleware: flags direct imports of
 *     `express-rate-limit` in test files. The project wraps that
 *     library with `rate-limit.ts`; tests must exercise the wrapper,
 *     not the underlying library. (Caught `rate-limit.matrix.test.ts`
 *     v1, which tested the library defaults instead of the project
 *     middleware.)
 *
 * Each rule has unit tests in `eslint-plugins/test-quality.test.mjs`
 * that lock in the contract.
 */

// M64: only truly signal-free matchers belong here. toBeUndefined/toBeFalsy/
// toBeNil are PRECISE assertions about absence/falseness, not always-true
// assertions — banning them blocked legitimate tests everywhere.
const trivialAssertionNames = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toExist',
]);

function isInTestFile(filename) {
  if (!filename) return false;
  return /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(filename);
}

function isTestCall(node, names) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'Identifier') return false;
  return names.includes(callee.name);
}

const noTrivialAssertions = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow trivial assertions (`toBeDefined`, `toBeTruthy`, `toExist`, ...) that are always true or carry no signal. Assert on a specific value instead.',
    },
    schema: [],
    messages: {
      trivial:
        'Trivial assertion `{{name}}` does not verify behavior. Assert on a specific value (e.g. `expect(x).toBe("expected")`, `expect(x).toEqual(...)`, `expect(x).toMatch(...)`).',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isInTestFile(filename)) return {};
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        const prop = node.callee.property;
        if (prop.type !== 'Identifier') return;
        if (!trivialAssertionNames.has(prop.name)) return;
        // Allow `.not.toBeDefined()` and `.not.toBeUndefined()` — those
        // are sometimes meaningful (e.g. asserting a ref was cleared).
        // But `.not.toBeTruthy()` and `.not.toBeFalsy()` are still trivial.
        // The chain looks like: `expect(x).not.toBeDefined()` where
        //   node.callee.object is `expect(x).not` (MemberExpression)
        //   node.callee.object.object is `expect(x)` (CallExpression)
        //   node.callee.object.property is `not`
        const chainObject = node.callee.object;
        const isNegated =
          chainObject.type === 'MemberExpression' &&
          chainObject.property.type === 'Identifier' &&
          chainObject.property.name === 'not' &&
          chainObject.object.type === 'CallExpression';
        if (isNegated && (prop.name === 'toBeDefined' || prop.name === 'toBeUndefined')) {
          return;
        }
        context.report({ node: prop, messageId: 'trivial', data: { name: prop.name } });
      },
    };
  },
};

const clickNeedsAssertion = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every user.click / fireEvent.* call inside an it/test must be followed by an expect() that verifies the behavior. Without a post-click assertion the test only proves the click did not throw.',
    },
    schema: [],
    messages: {
      noAssertion:
        'Test "{{testName}}" calls a user interaction ({{action}}) but contains no `expect()` call afterwards. Add an assertion that verifies the resulting state.',
      expectBeforeClick:
        'Test "{{testName}}" has `expect()` calls but none occur after the user interaction ({{action}}). Move the assertion to after the click to verify the actual effect.',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isInTestFile(filename)) return {};
    return {
      CallExpression(node) {
        if (!isInteractionCall(node)) return;
        // Walk up to the enclosing it/test block.
        const testBlock = findEnclosingTestBlock(node);
        if (!testBlock) return;
        // The testBlock is `it(name, callback)` or `it(name, opts, callback)`.
        // M63: use the LAST function-typed argument, not arguments[1].
        const callback = [...testBlock.arguments].reverse().find(
          (a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression'
        );
        if (!callback) return;
        const callbackBody = callback.body;
        if (!callbackBody) return;
        // If the callback is `() => x` (expression form), there's no block;
        // wrap the single expression so the algorithm still works.
        const statements = callbackBody.type === 'BlockStatement'
          ? callbackBody.body
          : [{
              type: 'ExpressionStatement',
              expression: callbackBody,
              range: [callbackBody.range[0], callbackBody.range[1]],
            }];
        const clickNode = node;
        const clickExprStmt = findEnclosingStatement(clickNode, statements);
        if (!clickExprStmt) return;
        // M63: an expect INSIDE the same statement (e.g. in the same try
        // block) but at a LATER position must count as "after the click" —
        // the previous statement-granularity ordering flagged the whole
        // try-statement as needing an assertion after it.
        const clickEnd = node.range[1];
        const hasExpectAfter = statements.some((s) => {
          return containsExpectAfter(context.sourceCode, s, clickEnd);
        });
        if (hasExpectAfter) return;
        const testName = getTestName(context.sourceCode, testBlock);
        const action = describeInteraction(node);
        const anyExpect = statements.some((s) => containsExpect(context.sourceCode, s));
        context.report({
          node,
          messageId: anyExpect ? 'expectBeforeClick' : 'noAssertion',
          data: { testName, action },
        });
      },
    };
  },
};

function isInteractionCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier' && callee.name === 'click') {
    return false;
  }
  if (callee.type === 'MemberExpression') {
    const obj = callee.object;
    const prop = callee.property;
    // M63: accept BOTH `user.click` and `userEvent.click` — the latter is the
    // standard @testing-library/user-event API and previously escaped.
    if (obj.type === 'Identifier' && (obj.name === 'user' || obj.name === 'userEvent') && prop.type === 'Identifier' && prop.name === 'click') {
      return true;
    }
    if (obj.type === 'Identifier' && (obj.name === 'user' || obj.name === 'userEvent') && prop.type === 'Identifier' && /^(type|tab|keyboard|hover|clear|selectOptions|upload|focus|blur|dblClick|tripleClick|rightClick|pointer|drag|drop|fill)$/.test(prop.name)) {
      return true;
    }
    if (obj.type === 'Identifier' && obj.name === 'fireEvent' && prop.type === 'Identifier' && /^(click|change|input|submit|keyDown|keyUp|focus|blur|hover|drop|dragStart|dragEnd|dragEnter|dragLeave|dragOver|dragExit|mouseDown|mouseUp|mouseEnter|mouseLeave|mouseMove|pointerDown|pointerUp|pointerMove|touchStart|touchEnd|wheel|scroll)$/.test(prop.name)) {
      return true;
    }
  }
  return false;
}

function describeInteraction(node) {
  const callee = node.callee;
  if (callee.type === 'MemberExpression') {
    if (callee.object.type === 'Identifier' && callee.object.name === 'user') {
      return `user.${callee.property.name}`;
    }
    if (callee.object.type === 'Identifier' && callee.object.name === 'fireEvent') {
      return `fireEvent.${callee.property.name}`;
    }
  }
  return 'interaction';
}

function findEnclosingTestBlock(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'CallExpression') {
      const callee = current.callee;
      // M63: recognize it/test including member callees (it.each, it.only,
      // it.skip, test.each, ...) — previously only bare identifiers matched.
      if (callee.type === 'Identifier' && (callee.name === 'it' || callee.name === 'test')) {
        return current;
      }
      if (callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          (callee.object.name === 'it' || callee.object.name === 'test')) {
        return current;
      }
    }
    current = current.parent;
  }
  return null;
}

function findEnclosingStatement(targetNode, statements) {
  for (const stmt of statements) {
    if (!stmt.range) continue;
    if (targetNode.range[0] >= stmt.range[0] && targetNode.range[1] <= stmt.range[1]) {
      return stmt;
    }
  }
  return null;
}

function getTestName(sourceCode, testBlock) {
  const firstArg = testBlock.arguments[0];
  if (!firstArg) return '<unnamed>';
  try {
    return sourceCode.getText(firstArg);
  } catch {
    return '<computed>';
  }
}

function containsExpect(sourceCode, stmt) {
  if (!stmt.range) return false;
  const text = sourceCode.getText(stmt);
  return /\bexpect\s*\(/.test(text);
}

// M63: position-based ordering — true when any expect() CallExpression
// inside stmt starts at or after clickEnd (so an expect in the same try
// block after the click counts).
function containsExpectAfter(sourceCode, stmt, clickEnd) {
  if (!stmt.range) return false;
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        node.callee.name === 'expect' &&
        node.range && node.range[0] >= clickEnd) {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(stmt);
  return found;
}

const testAgainstProjectMiddleware = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Do not import `express-rate-limit` directly in test files. Import the project middleware from `middleware/rate-limit.ts` (or `backend/src/middleware/rate-limit.ts`) so the test exercises the real wrapper (Redis store, per-user keying, 503-on-fail, etc.), not the library defaults.',
    },
    schema: [],
    messages: {
      directImport:
        'Direct import of `express-rate-limit` in a test file. Import the project middleware instead — the project wraps this library with a Redis store, per-user keying, and 503-on-Redis-down behavior, none of which are exercised when you import the library directly.',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isInTestFile(filename)) return {};
    return {
      ImportDeclaration(node) {
        if (node.source && node.source.value === 'express-rate-limit') {
          context.report({ node, messageId: 'directImport' });
        }
      },
    };
  },
};

/**
 * `no-redundant-button-onkeydown`
 *
 * Flags `<button>` elements that have an `onKeyDown` handler handling Enter or
 * Space. Browsers already fire `onClick` on Enter/Space for `<button>`, so
 * an extra `onKeyDown` causes double execution. Use `onClick` only.
 */
const noRedundantButtonOnKeyDown = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Do not add onKeyDown handlers for Enter/Space on <button> elements. ' +
        'Buttons already fire onClick on keyboard activation, causing double execution.',
    },
    schema: [],
    messages: {
      redundant:
        'Redundant onKeyDown on <button> — browser already fires onClick on Enter/Space. Remove the onKeyDown handler.',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    return {
      JSXElement(node) {
        if (node.openingElement.name?.name !== 'button') return;
        const attrs = node.openingElement.attributes;
        if (!attrs) return;
        const onKeyDown = attrs.find(
          (a) => a.type === 'JSXAttribute' && a.name?.name === 'onKeyDown'
        );
        if (!onKeyDown) return;
        const onClick = attrs.find(
          (a) => a.type === 'JSXAttribute' && a.name?.name === 'onClick'
        );
        if (!onClick) return;
        // M65: only report when the handler actually handles Enter/Space —
        // legitimate handlers (Escape-to-close, arrow-key roving tabindex)
        // are not redundant and were previously hard-blocked.
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const handlerText = sourceCode.getText(onKeyDown);
        const handlesEnterOrSpace =
          /['"`](?:Enter| |Spacebar|Space)['"`]/.test(handlerText) ||
          /\b(?:key|code|keyCode)\b\s*(?:===?|!==?)\s*(?:13|32)\b/.test(handlerText) ||
          /\b(?:key|code)\b\s*===?\s*['"`](?:Enter| )['"`]/.test(handlerText);
        if (!handlesEnterOrSpace) return;
        context.report({ node: onKeyDown, messageId: 'redundant' });
      },
    };
  },
};

/**
 * `prefer-genre-map`
 *
 * Flags `GENRES.find((g) => g.value === ...)` in non-test files. The project
 * provides `GENRE_MAP` (a Record<Genre, {...}>) for O(1) lookups. Using
 * `GENRES.find()` is O(n) and should be replaced with `GENRE_MAP[genre]`.
 */
const preferGenreMap = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use GENRE_MAP (O(1) lookup) instead of GENRES.find() (O(n)) when ' +
        'accessing genre metadata by value. See lib/constants/genres.ts.',
    },
    schema: [],
    messages: {
      preferMap:
        'Use GENRE_MAP[genre] instead of GENRES.find() for O(1) lookup. ' +
        'GENRE_MAP is a Record<Genre, {value, label, emoji}> in lib/constants/genres.ts.',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (!filename) return {};
    if (filename.includes('node_modules')) return {};
    const isTest = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(filename);
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.name !== 'find') return;
        if (node.callee.object.type !== 'Identifier') return;
        if (node.callee.object.name !== 'GENRES') return;
        const args = node.arguments;
        if (args.length !== 1) return;
        if (args[0].type !== 'ArrowFunctionExpression' && args[0].type !== 'FunctionExpression') return;
        if (isTest) return; // Tests may need GENRES array for other purposes; only flag source
        context.report({ node, messageId: 'preferMap' });
      },
    };
  },
};

/**
 * `no-module-level-process-env`
 *
 * Flags module-level `const X = process.env...` and `let X = process.env...`
 * declarations in non-test source files. Module-level env reads are evaluated
 * at import time, which may be before `validateAndLoadEnv()` has run — causing
 * stale defaults or import-order bugs.
 *
 * Allowed patterns (no lint error):
 *  - `process.env.NODE_ENV` — this is always available and never validated
 *  - Reads inside a function/arrow (lazy evaluation) — the function won't be
 *    called until after env validation
 *  - Files matching the config allowlist (env.ts, test setup, etc.)
 */
const processEnvCalleePattern = {
  type: 'MemberExpression',
  object: { type: 'Identifier', name: 'process' },
  property: { type: 'Identifier', name: 'env' },
};

// Files that intentionally read process.env at module scope for
// configuration purposes.
const PERMISSIVE_FILES = [
  'config/env.ts',      // The validated env module itself (frontend + backend)
  'config/load-env.ts',  // Loads .env files into process.env
  'test/setup.ts',       // Test bootstrap — sets env before any module
  'src/test/setup.ts',   // Backend test bootstrap
  'vite.config.ts',       // Build tool config
  'playwright.config.ts',  // E2E config
  'next.config.ts',        // Next.js config
  'eslint.config.mjs',    // ESLint config
  'lib/config.ts',        // Frontend runtime config
];

function isAllowedEnvReadFile(filename) {
  if (!filename) return false;
  return PERMISSIVE_FILES.some((pattern) => filename.replace(/\\/g, '/').endsWith(pattern));
}

/**
 * Recursively walk an AST node to find any MemberExpression accessing
 * `process.env.X` inside it. Handles:
 *  - Direct: `const X = process.env.FOO`
 *  - Wrapped in CallExpression: `const X = parseInt(process.env.FOO || '0', 10)`
 *  - Wrapped in LogicalExpression: `const X = process.env.FOO || 'default'`
 *  - Wrapped in BinaryExpression: `const X = process.env.FOO + 'suffix'`
 *  - Nested in arguments: `const X = Math.max(1, parseInt(process.env.FOO || '2'))`
 */
function findProcessEnvAccess(node) {
  if (!node || typeof node !== 'object') return null;
  // Direct: process.env.FOO (dot access)
  if (node.type === 'MemberExpression' &&
      node.object?.type === 'MemberExpression' &&
      node.object.object?.type === 'Identifier' &&
      node.object.object.name === 'process' &&
      node.object.property?.type === 'Identifier' &&
      node.object.property.name === 'env') {
    // M62: also treat computed access (process.env['FOO']) as a read.
    if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
      return node.property.value;
    }
    if (!node.computed && node.property?.type === 'Identifier') {
      return node.property.name;
    }
  }
  // M62: bare `process.env` reference (e.g. destructuring `const { FOO } = process.env`)
  if (node.type === 'MemberExpression' &&
      node.object?.type === 'Identifier' &&
      node.object.name === 'process' &&
      node.property?.type === 'Identifier' &&
      node.property.name === 'env') {
    return '(process.env)';
  }
  // Do NOT descend into function bodies — reads inside a function are lazily
  // evaluated at call time and are explicitly allowed by this rule.
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return null;
  }
  // M62: full recursive walk (previously missed: callee chains, objects,
  // arrays, assignment, sequence, spread, chain expressions).
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        const found = findProcessEnvAccess(c);
        if (found) return found;
      }
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      const found = findProcessEnvAccess(child);
      if (found) return found;
    }
  }
  return null;
}

const noModuleLevelProcessEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow module-level `process.env.*` reads in non-test source files. These are evaluated at import time, before env validation runs. Wrap them in lazy getter functions instead (see config/env.ts for examples).',
    },
    schema: [],
    messages: {
      moduleLevelRead:
        'Module-level `process.env.{{name}}` is evaluated at import time, before env validation. Use a lazy getter function (e.g. `export function get{{pascalName}}(): string { return process.env.{{name}} || \'default\'; }`) or add it to the validated env system in config/env.ts.',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Skip test files (they set env vars for testing) and allowlisted config files
    if (isInTestFile(filename)) return {};
    if (isAllowedEnvReadFile(filename)) return {};
    return {
      VariableDeclarator(node) {
        if (!node.init) return;
        
        // Recursively search the init expression for process.env access
        const envName = findProcessEnvAccess(node.init);
        if (!envName) return;
        
        // Always allow NODE_ENV — it's set by the runtime and never validated
        if (envName === 'NODE_ENV') return;
        
        // Check if this variable declaration is at module scope (not inside a function/block)
        let scope = node.parent?.parent;
        while (scope) {
          if (scope.type === 'FunctionDeclaration' ||
              scope.type === 'FunctionExpression' ||
              scope.type === 'ArrowFunctionExpression' ||
              scope.type === 'MethodDefinition') {
            return; // Inside a function — lazy evaluation, acceptable
          }
          scope = scope.parent;
        }
        
        context.report({
          node,
          messageId: 'moduleLevelRead',
          data: { name: envName, pascalName: envName },
        });
      },
    };
  },
};

/**
 * `no-local-imported-function-collision`
 *
 * Flags a file where a local function declaration has the same name as an
 * imported function OR an imported binding. This prevents the class of bugs
 * where a developer writes a local utility function, gives it the same name
 * as an imported middleware/helper with a DIFFERENT signature, and callers
 * silently invoke the wrong overload.
 *
 * EXAMPLE OF THE BUG (fixed in generation.ts):
 *   import { verifyStoryOwnership } from '../middleware/story-ownership.js';
 *
 *   // Local function with same name but different signature (2 args vs 3)
 *   async function verifyStoryOwnership(storyId, userId) { ... }
 *
 *   // Callers of the LOCAL function type-check, but developers reading the
 *   // file expect the IMPORTED middleware. Adding or removing parameters
 *   // on one overload breaks the other silently.
 */
const noLocalImportedFunctionCollision = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow local function/const declarations that share a name with an imported binding. ' +
        'Same-name local+imported functions with different signatures are a maintenance hazard: ' +
        'one overload can be changed without updating the other, breaking callers silently.',
    },
    schema: [],
    messages: {
      collision:
        'Local function `{{name}}` has the same name as an imported binding on line {{importLine}}. ' +
        'Rename the local function to avoid confusion (imported: {{importSource}}).',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Only flag source files, not tests (test files often shadow imports intentionally)
    if (filename && /\.(test|spec)\./.test(filename)) return {};

    // Track all imported bindings: name → { line, source }
    const importedNames = new Map();

    // Track all function/const declarations at module scope
    const localFuncNames = new Map();

    return {
      ImportSpecifier(node) {
        const localName = node.local?.name;
        if (!localName) return;
        importedNames.set(localName, {
          line: node.loc?.start?.line ?? 0,
          source: node.parent?.source?.value ?? 'unknown',
        });
      },

      ImportDefaultSpecifier(node) {
        const localName = node.local?.name;
        if (!localName) return;
        importedNames.set(localName, {
          line: node.loc?.start?.line ?? 0,
          source: node.parent?.source?.value ?? 'unknown',
        });
      },

      'FunctionDeclaration:exit'(node) {
        const name = node.id?.name;
        if (!name) return;
        // Check if this is at module scope (no enclosing function/block)
        if (isModuleScope(node, context)) {
          localFuncNames.set(name, { node, line: node.loc?.start?.line ?? 0 });
        }
      },

      'VariableDeclarator:exit'(node) {
        const name = node.id?.name;
        if (!name || !node.init) return;
        // Only flag const/let at module scope that are function expressions
        // or arrow functions
        if (node.init.type !== 'FunctionExpression' &&
            node.init.type !== 'ArrowFunctionExpression') return;
        if (isModuleScope(node, context)) {
          localFuncNames.set(name, { node, line: node.loc?.start?.line ?? 0 });
        }
      },

      'Program:exit'() {
        for (const [name, localInfo] of localFuncNames) {
          const importInfo = importedNames.get(name);
          if (!importInfo) continue;
          // Exclude cases where the import source is the file itself or
          // the same package (these are re-exports, not collisions)
          context.report({
            node: localInfo.node,
            messageId: 'collision',
            data: {
              name,
              importLine: String(importInfo.line),
              importSource: importInfo.source,
            },
          });
        }
      },
    };
  },
};

function isModuleScope(node, context) {
  let scope = node.parent;
  while (scope) {
    if (scope.type === 'Program') return true;
    if (scope.type === 'FunctionDeclaration' ||
        scope.type === 'FunctionExpression' ||
        scope.type === 'ArrowFunctionExpression' ||
        scope.type === 'MethodDefinition' ||
        scope.type === 'BlockStatement' && scope.parent?.type === 'CatchClause') {
      return false;
    }
    scope = scope.parent;
  }
  return true;
}

const plugin = {
  meta: {
    name: 'eslint-plugin-cinematicai-test-quality',
  },
  rules: {
    'no-trivial-assertions': noTrivialAssertions,
    'click-needs-assertion': clickNeedsAssertion,
    'test-against-project-middleware': testAgainstProjectMiddleware,
    'no-module-level-process-env': noModuleLevelProcessEnv,
    'no-redundant-button-onkeydown': noRedundantButtonOnKeyDown,
    'prefer-genre-map': preferGenreMap,
    'no-local-imported-function-collision': noLocalImportedFunctionCollision,
  },
};

export default plugin;
