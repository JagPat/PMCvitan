/**
 * The port the API process binds. Empty, zero, and non-numeric `PORT` all fall
 * back to 3000 — `Number(value) || 3000`. The image healthcheck calls this same
 * function so a runtime `PORT` override is the port it probes.
 */
export function listenPort(env: { PORT?: string } = process.env): number {
  return Number(env.PORT) || 3000;
}
