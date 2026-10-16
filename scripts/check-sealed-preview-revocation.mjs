import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function transferWasRevokedBeforeCompletion(race, originalBytes) {
  return race.afterFirstChunk && race.pendingAtAction && Boolean(race.failure) && !race.actionFailure
    && race.length > 0 && race.length < originalBytes
    && race.completionMarkerAt === null && Number.isFinite(race.channelEndedAt)
    && race.firstChunkAt <= race.actionStartedAt && Number.isFinite(race.actionEndedAt);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
  for (const race of result.races.filter(race => race.afterFirstChunk)) {
    const ok = transferWasRevokedBeforeCompletion(race, result.largeOriginal.bytes);
    console.log(JSON.stringify({ passed: ok, command: race.action.command, expected: "first-chunk revocation interrupts remaining content and rejects completion", receivedBytes: race.length, originalBytes: result.largeOriginal.bytes, chunks: race.chunks, failure: race.failure ?? null, actionElapsedMs: race.actionElapsedMs }));
    if (!ok) process.exitCode = 1;
  }
}
