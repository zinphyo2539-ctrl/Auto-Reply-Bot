import { ValidationError } from './errors';

const encoder = new TextEncoder();

export type CallbackNamespace = 'mnu' | 'tk' | 'sl' | 'dep' | 'wd' | 'adm' | 'faq' | 'cfg';

export interface ParsedCallbackData {
  namespace: CallbackNamespace;
  action: string;
  targetId: string;
  version?: number;
  extra?: string;
}

export function encodeCallbackData(params: ParsedCallbackData): string {
  const parts: string[] = [params.namespace, params.action, params.targetId];
  if (params.version !== undefined) {
    parts.push(`v${params.version}`);
  }
  if (params.extra !== undefined) {
    parts.push(params.extra);
  }
  const encoded = parts.join(':');
  const byteLen = encoder.encode(encoded).byteLength;
  if (byteLen < 1 || byteLen > 64) {
    throw new ValidationError(`Callback data exceeds Telegram 64-byte limit (${byteLen} bytes)`);
  }
  return encoded;
}

export function decodeCallbackData(raw: string): ParsedCallbackData {
  if (!raw || typeof raw !== 'string') {
    throw new ValidationError('Empty callback data');
  }
  const byteLen = encoder.encode(raw).byteLength;
  if (byteLen > 64) {
    throw new ValidationError('Callback data exceeds 64 bytes');
  }
  const parts = raw.split(':');
  if (parts.length < 3) {
    throw new ValidationError('Malformed callback data format');
  }
  const [ns, action, targetId, p3, p4] = parts;
  const validNamespaces: CallbackNamespace[] = ['mnu', 'tk', 'sl', 'dep', 'wd', 'adm', 'faq', 'cfg'];
  if (!validNamespaces.includes(ns as CallbackNamespace)) {
    throw new ValidationError(`Unknown callback namespace: ${ns}`);
  }

  let version: number | undefined;
  let extra: string | undefined;

  if (p3) {
    if (/^v\d+$/.test(p3)) {
      version = parseInt(p3.slice(1), 10);
      extra = p4;
    } else {
      extra = p3;
    }
  }

  return {
    namespace: ns as CallbackNamespace,
    action,
    targetId,
    version,
    extra,
  };
}
