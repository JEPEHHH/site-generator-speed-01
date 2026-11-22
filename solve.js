// solve.js: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the tree makefun-site 1.0.0's build(input) returns (vendor/makefun-site/ is the
// semantic authority), in less CPU time. The pipeline, the plugin order and every rule are the reference's; what
// differs is how the hot paths are written: the HTML escape is one scan instead of five passes, Markdown is lexed and
// rendered in a single walk with plain text batched, and the pure text functions (slug, long date, escape of the
// values templates repeat) are memoised.

const AMP = '&amp;';
const LT = '&lt;';
const GT = '&gt;';
const QUOT = '&quot;';
const APOS = '&#39;';

/** The characters HTML escaping replaces. */
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_CHARS = /[&<>"']/g;
const ESCAPES = { '&': AMP, '<': LT, '>': GT, '"': QUOT, "'": APOS };
const escapeOne = (c) => ESCAPES[c];

/**
 * `text` with & < > " ' escaped. One regexp pass with a hoisted callback: V8 copies the untouched spans itself,
 * and the string comes back unchanged when there is nothing to escape.
 */
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_CHARS, escapeOne) : text;
}

/** One character, escaped (only `>` of the escapable set needs it). */
function escapeChar(code) {
  if (code === 38) return AMP;
  if (code === 60) return LT;
  if (code === 62) return GT;
  if (code === 34) return QUOT;
  if (code === 39) return APOS;
  return String.fromCharCode(code);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text`'s slug: NFKD, marks dropped, A-Z lowered, runs of no a-z0-9 one "-", cut to SLUG_MAX, "untitled" if empty. */
function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const out = [];
  let any = false;
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain.charCodeAt(i);
    let keep = -1;
    if (ch >= 65 && ch <= 90) keep = ch + 32;
    else if (ch >= 97 && ch <= 122) keep = ch;
    else if (ch >= 48 && ch <= 57) keep = ch;
    if (keep === -1) {
      if (any) gap = true;
      continue;
    }
    if (gap) out.push('-');
    gap = false;
    any = true;
    out.push(String.fromCharCode(keep));
  }
  let s = out.join('');
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX);
    let e = s.length;
    while (e > 0 && s.charCodeAt(e - 1) === 45) e--;
    s = s.slice(0, e);
  }
  return s === '' ? 'untitled' : s;
}

/** Memoised slugs and long dates: pure functions of the string, and titles, tag names and dates repeat. */
const slugMemo = new Map();
const dateMemo = new Map();

/** The slug of `text`. */
function slugify(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  const value = slugifySlow(text);
  if (slugMemo.size >= 16384) slugMemo.clear();
  if (text.length <= 1024) slugMemo.set(text, value);
  return value;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = dateMemo.get(date);
  if (hit !== undefined) return hit;
  const parts = date.split('-');
  const value = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
  if (dateMemo.size >= 4096) dateMemo.clear();
  dateMemo.set(date, value);
  return value;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    const end = len - 1;
    let out = null;
    let last = 1;
    for (let i = 1; i < end; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        if (out === null) out = [];
        out.push(raw.slice(last, i), String.fromCharCode(n));
        i++;
        last = i + 1;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    if (out === null) return { value: raw.slice(1, end) };
    if (last < end) out.push(raw.slice(last, end));
    return { value: out.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (const part of parts) {
        const t = part.trim();
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** One front matter line: { key, raw } or null when it is not "key: value". */
function keyLine(line) {
  const n = line.length;
  let k = 0;
  while (k < n) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || k >= n || line.charCodeAt(k) !== 58) return null;
  if (k + 1 === n) return { key: line.slice(0, k), raw: '' };
  if (line.charCodeAt(k + 1) !== 32) return null;
  let end = n;
  while (end > k + 2) {
    const c = line.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  return { key: line.slice(0, k), raw: line.slice(k + 2, end) };
}

/**
 * A source's front matter and body: { data, body }, or { error }. Scans the text in place: no line array, and the
 * body is a slice of the source rather than a re-join.
 */
function parseFrontMatter(text) {
  const n = text.length;
  if (n < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (n > 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let pos = 4;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let ln = 1;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl > closeStart ? closeStart : nl;
    const line = text.slice(pos, lineEnd);
    pos = lineEnd + 1;
    ln++;
    let k = 0;
    const len = line.length;
    while (k < len) {
      const c = line.charCodeAt(k);
      if (c === 32 || c === 9) k++;
      else break;
    }
    if (k === len) continue;
    if (line.charCodeAt(0) === 35) continue;
    const kl = keyLine(line);
    if (kl === null) return { error: `line ${ln} is not "key: value"` };
    const key = kl.key;
    const raw = kl.raw;
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === n ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Any character that can start an inline construct. */
const INLINE_SPECIAL = /[\\`*[]/;
const HAS_SPACE = /\s/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A table of the ASCII whitespace, so the word scan is one array read per character. */
const WS_ASCII = new Uint8Array(128);
for (const ch of ' \t\n\v\f\r') WS_ASCII[ch.charCodeAt(0)] = 1;

/** Whether a code unit above ASCII is whitespace (the rest of \s). */
function isWsWide(c) {
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Whether `c` is whitespace (exactly \s). */
function isWs(c) {
  return c < 128 ? WS_ASCII[c] === 1 : isWsWide(c);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (WS_ASCII[c] === 1) inWord = 0;
      else if (inWord === 0) {
        count++;
        inWord = 1;
      }
    } else if (isWsWide(c)) inWord = 0;
    else if (inWord === 0) {
      count++;
      inWord = 1;
    }
  }
  return count;
}

/** The first index from `from` where `s` holds an unescaped "]". */
function findCloseBracket(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds an unescaped "**". */
function findStrongClose(s, from) {
  const limit = s.length - 2;
  for (let j = from; j <= limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped whole, never a char at a time. */
function inline(s, env) {
  const n = s.length;
  if (n === 0) return '';
  if (!INLINE_SPECIAL.test(s)) return escapeHtml(s);
  let out = '';
  let i = 0;
  let last = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        if (i > last) out += escapeHtml(s.slice(last, i));
        out += escapeChar(s.charCodeAt(i + 1));
        i += 2;
        last = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > last) out += escapeHtml(s.slice(last, i));
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        last = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2);
        if (j > i + 2) {
          if (i > last) out += escapeHtml(s.slice(last, i));
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          last = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > last) out += escapeHtml(s.slice(last, i));
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        last = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findCloseBracket(s, i + 1);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !HAS_SPACE.test(target)) {
        if (i > last) out += escapeHtml(s.slice(last, i));
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        last = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (last < n) out += escapeHtml(s.slice(last, n));
  return out;
}

/** Whether a line holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence line's language ("" when none) or null when the line opens no fence. */
function fenceLang(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < n) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const langEnd = k;
  while (k < n) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return line.slice(3, langEnd);
}

/** Whether a line closes a fence: three backticks and spaces or tabs. */
function isFenceClose(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= n) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let s = k;
  while (s < n) {
    const d = line.charCodeAt(s);
    if (d !== 32 && d !== 9) break;
    s++;
  }
  let e = n;
  while (e > s) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  if (e === s) return null;
  return { depth: k, text: e === n ? line.slice(s) : line.slice(s, e) };
}

/** A thematic break: --- or *** and spaces or tabs. */
function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let k = 3; k < n; k++) {
    const d = line.charCodeAt(k);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== 32) return null;
  return line.slice(2);
}

/** An ordered item: its number and text, or null. */
function orderedOf(line) {
  const n = line.length;
  let k = 0;
  while (k < n) {
    const c = line.charCodeAt(k);
    if (c < 48 || c > 57) break;
    k++;
  }
  if (k === 0 || k > 9 || k + 1 >= n) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { number: line.slice(0, k), text: line.slice(k + 2) };
}

/** Whether a line continues a list item: two or more spaces and then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 32) k++;
  if (k >= n) return false;
  return !isWs(line.charCodeAt(k));
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  const n = line.length;
  let s = 0;
  while (s < n) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = n;
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  if (s === 0 && e === n) return line;
  if (e === s) return '';
  return line.slice(s, e);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return isBlank(line);
}

/** The trimmed line when it continues a paragraph, or null when the line ends one. */
function paraLine(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) {
    if (fenceLang(line) !== null) return null;
  } else if (c0 === 35) {
    if (headingOf(line) !== null) return null;
  } else if (c0 === 45 || c0 === 42) {
    if (isHr(line)) return null;
  }
  const t = trimLine(line);
  return t === '' ? null : t;
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt. Lexing and rendering are one walk (the
 * reference lexes to tokens and then renders them; the blocks and their order are identical).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const count = lines.length;
  const ids = new Set();
  const toc = [];
  const out = [];
  let excerpt = null;
  let i = 0;
  while (i < count) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        out.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`);
        while (i < count && !isFenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      let body = '';
      while (i < count && lines[i].charCodeAt(0) === 62) {
        let t = lines[i];
        t = t.charCodeAt(1) === 32 ? t.slice(2) : t.slice(1);
        t = trimLine(t);
        if (t !== '') body = body === '' ? t : body + '\n' + t;
        i++;
      }
      out.push(body === '' ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(body, env) + '</p>\n</blockquote>\n');
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedOf(line);
      if (first !== null) {
        const start = Number(first.number);
        out.push(start !== 1 ? `<ol start="${start}">` : '<ol>', '\n');
        let cur = trimLine(first.text);
        i++;
        while (i < count) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) {
            out.push('<li>', inline(cur, env), '</li>\n');
            cur = trimLine(m.text);
            i++;
          } else if (isContinued(l)) {
            cur = cur + '\n' + trimLine(l);
            i++;
          } else break;
        }
        out.push('<li>', inline(cur, env), '</li>\n</ol>\n');
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      const text = bulletOf(line);
      if (text !== null) {
        out.push('<ul>\n');
        let cur = trimLine(text);
        i++;
        while (i < count) {
          const l = lines[i];
          const m = bulletOf(l);
          if (m !== null) {
            out.push('<li>', inline(cur, env), '</li>\n');
            cur = trimLine(m);
            i++;
          } else if (isContinued(l)) {
            cur = cur + '\n' + trimLine(l);
            i++;
          } else break;
        }
        out.push('<li>', inline(cur, env), '</li>\n</ul>\n');
        continue;
      }
    }
    if (isBlank(line)) {
      i++;
      continue;
    }
    let body = trimLine(line);
    i++;
    while (i < count) {
      const t = paraLine(lines[i]);
      if (t === null) break;
      body = body + '\n' + t;
      i++;
    }
    const html = inline(body, env);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_RE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  const head = path[0];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = [];
    for (const x of v) parts.push(textOf(x));
    return parts.join(', ');
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Renders `nodes` in `scope` into a string (a page is one walk; no per-node array). */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const s = textOf(lookup(scope, n.path));
        if (s.length !== 0) out += ctx.escape(s);
        break;
      }
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  const date = s.data.date;
  return {
    title: s.data.title,
    url: s.url,
    date: date ?? '',
    date_long: date === undefined ? '' : longDate(date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it; `card` is its card when one is already built. */
function pageOf(s, card) {
  const base = card ?? cardOf(s);
  const toc = [];
  for (const h of s.toc) toc.push({ level: h.level, id: h.id, html: h.html });
  return {
    title: base.title,
    url: base.url,
    date: base.date,
    date_long: base.date_long,
    summary: base.summary,
    excerpt: base.excerpt,
    reading_minutes: base.reading_minutes,
    tags: base.tags,
    slug: s.slug,
    content: s.html,
    toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const baseUrl = input.site.base_url;
  const base = baseUrl.endsWith('/') ? baseUrl.replace(/\/+$/, '') : baseUrl;
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  const site = input.site;

  // 1. sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      b.sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. permalinks.
  const taken = new Map();
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. markdown, links resolved.
  const staticPaths = new Set();
  for (const f of b.statics) staticPaths.add(f.path);
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections.
  const posts = [];
  for (const s of b.sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const list = s.data.tags ?? [];
    const seen = new Set();
    const res = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        res.push(name);
      }
    }
    return res;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts.
  const cardCache = new Map();
  for (const p of b.posts) cardCache.set(p, cardOf(p));
  b.cards = cardCache;
  const siteVars = { title: site.title, base_url: b.base };
  const allTags = [];
  for (const t of b.tags) allTags.push({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length });
  const recent = [];
  const recentCount = Math.min(site.recent, b.posts.length);
  for (let k = 0; k < recentCount; k++) recent.push(cardCache.get(b.posts[k]));
  const escapeMemo = new Map();
  const ctx = {
    templates,
    escape: (text) => {
      if (text.length > 1024) return escapeHtml(text);
      const hit = escapeMemo.get(text);
      if (hit !== undefined) return hit;
      const value = escapeHtml(text);
      if (escapeMemo.size >= 16384) escapeMemo.clear();
      escapeMemo.set(text, value);
      return value;
    },
  };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site: siteVars, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cardCache.get(s)) });
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const pagePosts = [];
    for (let j = (k - 1) * per; j < k * per && j < b.posts.length; j++) pagePosts.push(cardCache.get(b.posts[j]));
    const html = render('index', {
      posts: pagePosts,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const cards = [];
    for (const p of t.posts) cards.push(cardCache.get(p));
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: cards } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. the report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of b.sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
