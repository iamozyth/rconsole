'use strict';

// A parser for SNBT, the text form of NBT that `data get entity` prints:
// {Health: 20.0f, Pos: [1.5d, 64.0d, -3.2d], Inventory: [{count: 1, Slot: 0b,
// id: "minecraft:stone"}]}. Numbers lose their type suffix; typed arrays
// ([I; 1, 2]) become plain arrays.

const TRUNCATED = Symbol('truncated'); // thrown where the reply was cut mid-token
const BARE = /[\p{L}\p{N}_\-.+]+/uy;

// A value that can't be understood (newer syntax, say) is skipped up to the
// next separator at its level and reported through onSkip, so one odd item
// component doesn't lose the whole inventory.
//
// Minecraft 26.x shortens long `data get` replies and ends them with "...".
// What came before is kept; `state.truncated` tells the caller to ask for
// smaller pieces.
function parse(text, { onSkip, state = {} } = {}) {
  let i = 0;
  const s = String(text);
  const cut = () => {
    if (s.startsWith('...', i)) {
      state.truncated = true;
      i = s.length;
    }
    return state.truncated;
  };
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const fail = (msg) => {
    throw new Error(`SNBT: ${msg} at ${i}`);
  };
  const quoted = () => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\') {
        i++;
        const c = s[i++];
        if (c === 'u' || c === 'x') {
          const n = c === 'u' ? 4 : 2;
          out += String.fromCharCode(parseInt(s.slice(i, i + n), 16) || 0xfffd);
          i += n;
        } else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[c] ?? c;
      } else out += s[i++];
    }
    if (s[i] !== q) {
      if (s.endsWith('...')) throw TRUNCATED;
      fail('unterminated string');
    }
    i++;
    return out;
  };
  const bare = () => {
    BARE.lastIndex = i;
    const m = BARE.exec(s);
    if (!m) fail('unexpected character');
    if (m[0].includes('...')) throw TRUNCATED; // a partial number or word can't be trusted
    i += m[0].length;
    return m[0];
  };
  const scalar = (word) => {
    if (word === 'true') return true;
    if (word === 'false') return false;
    const m = word.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([bslfd]?)$/i);
    return m ? Number(m[1]) : word;
  };
  // Moves i to the next , } or ] outside brackets and strings.
  const skip = (from) => {
    let depth = 0;
    i = from;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'") {
        try {
          quoted();
        } catch {
          i = s.length;
        }
        continue;
      }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      i++;
    }
    state.skipped = true;
    if (onSkip) onSkip(s.slice(Math.max(0, from - 40), Math.min(s.length, i + 40)), from);
    return undefined;
  };
  // A value, or undefined when it had to be skipped.
  const entry = () => {
    ws();
    if (cut()) return undefined;
    const from = i;
    let v;
    try {
      v = value();
    } catch (err) {
      if (err === TRUNCATED) {
        state.truncated = true;
        i = s.length;
        return undefined;
      }
      if (!onSkip) throw err;
      return skip(from);
    }
    ws();
    if (cut()) return v;
    if (onSkip && i < s.length && s[i] !== ',' && s[i] !== '}' && s[i] !== ']') return skip(from);
    return v;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (s[i] === '}') return i++, obj;
      for (;;) {
        ws();
        if (cut()) return obj;
        const key = s[i] === '"' || s[i] === "'" ? quoted() : bare();
        ws();
        if (s[i++] !== ':') fail('expected :');
        const v = entry();
        if (v !== undefined) obj[key] = v;
        if (state.truncated) return obj;
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i++] === '}') return obj;
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (/^[BIL];/.test(s.slice(i, i + 2))) i += 2; // typed array
      const arr = [];
      ws();
      if (s[i] === ']') return i++, arr;
      for (;;) {
        ws();
        if (cut()) return arr;
        const v = entry();
        if (v !== undefined) arr.push(v);
        if (state.truncated) return arr;
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i++] === ']') return arr;
        fail('expected , or ]');
      }
    }
    if (c === '"' || c === "'") return quoted();
    return scalar(bare());
  };
  const v = entry();
  if (state.truncated) return v;
  ws();
  if (i < s.length) fail('trailing characters');
  return v;
}

// The SNBT after "<name> has the following entity data: ".
function entityData(reply, opts) {
  const m = String(reply).match(/has the following entity data: ([\s\S]*)$/);
  return m ? parse(m[1].trim(), opts) : undefined;
}

module.exports = { parse, entityData };
