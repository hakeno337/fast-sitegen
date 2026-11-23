// A faster drop-in for makefun-site 1.0.0: the same build, byte for byte, written as one
// purpose-built pass per stage instead of a general plugin pipeline.
//
// run(input) takes { site, templates, files } and returns the output tree (path -> text) that
// makefun-site 1.0.0's build returns for it. The dialect is makefun-site's own (its README states
// it): strict front matter, a small Markdown subset, and a template language of {{ }}, {{{ }}}
// and {% %} tags. Where speed comes from: fused lex-and-render Markdown with bulk escaping,
// compiled templates rendered into one buffer, slugify memoised per build, cards built once.

'use strict';

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

const SLUG_MAX = 64;

/** Whether every code unit of `text` is ASCII (NFKD is the identity on ASCII, and no ASCII char is a combining mark). */
function isAscii(text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), "untitled" when nothing is left.
 */
function slugifyRaw(text) {
  const plain = isAscii(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, body } or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Lines are walked by offset; the body is one slice, never rejoined.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---\n') && text !== '---') {
    // The first line must be exactly "---": either the whole text or a first line ending at \n.
    if (text.indexOf('\n') === -1 || text.slice(0, text.indexOf('\n')) !== '---') return { error: 'no front matter' };
  }
  // Collect the lines of the front matter region and find the closing line.
  const lines = [];
  let pos = 0;
  let close = -1;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    lines.push(text.slice(pos, end));
    if (lines.length > 1 && lines[lines.length - 1] === '---') {
      close = lines.length - 1;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (lines[0] !== '---') return { error: 'no front matter' };
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, before `end`, or -1. */
function findUnescaped(s, what, from, end) {
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, before `end`, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[start, end)` rendered inline into `out` (an array of pieces); `link(target)` is a link's
 * (already escaped) href. Plain runs are escaped in bulk; spans recurse on ranges, never slices,
 * and every search is bounded by `end` exactly as if the range were its own string.
 */
function inlineInto(s, start, end, link, out) {
  let i = start;
  let runStart = start;
  const flush = (to) => {
    if (to > runStart) out.push(escHtml(s.slice(runStart, to)));
  };
  while (i < end) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < end && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        out.push(escHtml(s[i + 1]));
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        flush(i);
        out.push('<code>', escHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, end);
      const m = k !== -1 && k + 1 < end && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= end ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', link(target), '">');
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        runStart = i;
      } else i++;
      continue;
    }
    i++;
  }
  flush(end);
}

const SPECIALS = /[\\`*[]/;

/** `s` rendered inline, as one string. `link` maps a target to its escaped href. */
function inline(s, link) {
  if (!SPECIALS.test(s)) return escHtml(s);
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/** A line with spaces and tabs at either end dropped, by scan rather than regex. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or ""). Lexing and
 * rendering are one pass; each line is classified once. `slug` is the build's memoised slugify.
 */
function renderMarkdown(src, link, slug) {
  const lines = src.split('\n');
  const n = lines.length;
  const kinds = new Array(n);
  const classify = (idx) => {
    let k = kinds[idx];
    if (k !== undefined) return k;
    const line = lines[idx];
    if (MD_BLANK.test(line)) k = { t: 'blank' };
    else {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) k = { t: 'fence', lang: fence[1] };
      else {
        const hm = MD_HEADING.exec(line);
        if (hm !== null && hm[2] !== '') k = { t: 'heading', depth: hm[1].length, text: hm[2] };
        else if (MD_HR.test(line)) k = { t: 'hr' };
        else if (line.charCodeAt(0) === 62) k = { t: 'quote' };
        else {
          const b = MD_BULLET.exec(line);
          const o = b === null ? MD_ORDERED.exec(line) : null;
          if (b !== null) k = { t: 'list', ordered: false, first: b[1] };
          else if (o !== null) k = { t: 'list', ordered: true, start: Number(o[1]), first: o[2] };
          else k = { t: 'text' };
        }
      }
    }
    kinds[idx] = k;
    return k;
  };
  const endsParagraph = (idx) => {
    const t = classify(idx).t;
    return t === 'blank' || t === 'fence' || t === 'heading' || t === 'hr';
  };

  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const k = classify(i);
    if (k.t === 'blank') {
      i++;
      continue;
    }
    if (k.t === 'fence') {
      const body = [];
      i++;
      while (i < n && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = k.lang === '' ? '' : ` class="language-${escHtml(k.lang)}"`;
      out.push(`<pre><code${cls}>${body.length === 0 ? '' : escHtml(body.join('\n') + '\n')}</code></pre>\n`);
      continue;
    }
    if (k.t === 'heading') {
      const id = uniqueSlug(slug(k.text), ids);
      const html = inline(k.text, link);
      out.push(`<h${k.depth} id="${id}">${html}</h${k.depth}>\n`);
      if (k.depth === 2 || k.depth === 3) toc.push({ level: k.depth, id, html });
      i++;
      continue;
    }
    if (k.t === 'hr') {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (k.t === 'quote') {
      const body = [];
      while (i < n && classify(i).t === 'quote') body.push(lines[i++].replace(/^> ?/, ''));
      const kept = body.map(trimLine).filter((l) => l !== '');
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    if (k.t === 'list') {
      const marker = k.ordered ? MD_ORDERED : MD_BULLET;
      const items = [];
      items.push([trimLine(k.first)]);
      i++;
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(k.ordered ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = k.ordered ? 'ol' : 'ul';
      const open = k.ordered && k.start !== 1 ? `<ol start="${k.start}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const item of items) block += `<li>${inline(item.join('\n'), link)}</li>\n`;
      out.push(`${block}</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and each following line that does not end one.
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && !endsParagraph(i)) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** A template that does not parse: an Error whose message names the template and the reason. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const pushText = (text) => {
    if (text !== '') body.push({ kind: 'text', text });
  };
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
      pushText(text);
      text = '';
      body.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText(text);
    text = '';
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
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
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText(text);
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  if (path.length === 1) return v;
  const second = path[1];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, second)) return undefined;
  v = v[second];
  for (let k = 2; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope`; `ctx` holds the parsed templates (a Map) and the include depth. */
function renderInto(nodes, scope, ctx, out, depth) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var': {
        const v = lookup(scope, nd.path);
        if (typeof v === 'string') {
          // The same strings (titles, urls, tag names) are written on page after page.
          let e = ctx.escCache.get(v);
          if (e === undefined) {
            e = escHtml(v);
            ctx.escCache.set(v, e);
          }
          out.push(e);
        } else out.push(escHtml(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scope, nd.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderInto(branch, scope, ctx, out, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderInto(nd.body, { vars, parent: scope }, ctx, out, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, out, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace (\s, the full JS set). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let ws;
    if (code < 128) ws = code === 32 || (code >= 9 && code <= 13);
    else ws = code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's build of the same input. */
export function run(input) {
  // slugify, memoised for the whole build: titles, tags and headings repeat constantly.
  const slugCache = new Map();
  const slug = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Templates first, in name order: one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in path order; a .md file is a source, anything else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in their order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved against the built pages and the static files. The link function
  // returns the href already HTML-escaped, ready for the inline renderer to write.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      // Only resolutions that do not depend on this source are cached: a broken link is
      // reported per source, so its outcome is never shared.
      const cacheKey = `${dir}\n${target}`;
      let hit = linkCache.get(cacheKey);
      if (hit !== undefined) return hit;
      let out;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
        out = target;
      } else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
        else {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return escHtml(target);
        }
      }
      out = escHtml(out);
      linkCache.set(cacheKey, out);
      return out;
    };
    const md = renderMarkdown(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met in the posts' order, ordered by count then slug.
  const tagBySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      if (!tagBySlug.has(sl)) tagBySlug.set(sl, { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] });
      const tag = tagBySlug.get(sl);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => tagBySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page, the index pages and the tag pages; then the static files.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    // A post's card is the one already built for the collections; only a page builds its own.
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escCache: new Map() };
  // Every render sees the same site, tags and recent: they sit in one shared base scope, and a
  // render's own vars chain over it (the reference merges them into the root vars; the vars a
  // render passes never reuse those three names, and the guard keeps the merge for any that did).
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const scope = 'site' in vars || 'tags' in vars || 'recent' in vars
      ? { vars: { site, tags: allTags, recent, ...vars }, parent: null }
      : { vars, parent: baseScope };
    renderInto(nodes, scope, ctx, out, 0);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
