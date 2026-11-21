// /clip/<sn>: the recording the camera's HomeBase stored for its latest detection, as an mp4. On a HomeBase 2
// the push names the recording (`payload.p`) and its key (`cipher`). A HomeBase 3's push names none, so the
// newest recording its history table names is taken instead (ctx.recordingRows). The SDK's
// `downloadRecording` fetches it over the station's P2P session without waking the camera, and the bundled
// ffmpeg muxes the elementary streams it returns (no re-encode). One file per camera holds the latest clip,
// so nothing needs pruning.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ffmpeg arguments that mux a recording's elementary streams into `out`, stream copy only. H.265 is read as
 * `hevc` and tagged `hvc1`, the tag Safari and Apple's players need; H.264 (and a recording whose codec the
 * SDK could not read) as `h264`. The camera's frame rate goes in `-r` before the input, since ffmpeg ignores
 * `-framerate` for a raw elementary stream.
 */
export function muxArgs({ codec, fps, hasAudio }, { video, audio }, out) {
  const hevc = codec === "h265";
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts"];
  if (fps > 0) args.push("-r", String(Math.round(fps * 1000) / 1000));
  args.push("-f", hevc ? "hevc" : "h264", "-i", video);
  if (hasAudio) args.push("-f", "aac", "-i", audio, "-map", "0:v", "-map", "1:a");
  args.push("-c", "copy");
  if (hevc) args.push("-tag:v", "hvc1");
  args.push("-movflags", "+faststart", "-f", "mp4", out);
  return args;
}

/** Mux Annex-B H.264 or H.265 (+ ADTS AAC when present) into `out` with ffmpeg, stream copy only. */
export async function muxMp4({ video, audio, fps, codec }, out) {
  const inputs = { video: `${out}.${codec === "h265" ? "h265" : "h264"}`, audio: `${out}.aac` };
  const hasAudio = Boolean(audio?.length);
  await fs.promises.writeFile(inputs.video, video);
  if (hasAudio) await fs.promises.writeFile(inputs.audio, audio);
  const args = muxArgs({ codec, fps, hasAudio }, inputs, out);
  try {
    await new Promise((resolve, reject) =>
      execFile("ffmpeg", args, { timeout: 60_000 }, (e, _out, err) => {
        if (!e) return resolve();
        const detail = String(err || e.message).trim();
        reject(new Error(`ffmpeg: ${detail.slice(-200)}`));
      }),
    );
  } catch (e) {
    await fs.promises.rm(out, { force: true }); // no half-written file left behind
    throw e;
  } finally {
    for (const f of Object.values(inputs)) await fs.promises.rm(f, { force: true });
  }
}

export function createClips(ctx) {
  const { cfg, eufy, eventImageDir } = ctx;
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);
  const latest = new Map(); // sn -> { recording, cipherId, at } from the camera's latest push
  const made = new Map(); // sn -> the recording last-clip-<sn>.mp4 holds
  const builds = new Map(); // sn -> { recording, done } for the build in progress

  /** `push` listener: remember the recording a detection named. */
  function noteRecording(ev) {
    const recording = ev?.payload?.p;
    if (!ev?.deviceSn || typeof recording !== "string" || ev.cipher === undefined) return;
    if (latest.get(ev.deviceSn)?.recording === recording) return; // a repeat of the same push
    latest.set(ev.deviceSn, { recording, cipherId: ev.cipher, at: Date.now() });
  }

  /**
   * The recording to serve for `sn`: the one its latest push named, else the newest its station's history
   * table names (a HomeBase 3). A history row is a finished recording, so it needs no settle wait.
   */
  async function lastRecording(sn) {
    const pushed = latest.get(sn);
    if (pushed) return pushed;
    const [row] = (await ctx.recordingRows?.(sn)) ?? [];
    if (!row) return undefined;
    return { recording: row.recording, cipherId: row.cipherId, storagePath: row.storagePath };
  }

  async function build(sn, cam, { recording, cipherId, storagePath, at }, file) {
    // The station is still writing the recording right after the push; how it answers then is not
    // established, so wait until the clip length has elapsed. A history row (no `at`) is already finished.
    const wait = at === undefined ? 0 : at + cfg.clipSettleMs - Date.now();
    if (wait > 0) await sleep(wait);
    const clip = await cam.downloadRecording(
      storagePath ? { recording, cipherId, storagePath } : { recording, cipherId },
    );
    const tmp = `${file}.tmp`;
    await mux(clip, tmp);
    await fs.promises.rename(tmp, file);
    made.set(sn, recording);
    log(
      `/clip ${sn} → recording ${recording}: ${clip.frames} frames, ${clip.missingFrames} missing, ` +
        `${clip.durationMs} ms${clip.codec ? ` ${clip.codec}` : ""}${clip.audio?.length ? ", with audio" : ""}`,
    );
    return fs.promises.readFile(file);
  }

  /** The latest detection's clip for `sn`: `{ mp4 }`, or `{ status, error, reason? }`. */
  async function clipFor(sn) {
    let cam;
    try {
      cam = (await eufy.getDevice(sn)).camera?.();
    } catch (e) {
      return { status: 404, error: String(e?.message ?? e) };
    }
    if (typeof cam?.downloadRecording !== "function")
      return { status: 404, error: "no stored recordings on this device" };
    const last = await lastRecording(sn);
    if (!last)
      return { status: 409, error: "no recording named by a push since the bridge started, nor by the station" };
    const file = path.join(eventImageDir, `last-clip-${sn}.mp4`);
    if (made.get(sn) === last.recording) {
      try {
        return { mp4: await fs.promises.readFile(file) };
      } catch {
        made.delete(sn); // gone from disk: build it again
      }
    }
    // One build per camera at a time: callers asking for the same recording share it, and a newer
    // recording waits for the one in progress so the file ends up holding the newer clip.
    let current = builds.get(sn);
    if (current?.recording !== last.recording) {
      const previous = current?.done.catch(() => {}) ?? Promise.resolve();
      const entry = { recording: last.recording };
      entry.done = previous.then(() => build(sn, cam, last, file));
      entry.done.finally(() => builds.get(sn) === entry && builds.delete(sn)).catch(() => {});
      builds.set(sn, (current = entry));
    }
    try {
      return { mp4: await current.done };
    } catch (e) {
      log(`/clip ${sn} → recording ${last.recording} failed: ${e?.message ?? e}`);
      return e?.reason
        ? { status: 502, error: String(e.message), reason: e.reason }
        : { status: 500, error: String(e?.message ?? e) };
    }
  }

  return { noteRecording, clipFor };
}
