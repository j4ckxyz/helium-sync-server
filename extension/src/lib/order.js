// Ordering helpers shared by the bookmark and tab engines.
//
// Positions are fractional-index strings ("order keys"): any two keys have
// infinitely many keys between them, so moving one item rewrites only that
// item's record and concurrent moves on different devices both survive.
// Ties (two devices inserting at the same spot) are broken by record id.
//
// Keys have a variable-length integer part (head letter = length) followed
// by a fraction, so appending and prepending — the common cases — produce
// short keys (a0, a1, … az, b00 …). This follows the public-domain
// "fractional-indexing" algorithm by David Greenspan / Rocicorp.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const SMALLEST_INT = 'A' + ZERO.repeat(26);

function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error('trailing zero');
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

function intLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head ${head}`);
}

function intPart(key) {
  const n = intLength(key[0]);
  if (n > key.length) throw new Error(`invalid order key ${key}`);
  return key.slice(0, n);
}

function validate(key) {
  if (typeof key !== 'string' || key === SMALLEST_INT) throw new Error('invalid order key');
  const i = intPart(key);
  for (const c of key) if (DIGITS.indexOf(c) < 0) throw new Error('invalid order key');
  if (key.slice(i.length).slice(-1) === ZERO) throw new Error('invalid order key');
}

export function validKey(key) {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

function increment(x) {
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push(ZERO);
  else digs.pop();
  return h + digs.join('');
}

function decrement(x) {
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = DIGITS.slice(-1);
    else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + DIGITS.slice(-1);
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(DIGITS.slice(-1));
  else digs.pop();
  return h + digs.join('');
}

function between(a, b) {
  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const ib = intPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const r = decrement(ib);
    if (r === null) throw new Error('cannot decrement');
    return r;
  }
  if (b === null) {
    const ia = intPart(a);
    const i = increment(ia);
    return i === null ? ia + midpoint(a.slice(ia.length), null) : i;
  }
  const ia = intPart(a);
  const ib = intPart(b);
  if (ia === ib) return ia + midpoint(a.slice(ia.length), b.slice(ib.length));
  const i = increment(ia);
  if (i === null) throw new Error('cannot increment');
  if (i < b) return i;
  return ia + midpoint(a.slice(ia.length), null);
}

function sanitize(a, b) {
  if (a !== null && !validKey(a)) a = null;
  if (b !== null && !validKey(b)) b = null;
  if (a !== null && b !== null && a >= b) b = null; // tied/corrupt: place after a
  return [a, b];
}

/** Returns a key strictly between a and b (either may be null for an open end). */
export function keyBetween(a, b) {
  [a, b] = sanitize(a, b);
  return between(a, b);
}

/** n ordered keys between a and b, kept short for bulk inserts. */
export function keysBetween(a, b, n) {
  [a, b] = sanitize(a, b);
  const rec = (a, b, n) => {
    if (n <= 0) return [];
    if (n === 1) return [between(a, b)];
    if (b === null) {
      const out = [];
      let c = a;
      for (let i = 0; i < n; i++) out.push((c = between(c, null)));
      return out;
    }
    if (a === null) {
      const out = [];
      let c = b;
      for (let i = 0; i < n; i++) out.push((c = between(null, c)));
      return out.reverse();
    }
    const mid = Math.floor(n / 2);
    const c = between(a, b);
    return [...rec(a, c, mid), c, ...rec(c, b, n - mid - 1)];
  };
  return rec(a, b, n);
}

export function compareOrder(a, b) {
  const ka = a.o || '';
  const kb = b.o || '';
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Indices (into seq) of a longest strictly increasing subsequence, O(n log n). */
export function lis(seq) {
  const tails = [];
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/**
 * Assigns order keys to items listed in their current local order. Items
 * keep their key when it fits the order of the other kept items (a longest
 * increasing run); the rest get fresh keys between their neighbours.
 * Returns Map(id -> key) for items whose key changed.
 *
 * items: [{ id, o?: existingKey }]
 */
export function reorder(items) {
  const changed = new Map();
  const keyed = [];
  items.forEach((it, i) => {
    if (validKey(it.o)) keyed.push(i);
  });
  const keep = new Set(lis(keyed.map((i) => items[i].o)).map((j) => keyed[j]));
  const keys = items.map((it, i) => (keep.has(i) ? it.o : null));
  let i = 0;
  while (i < items.length) {
    if (keys[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && keys[j] === null) j++;
    const fresh = keysBetween(i > 0 ? keys[i - 1] : null, j < items.length ? keys[j] : null, j - i);
    for (let k = i; k < j; k++) {
      keys[k] = fresh[k - i];
      changed.set(items[k].id, keys[k]);
    }
    i = j;
  }
  return changed;
}
