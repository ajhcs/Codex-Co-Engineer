import { CursorApiError } from './client.mjs';
import { redactValue } from './redaction.mjs';

function parseData(text) {
  if (text === '') return {};
  try { return JSON.parse(text); } catch { return text.slice(0, 20_000); }
}

export async function consumeSse(response, {
  maxEvents = 200,
  maxBytes = 500_000,
  timeoutMs = 30_000,
  secrets = [],
} = {}) {
  if (!response?.body?.getReader) throw new CursorApiError('stream_unavailable', 'Cursor stream did not expose a readable body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let eventName = '';
  let eventId;
  let dataLines = [];
  let totalBytes = 0;
  let lastEventId;
  let complete = false;
  let truncated = false;
  let timedOut = false;
  let finished = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);

  const dispatch = () => {
    if (dataLines.length === 0 && !eventName && eventId === undefined) return;
    const rawName = eventName || 'message';
    const rawData = dataLines.join('\n');
    const event = {
      event: rawName,
      data: redactValue(parseData(rawData), secrets),
      ...(eventId !== undefined ? { id: eventId } : {}),
    };
    if (eventId !== undefined) lastEventId = eventId;
    if (events.length < maxEvents) events.push(event);
    else truncated = true;
    if (rawName === 'done') { complete = true; finished = true; }
    eventName = '';
    eventId = undefined;
    dataLines = [];
  };

  const line = (rawLine) => {
    const value = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (value === '') { dispatch(); return; }
    if (value.startsWith(':')) return;
    const separator = value.indexOf(':');
    const field = separator === -1 ? value : value.slice(0, separator);
    let fieldValue = separator === -1 ? '' : value.slice(separator + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'event') eventName = fieldValue.slice(0, 200);
    else if (field === 'id') eventId = fieldValue.slice(0, 512);
    else if (field === 'data') dataLines.push(fieldValue.slice(0, 100_000));
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.match(/\r\n|\n|\r/)) !== null) {
        const index = newline.index;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + newline[0].length);
        if (finished) break;
      }
    }
    if (!finished && buffer) line(buffer);
    if (!finished) dispatch();
  } catch (error) {
    if (timedOut) throw new CursorApiError('stream_timeout', 'Cursor stream exceeded the configured time bound.', { details: { events: events.length, lastEventId } });
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  if (timedOut) throw new CursorApiError('stream_timeout', 'Cursor stream exceeded the configured time bound.', { details: { events: events.length, lastEventId } });
  return { events, lastEventId, complete, truncated, bytes: totalBytes };
}
