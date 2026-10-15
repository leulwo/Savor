import type { Response } from "express";

type StreamResponse = Pick<Response, "write" | "destroy" | "on" | "off" | "writableEnded" | "destroyed" | "writableLength">;

/** Revision events are invalidations, so a slow client needs only the latest. */
export function createRevisionWriter(response: StreamResponse, currentRevision: () => number, maxBufferedBytes = 64 * 1024) {
  let blocked = false;
  let pendingRevision = false;
  let closed = false;

  function available(): boolean {
    if (closed || response.destroyed || response.writableEnded) return false;
    if (response.writableLength > maxBufferedBytes) {
      response.destroy();
      return false;
    }
    return true;
  }
  function send(frame: string) {
    blocked = !response.write(frame);
    if (response.writableLength > maxBufferedBytes) response.destroy();
  }
  function emit() {
    if (!available()) return;
    if (blocked) { pendingRevision = true; return; }
    pendingRevision = false;
    send(`data: ${JSON.stringify({ revision: currentRevision() })}\n\n`);
  }
  function onDrain() {
    blocked = false;
    if (pendingRevision) emit();
  }
  response.on("drain", onDrain);
  return {
    emit,
    heartbeat() { if (available() && !blocked) send(": heartbeat\n\n"); },
    close() {
      if (closed) return;
      closed = true;
      pendingRevision = false;
      response.off("drain", onDrain);
    }
  };
}
