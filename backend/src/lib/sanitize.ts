/**
 * Sanitizes raw AI text responses by stripping think tags, markdown artifacts,
 * control characters, and other non-content tokens that the model may inject.
 * This is the superset version used across the backend.
 */
export function sanitizeAIResponse(response: string): string {
  return response
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    // Strip ALL control characters (0x00-0x1F) — their presence inside JSON
    // string values makes JSON.parse throw "Bad control character in string
    // literal". Previously excluded \x0D (CR) which some AI models emit.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]/g, '')
    .trim();
}

/**
 * JSON-specific sanitizer. Same as sanitizeAIResponse but preserves markdown
 * asterisks so the JSON repair layer can detect and fix **value** wrapping
 * before the final JSON.parse attempt.
 */
export function sanitizeJsonResponse(response: string): string {
  return response
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/^#+\s*/gm, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]/g, '')
    .trim();
}

/**
 * Extract the first balanced JSON value (object or array) from text, handling
 * leading/trailing content, nested braces/brackets, escaped quotes inside
 * strings, and truncated input (missing closing brace).
 *
 * Returns null if no JSON delimiters are found at all.
 */
function extractJson(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start = firstBrace === -1
    ? (firstBracket === -1 ? -1 : firstBracket)
    : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));

  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }

  // Unclosed — return the partial (caller will get JSON.parse error with
  // clearer context than failing on the full raw text with leading noise).
  return text.substring(start);
}

/**
 * Best-effort repair of common LLM JSON defects that make JSON.parse throw:
 *  - trailing commas before } / ]
 *  - truncation: an unterminated string and/or unbalanced { } [ ]
 *
 * Walks the string tracking string/escape state and a stack of open brackets,
 * then closes any still-open string and appends the missing closers in reverse
 * order. Returns the repaired candidate (callers still JSON.parse and fall
 * back to the original error if repair fails).
 */
function repairJson(text: string): string {
  let s = text.trim().replace(/,\s*([}\]])/g, '$1');
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  let out = s;
  if (inString) out += '"';
  while (stack.length > 0) out += stack.pop();
  // Appending closers can leave a trailing comma before a newly-added ] or }
  // (e.g. "[1,2," -> "[1,2,]"), so strip trailing commas once more.
  out = out.replace(/,\s*([}\]])/g, '$1');
  return out;
}

/**
 * Escape unescaped double-quotes that appear INSIDE JSON string values/keys —
 * the defect behind "Expected ',' or '}' after property value at position N".
 *
 * Rule: a `"` inside a string is the real terminator only if the next
 * non-whitespace character is a JSON structural delimiter (`:`, `,`, `}`, `]`)
 * or end-of-input. Any other `"` is treated as an embedded quote and escaped.
 * This is deterministic and conservative: it never alters well-formed JSON.
 */
function repairInnerQuotes(text: string): string {
  const s = text;
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      // Decide whether this quote terminates the string.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      const next = j < s.length ? s[j]! : '';
      const isTerminator = next === '' || next === ':' || next === ',' || next === '}' || next === ']';
      if (isTerminator) {
        inString = false;
        out += ch;
      } else {
        // Embedded unescaped quote inside a string value/key — escape it.
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Repair two more LLM JSON defects observed in production:
 *  1. Markdown asterisks wrapping a value: `"k": *"text"*  ->  `"k": "text"`
 *     (anchored to the value's opening quote after `:` and to a closing quote
 *     followed by `,`/`}`, so `*` inside a string is never touched).
 *  2. A missing opening quote on a string value: `"k": text"  ->  `"k": "text"`.
 *     Conservative: only fires when the value does not begin with a valid JSON
 *     token (`" { [ digit - t f n`) and ends with an unescaped quote.
 */
function repairMarkdownQuotes(text: string): string {
  let s = text.replace(/:(\s*)\*+\s*"/g, ':$1"').replace(/"\s*\*+(\s*[,}])/g, '"$1');
  s = s.replace(/:(\s*)\*+([^*"}\s][^*\n]*?)\*+(\s*[,}])/g, ':$1"$2"$3');
  s = s.replace(/:(\s*)([^"{[\s\d\-tfn][^,}\n]*?[^\\])"(\s*[,}])/g, ':$1"$2"$3');
  return s;
}

/**
 * Safely parses a JSON string by first sanitizing it through sanitizeAIResponse
 * to strip control characters, markdown, and other non-content tokens that AI
 * models may inject. Returns the parsed value.
 *
 * If the sanitized string is not valid JSON, a cascade of deterministic repairs
 * (unescaped inner quotes, markdown asterisks, missing opening quote, trailing
 * commas, truncation) is attempted before re-throwing the original error.
 */
export function safeJsonParse<T = unknown>(text: string): T {
  const extracted = extractJson(text) ?? text;
  const cleaned = sanitizeJsonResponse(extracted);
  const mdFixed = repairMarkdownQuotes(cleaned);
  const innerFixed = repairInnerQuotes(mdFixed);
  const candidates = [cleaned, mdFixed, innerFixed, repairJson(innerFixed)];
  let firstErr: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (err) {
      if (firstErr === undefined) firstErr = err;
    }
  }
  throw firstErr;
}