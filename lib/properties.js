'use strict';

// Java .properties as Minecraft writes server.properties: comments and order
// survive a round trip, values are escaped the way Properties.store does
// (`level-type=minecraft\:normal`), and the file is UTF-8.

function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
  });
}

function escape(s, isKey) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') out += '\\\\';
    else if (c === '\t') out += '\\t';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\f') out += '\\f';
    else if ('=:#!'.includes(c)) out += `\\${c}`;
    else if (c === ' ' && (isKey || i === 0)) out += '\\ ';
    else out += c;
  }
  return out;
}

// Splits a logical line into key and raw value at the first unescaped
// '=', ':' or whitespace run.
function splitLine(line) {
  let i = 0;
  while (i < line.length && /[ \t\f]/.test(line[i])) i++;
  let key = '';
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      key += c + (line[i + 1] ?? '');
      i++;
    } else if (c === '=' || c === ':' || /[ \t\f]/.test(c)) break;
    else key += c;
  }
  while (i < line.length && /[ \t\f]/.test(line[i])) i++;
  if (line[i] === '=' || line[i] === ':') i++;
  while (i < line.length && /[ \t\f]/.test(line[i])) i++;
  return [unescape(key), unescape(line.slice(i))];
}

function parse(text) {
  const physical = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (physical.length && physical[physical.length - 1] === '') physical.pop();
  const entries = [];
  for (let n = 0; n < physical.length; n++) {
    let raw = physical[n];
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed[0] === '#' || trimmed[0] === '!') {
      entries.push({ type: 'other', raw });
      continue;
    }
    // Line continuation: an odd number of trailing backslashes.
    let logical = raw;
    while (/(^|[^\\])(\\\\)*\\$/.test(logical) && n + 1 < physical.length) {
      logical = logical.slice(0, -1) + physical[++n].trimStart();
      raw += `\n${physical[n]}`;
    }
    const [key, value] = splitLine(logical);
    entries.push({ type: 'kv', key, value, raw });
  }
  return { entries };
}

function toObject(doc) {
  const out = {};
  for (const e of doc.entries) if (e.type === 'kv') out[e.key] = e.value;
  return out;
}

// Returns a new document with `updates` applied; changed lines are rewritten,
// new keys are appended, everything else stays byte for byte.
function set(doc, updates) {
  const pending = new Map(Object.entries(updates));
  const entries = doc.entries.map((e) => {
    if (e.type !== 'kv' || !pending.has(e.key)) return e;
    const value = String(pending.get(e.key));
    pending.delete(e.key);
    if (value === e.value) return e;
    return { type: 'kv', key: e.key, value, raw: `${escape(e.key, true)}=${escape(value, false)}` };
  });
  for (const [key, v] of pending) {
    const value = String(v);
    entries.push({ type: 'kv', key, value, raw: `${escape(key, true)}=${escape(value, false)}` });
  }
  return { entries };
}

function stringify(doc) {
  return doc.entries.map((e) => e.raw).join('\n') + '\n';
}

module.exports = { parse, toObject, set, stringify, escape, unescape };
