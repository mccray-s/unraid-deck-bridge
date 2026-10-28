import http from 'node:http';
import { safeIssue, safeChangeSummary } from './configuration-feedback.js';
import { GraphQLError } from 'graphql';
import { StringDecoder } from 'node:string_decoder';
export const SOCKET = '/var/run/unraid-deck-bridge/core.sock';
export function principal(context: any): string {
  const id = context?.req?.user?.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
    throw new GraphQLError('Official authenticated principal is missing', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return id;
}
function request(
  actor: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  return http.request({
    socketPath: SOCKET,
    path,
    signal,
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bridge-actor': actor,
    },
  });
}
export async function callCore<T = any>(
  actor: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(actor, path, body);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', () =>
      reject(
        new GraphQLError(
          'Bridge Core is unavailable; query operation status before retrying a write',
          { extensions: { code: 'CORE_UNAVAILABLE' } },
        ),
      ),
    );
    req.on('response', (res) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          res.destroy();
          reject(
            new GraphQLError('Core response exceeded limit', {
              extensions: { code: 'CORE_RESPONSE_INVALID' },
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () =>
        reject(
          new GraphQLError('Core response interrupted', {
            extensions: { code: 'CORE_UNAVAILABLE' },
          }),
        ),
      );
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) {
            const e = value.error;
            const issue = safeIssue(e?.issue);
            reject(
              new GraphQLError(e?.message ?? 'Core request failed', {
                extensions: {
                  code: e?.code ?? 'CORE_ERROR',
                  ...(issue ? { deckBridgeIssue: issue } : {}),
                },
              }),
            );
            return;
          }
          if (value?.error?.issue !== undefined)
            value.error.issue = safeIssue(value.error.issue);
          if (value?.changeSummary !== undefined)
            value.changeSummary = safeChangeSummary(value.changeSummary);
          resolve(value);
        } catch {
          reject(
            new GraphQLError('Core returned an invalid response', {
              extensions: { code: 'CORE_RESPONSE_INVALID' },
            }),
          );
        }
      });
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
// Update routes never expose Registry/server error text, even on successful
// snapshots containing a failed item or an active child operation.
function updateError(value: any, fallback = 'CORE_ERROR'): GraphQLError {
  const code =
    typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
      ? value.code
      : fallback;
  const issue = safeIssue(value?.issue);
  return new GraphQLError('Docker update request could not be completed', {
    extensions: { code, ...(issue ? { deckBridgeIssue: issue } : {}) },
  });
}
function redactUpdateErrors(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (value.error && typeof value.error === 'object') {
    const error = updateError(value.error);
    value.error = {
      code: error.extensions.code,
      message: error.message,
      ...(error.extensions.deckBridgeIssue
        ? { issue: error.extensions.deckBridgeIssue }
        : {}),
    };
  }
  for (const [key, child] of Object.entries(value))
    if (key !== 'error') redactUpdateErrors(child);
}
export async function callUpdateCore<T = any>(
  actor: string,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const value = await callCore<T>(actor, path, body);
    redactUpdateErrors(value);
    return value;
  } catch (error) {
    if (error instanceof GraphQLError)
      throw updateError({
        code: error.extensions.code,
        issue: error.extensions.deckBridgeIssue,
      });
    throw updateError(undefined, 'CORE_RESPONSE_INVALID');
  }
}
// Interrupt pending I/O before queuing generator completion.
function cancellableEvents<T>(
  create: (signal: AbortSignal) => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const controller = new AbortController();
  const events = create(controller.signal);
  const finish = events.return.bind(events);
  const fail = events.throw.bind(events);
  events.return = (value) => {
    controller.abort();
    return finish(value);
  };
  events.throw = (error) => {
    controller.abort();
    return fail(error);
  };
  return events;
}
export function coreUpdateEvents(
  actor: string,
  id: string,
  after: number,
  kind: 'checks' | 'batches',
): AsyncGenerator<any> {
  return cancellableEvents((signal) =>
    readUpdateEvents(actor, id, after, kind, signal),
  );
}
async function* readUpdateEvents(
  actor: string,
  id: string,
  after: number,
  kind: 'checks' | 'batches',
  signal: AbortSignal,
): AsyncGenerator<any> {
  const path =
    kind === 'checks'
      ? '/docker/update-checks/events'
      : '/docker/image-update-batches/events';
  const req = request(
    actor,
    `${path}?id=${encodeURIComponent(id)}&after=${after}`,
    undefined,
    signal,
  );
  req.setTimeout(60000, () => req.destroy());
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', () => reject(updateError(undefined, 'CORE_UNAVAILABLE')));
  });
  req.end();
  let res: http.IncomingMessage | undefined;
  try {
    res = await response;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    if (res.statusCode !== 200) {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of res) {
        bytes += chunk.length;
        if (bytes > 256 * 1024)
          throw updateError(undefined, 'CORE_RESPONSE_INVALID');
        chunks.push(Buffer.from(chunk));
      }
      let failure: any;
      try {
        failure = JSON.parse(Buffer.concat(chunks).toString()).error;
      } catch {
        throw updateError(undefined, 'CORE_RESPONSE_INVALID');
      }
      throw updateError(failure, 'EVENT_STREAM_FAILED');
    }
    const decode = (line: string) => {
      if (Buffer.byteLength(line) > 256 * 1024)
        throw updateError(undefined, 'CORE_RESPONSE_INVALID');
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        throw updateError(undefined, 'CORE_RESPONSE_INVALID');
      }
      if (event?.error) throw updateError(event.error);
      const kinds =
        kind === 'checks'
          ? ['ITEM_CHANGED', 'COMPLETED']
          : ['ITEM_CHANGED', 'ACTIVE_PROGRESS', 'COMPLETED'];
      if (
        !event ||
        !Number.isInteger(event.sequence) ||
        event.sequence < 1 ||
        event.sequence > 2147483647 ||
        !kinds.includes(event.kind)
      )
        throw updateError(undefined, 'CORE_RESPONSE_INVALID');
      redactUpdateErrors(event);
      return event;
    };
    for await (const chunk of res) {
      pending += decoder.write(Buffer.from(chunk));
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.trim()) yield decode(line);
      }
      if (Buffer.byteLength(pending) > 256 * 1024)
        throw updateError(undefined, 'CORE_RESPONSE_INVALID');
    }
    pending += decoder.end();
    if (pending.trim()) yield decode(pending);
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof GraphQLError) throw error;
    throw updateError(undefined, 'CORE_UNAVAILABLE');
  } finally {
    res?.destroy();
    req.destroy();
  }
}
export function coreEvents(
  actor: string,
  id: string,
  after: number,
  domain: string,
): AsyncGenerator<any> {
  return cancellableEvents((signal) =>
    readEvents(actor, id, after, domain, signal),
  );
}
async function* readEvents(
  actor: string,
  id: string,
  after: number,
  domain: string,
  signal: AbortSignal,
): AsyncGenerator<any> {
  const req = request(
    actor,
    `/events?domain=${domain}&id=${encodeURIComponent(id)}&after=${after}`,
    undefined,
    signal,
  );
  req.setTimeout(60000, () => req.destroy());
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', () =>
      reject(
        new GraphQLError('Event stream unavailable', {
          extensions: { code: 'CORE_UNAVAILABLE' },
        }),
      ),
    );
  });
  req.end();
  let res: http.IncomingMessage | undefined;
  try {
    res = await response;
    if (res.statusCode !== 200) {
      throw new GraphQLError('Cannot read operation events', {
        extensions: { code: 'EVENT_STREAM_FAILED' },
      });
    }
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const decode = (line: string) => {
      if (Buffer.byteLength(line) > 256 * 1024)
        throw new GraphQLError('Event response exceeded limit', {
          extensions: { code: 'CORE_RESPONSE_INVALID' },
        });
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new GraphQLError('Invalid event response', {
          extensions: { code: 'CORE_RESPONSE_INVALID' },
        });
      }
      if (event?.error)
        throw new GraphQLError(event.error.message, {
          extensions: { code: event.error.code },
        });
      return event;
    };
    for await (const chunk of res) {
      pending += decoder.write(Buffer.from(chunk));
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.trim()) yield decode(line);
      }
      if (Buffer.byteLength(pending) > 256 * 1024)
        throw new GraphQLError('Event response exceeded limit', {
          extensions: { code: 'CORE_RESPONSE_INVALID' },
        });
    }
    pending += decoder.end();
    if (pending.trim()) yield decode(pending);
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError('Event stream unavailable', {
      extensions: { code: 'CORE_UNAVAILABLE' },
    });
  } finally {
    res?.destroy();
    req.destroy();
  }
}
