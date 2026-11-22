// End-to-end encryption for Helium Sync.
//
//   password ──PBKDF2-SHA256(salt, iterations)──▶ master (32 bytes)
//   master ──HKDF "helium-sync/auth/v1"──▶ authKey   (sent to the server, which
//                                                    stores an Argon2id hash)
//   master ──HKDF "helium-sync/kek/v1"───▶ kek       (never leaves the device)
//   dataKey (random 32 bytes, wrapped with kek and stored on the server)
//   dataKey ──HKDF "helium-sync/records/v1"──▶ AES-256-GCM record key
//   dataKey ──HKDF "helium-sync/ids/v1"──────▶ HMAC-SHA256 key for record ids
//
// Records are encrypted with a fresh 96-bit IV and the collection and record
// id as associated data, so the server cannot move ciphertext between
// records. Derived keys are non-extractable CryptoKeys.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const DEFAULT_ITERATIONS = 600_000;
// Record formats: 1 = JSON, 2 = deflate-compressed JSON (used when it is
// smaller). Readers accept every format up to SUPPORTED; newer formats from a
// newer extension are skipped, never misread.
const FORMAT_JSON = 1;
const FORMAT_DEFLATE = 2;
export const SUPPORTED_FORMAT = 2;
const COMPRESS_MIN = 200;

export class UnsupportedFormat extends Error {}

const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function b64encode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hkdfBits(baseKey, info, bits = 256) {
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, baseKey, bits));
}

async function hkdfAesKey(baseKey, info, usages) {
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, baseKey, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** Stretches a password into the authKey (for the server) and the kek. */
export async function deriveAccountKeys(password, salt, iterations) {
  const pw = await subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);
  const base = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const authKey = await hkdfBits(base, 'helium-sync/auth/v1');
  const kek = await hkdfAesKey(base, 'helium-sync/kek/v1', ['encrypt', 'decrypt']);
  return { authKey, kek };
}

const WRAP_AAD = te.encode('helium-sync/datakey/v1');

export async function wrapDataKey(kek, dataKey) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, dataKey));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function unwrapDataKey(kek, wrapped) {
  const iv = wrapped.subarray(0, 12);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, wrapped.subarray(12)));
  } catch {
    throw new Error('Could not decrypt the account key. Is the password correct?');
  }
}

/** Derives the record encryption and id keys from the raw data key. */
export async function deriveDataKeys(dataKey) {
  const base = await subtle.importKey('raw', dataKey, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const enc = await hkdfAesKey(base, 'helium-sync/records/v1', ['encrypt', 'decrypt']);
  const idBits = await hkdfBits(base, 'helium-sync/ids/v1');
  const ids = await subtle.importKey('raw', idBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  idBits.fill(0);
  return { enc, ids };
}

/** Deterministic, opaque record id for a natural key (e.g. a URL). */
export async function opaqueId(keys, value) {
  const sig = new Uint8Array(await subtle.sign('HMAC', keys.ids, te.encode(value)));
  return b64url(sig.subarray(0, 16));
}

function aad(coll, id) {
  return te.encode(`${coll}\u0000${id}`);
}

export async function encryptRecord(keys, coll, id, obj) {
  const iv = randomBytes(12);
  let pt = te.encode(JSON.stringify(obj));
  let format = FORMAT_JSON;
  if (canCompress && pt.length >= COMPRESS_MIN) {
    try {
      const z = await pipe(pt, new CompressionStream('deflate-raw'));
      if (z.length < pt.length) {
        pt = z;
        format = FORMAT_DEFLATE;
      }
    } catch {
      /* keep plain JSON */
    }
  }
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(coll, id) }, keys.enc, pt));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = format;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function decryptRecord(keys, coll, id, bytes) {
  const format = bytes[0];
  if (format !== FORMAT_JSON && format !== FORMAT_DEFLATE) throw new UnsupportedFormat(`record format ${format} is newer than this extension`);
  let pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13), additionalData: aad(coll, id) }, keys.enc, bytes.subarray(13)));
  if (format === FORMAT_DEFLATE) pt = await pipe(pt, new DecompressionStream('deflate-raw'));
  return JSON.parse(td.decode(pt));
}
