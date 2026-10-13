// HTTP response header parser for upstream proxy responses.
// Extracted from server.ts to make response parsing independently testable.
//
// Handles: status line parsing, 100-continue interim responses, hop-by-hop
// header filtering, Connection header value extraction, duplicate header
// array handling, and oversized header guard.

// Hop-by-hop headers that MUST NOT be forwarded by an HTTP proxy (RFC 2616 §13.5.1).
export const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  'transfer-encoding': true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  upgrade: true,
  'proxy-connection': true,
};

// Pre-built set for request-header stripping — avoids allocating a new array
// on every iteration of every header on every request.
export const STRIPPED_REQUEST_HEADERS: Record<string, true> = {
  host: true,
  ...HOP_BY_HOP,
};

// Maximum acceptable size for upstream response headers (prevents unbounded
// memory growth if the upstream sends data without a \r\n\r\n terminator).
export const MAX_RESPONSE_HEADER_BYTES = 32768;

export interface ParsedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer; // body bytes that arrived in the same chunk after the header block
  isChunked: boolean;
}

/**
 * Parse a raw HTTP response header block from a Buffer.
 *
 * Accepts the accumulated buffer that may or may not contain a complete
 * header block (terminated by `\r\n\r\n`).  If the header block is not yet
 * complete, returns `null` and the caller should accumulate more data.
 *
 * Handles 100-continue interim responses by skipping them and continuing
 * to parse until a non-100 response is found.
 *
 * Returns `null` when the header block is not yet complete.
 * Throws when the accumulated buffer exceeds `MAX_RESPONSE_HEADER_BYTES`
 * without finding a header terminator.
 */
export function parseResponseHeaders(buf: Buffer): ParsedResponse | null {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) {
    if (buf.length > MAX_RESPONSE_HEADER_BYTES) {
      throw new Error('upstream response header too large');
    }
    return null;
  }

  let headerStr = buf.slice(0, idx).toString();
  let lines = headerStr.split('\r\n');
  let firstLine = lines[0] || '';
  let statusCode = parseInt(firstLine.split(' ')[1] || '0', 10);
  let rest = buf.slice(idx + 4);

  // Handle 100-Continue — consume interim responses until we get a final one
  while (statusCode === 100 && rest.length > 0) {
    const nextIdx = rest.indexOf('\r\n\r\n');
    if (nextIdx === -1) {
      // More data needed to parse past the 100 response
      return null;
    }
    headerStr = rest.slice(0, nextIdx).toString();
    lines = headerStr.split('\r\n');
    firstLine = lines[0] || '';
    statusCode = parseInt(firstLine.split(' ')[1] || '0', 10);
    rest = rest.slice(nextIdx + 4);
  }

  if (statusCode === 100 && rest.length === 0) {
    return null;
  }

  // Extract Connection header values to also strip those headers
  let connectionValues: string[] = [];
  const transferCodings: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const k = line.slice(0, sep).trim().toLowerCase();
    if (k === 'transfer-encoding') {
      transferCodings.push(
        ...line
          .slice(sep + 1)
          .split(',')
          .map((v) => v.trim().toLowerCase()),
      );
    }
    if (k === 'connection') {
      connectionValues = line
        .slice(sep + 1)
        .split(',')
        .map((v) => v.trim().toLowerCase());
      // Continue scanning so transfer codings after Connection are collected.
    }
  }

  const isChunked = transferCodings.at(-1) === 'chunked';
  const respHeaders: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const k = line.slice(0, sep).trim();
    const v = line.slice(sep + 1).trim();
    const kl = k.toLowerCase();
    if (k && !(kl in HOP_BY_HOP) && !connectionValues.includes(kl) && !(isChunked && kl === 'content-length')) {
      const existing = respHeaders[k];
      if (existing !== undefined) {
        respHeaders[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
      } else {
        respHeaders[k] = v;
      }
    }
  }

  return { statusCode, headers: respHeaders, body: rest, isChunked };
}

export interface ChunkedBodyDecoder {
  write(chunk: Buffer): boolean;
  end(): boolean;
}

export function createChunkedBodyDecoder(onBody: (chunk: Buffer) => void): ChunkedBodyDecoder {
  let state: 'size' | 'data' | 'data-crlf' | 'trailers' | 'done' = 'size';
  let remaining = 0;
  let pending: Buffer = Buffer.alloc(0);
  let trailerBytes = 0;

  return {
    write(chunk) {
      const input = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      let offset = 0;

      while (offset < input.length) {
        if (state === 'size' || state === 'trailers') {
          const lineEnd = input.indexOf('\r\n', offset);
          if (lineEnd === -1) {
            if (input.length - offset > MAX_RESPONSE_HEADER_BYTES) return false;
            pending = input.subarray(offset);
            return true;
          }

          const lineLength = lineEnd + 2 - offset;
          if (state === 'trailers') {
            trailerBytes += lineLength;
            if (trailerBytes > MAX_RESPONSE_HEADER_BYTES) return false;
          }
          const line = input.toString('ascii', offset, lineEnd);
          offset = lineEnd + 2;

          if (state === 'size') {
            const sizeText = (line.split(';', 1)[0] ?? '').trim();
            if (!/^[\da-f]+$/i.test(sizeText)) return false;
            remaining = Number.parseInt(sizeText, 16);
            if (!Number.isSafeInteger(remaining)) return false;
            state = remaining === 0 ? 'trailers' : 'data';
          } else if (line === '') {
            state = 'done';
          }
          continue;
        }

        if (state === 'data') {
          const size = Math.min(remaining, input.length - offset);
          if (size === 0) return true;
          onBody(input.subarray(offset, offset + size));
          offset += size;
          remaining -= size;
          if (remaining === 0) state = 'data-crlf';
          continue;
        }

        if (state === 'data-crlf') {
          if (input.length - offset < 2) {
            pending = input.subarray(offset);
            return true;
          }
          if (input[offset] !== 13 || input[offset + 1] !== 10) return false;
          offset += 2;
          state = 'size';
          continue;
        }

        return false;
      }

      return true;
    },
    end() {
      return state === 'done' && pending.length === 0;
    },
  };
}
