// CLIP_ARCHIVE_DIR: keep every recording a camera's HomeBase holds, as an mp4 with its event cover beside it,
// in date folders a media browser can open:
//
//   <dir>/<camera name>/<yyyy>/<MM>/<dd>/<HH-mm-ss>.mp4   (and .jpg, the event's own cover)
//
// The date and time are the recording's own name (its start, in the station's clock). Rows come from the
// stations' history tables (ctx.recordingRows), which hold the newest 50 or so, so the archive catches up after a
// bridge outage of up to about that many events. `.index.json` maps `<station>/<record id>` to the saved file,
// so a recording is saved once. A pass runs a little after each detection (the station writes the row once the
// clip ends), on startup, and every CLIP_ARCHIVE_SWEEP_MS. Off unless CLIP_ARCHIVE_DIR is set.
import fs from "node:fs";
import path from "node:path";
import { muxMp4 } from "./clip.mjs";

/** After a detection, when to look for its recording: the clip runs up to a minute, then the row is written. */
const AFTER_DETECTION_MS = [45_000, 120_000, 300_000];
/** A downloaded recording shorter than this share of the frames its row counts is taken as still being written. */
const COMPLETE_SHARE = 0.9;

/** A camera name as a folder name: path separators and control characters out, never empty or dot-only. */
export function folderName(name, fallback) {
  const clean = String(name ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return clean || String(fallback);
}

/** `<yyyy>/<MM>/<dd>/<HH-mm-ss>` from a `yyyyMMddHHmmss` recording name, or undefined for any other name. */
export function recordingStem(recording) {
  const m = /^(?:h26[45]_)?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(recording ?? ""));
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}-${m[5]}-${m[6]}` : undefined;
}

export function createClipArchive(ctx) {
  const { cfg, eufy } = ctx;
  const dir = cfg.clipArchiveDir;
  if (!dir) return { archiveAfterDetection: () => {}, archiveSweep: async () => 0 };
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);
  const indexFile = path.join(dir, ".index.json");
  const timers = new Map(); // sn -> pending after-detection timeouts
  let index;
  let chain = Promise.resolve(); // one archive pass at a time

  async function loadIndex() {
    if (index) return index;
    try {
      index = JSON.parse(await fs.promises.readFile(indexFile, "utf8"));
    } catch {
      index = {};
    }
    return index;
  }

  async function writeAtomic(file, data) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }

  /** The camera's archive folder name, from the device list, keyed by serial. */
  async function cameraNames() {
    const names = new Map();
    for (const d of (await eufy.getDevices?.()) ?? []) names.set(d.sn, folderName(d.name, d.sn));
    return names;
  }

  /** Save one recording row; true when saved, false when it should be tried again later. */
  async function save(row, cam, name) {
    const stem = recordingStem(row.recording);
    if (!stem) return false;
    const rel = `${name}/${stem}.mp4`;
    const file = path.join(dir, rel);
    let clip;
    try {
      clip = await cam.downloadRecording({
        recording: row.recording,
        cipherId: row.cipherId,
        storagePath: row.storagePath,
      });
    } catch (e) {
      log(`archive: ${row.sn} ${row.recording} not saved yet (${e?.reason ?? e?.message ?? e})`);
      return false;
    }
    if (row.frameNum && (clip.frames ?? 0) + (clip.missingFrames ?? 0) < row.frameNum * COMPLETE_SHARE) {
      log(`archive: ${row.sn} ${row.recording} came back short (${clip.frames} of ${row.frameNum} frames); later`);
      return false;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await mux(clip, `${file}.tmp`);
    await fs.promises.rename(`${file}.tmp`, file);
    const cover = await ctx.recordingCover?.(row).catch(() => undefined);
    if (cover) await writeAtomic(file.replace(/\.mp4$/, ".jpg"), cover);
    const idx = await loadIndex();
    idx[`${row.stationSn}/${row.recordId}`] = rel;
    await writeAtomic(indexFile, JSON.stringify(idx));
    log(`archive: saved ${rel} (${clip.frames} frames, ${clip.durationMs} ms${cover ? ", with cover" : ""})`);
    return true;
  }

  /** One pass over the rows for `sn` (every camera when absent): save each recording not yet saved, oldest first. */
  async function pass(sn) {
    const rows = (await ctx.recordingRows?.(sn)) ?? [];
    if (!rows.length) return 0;
    const idx = await loadIndex();
    const names = await cameraNames();
    const cams = new Map();
    let saved = 0;
    for (const row of [...rows].reverse()) {
      if (idx[`${row.stationSn}/${row.recordId}`]) continue;
      if (!cams.has(row.sn)) {
        const cam = await eufy
          .getDevice(row.sn)
          .then((d) => d.camera?.())
          .catch(() => undefined);
        cams.set(row.sn, typeof cam?.downloadRecording === "function" ? cam : undefined);
      }
      const cam = cams.get(row.sn);
      if (!cam) continue;
      if (await save(row, cam, names.get(row.sn) ?? folderName(undefined, row.sn))) saved += 1;
    }
    return saved;
  }

  function queued(sn) {
    const run = chain.then(() => pass(sn));
    chain = run.catch((e) => console.error(`[bridge] clip archive pass failed: ${e?.message ?? e}`));
    return run.catch(() => 0);
  }

  /** After a detection on `sn`: look for its recording on a schedule, restarted by a newer detection. */
  function archiveAfterDetection(sn) {
    if (!sn) return;
    for (const t of timers.get(sn) ?? []) clearTimeout(t);
    timers.set(
      sn,
      AFTER_DETECTION_MS.map((ms) => setTimeout(() => void queued(sn), ms)),
    );
  }

  /** Every camera's unsaved recordings; resolves to how many were saved. */
  function archiveSweep() {
    return queued(undefined);
  }

  return { archiveAfterDetection, archiveSweep };
}
