const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(nowMs: number, length = 10): string {
  let time = Math.floor(nowMs);
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % 32;
    str = CROCKFORD_ALPHABET[mod] + str;
    time = Math.floor(time / 32);
  }
  return str;
}

function encodeRandom(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < length; i++) {
    str += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return str;
}

export function generateUlid(nowMs = Date.now()): string {
  return `${encodeTime(nowMs, 10)}${encodeRandom(16)}`;
}

export function generatePrefixedId(prefix: string, nowMs = Date.now()): string {
  return `${prefix}_${generateUlid(nowMs)}`;
}

export function generateMutationToken(nowMs = Date.now()): string {
  return `mut_${generateUlid(nowMs)}`;
}

export function generateLeaseToken(nowMs = Date.now()): string {
  return `lse_${generateUlid(nowMs)}`;
}

export function generateCollisionResistantRequestRef(prefix: 'DEP' | 'WD', nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const rand = encodeRandom(10);
  return `${prefix}-${yyyy}${mm}${dd}-${rand}`;
}
