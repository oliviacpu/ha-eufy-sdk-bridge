// CLIP_ARCHIVE_DIR: keep every recording a camera's HomeBase holds, as an mp4 with its event cover beside it,
// in date folders a media browser can open:
//
//   <dir>/<camera name>/<yyyy>/<MM>/<dd>/<HH-mm-ss>.mp4   (and .jpg, the event's own cover)
//
// The date and time are the recording's own name (its start, in the station's clock). `.index.json` maps
// `<station>/<record id>` to the saved file, so a recording is saved once. A pass over the stations' newest rows
// (ctx.recordingRows) runs a little after each detection (the station writes the row once the clip ends), on
// startup, and every CLIP_ARCHIVE_SWEEP_MS. With CLIP_ARCHIVE_BACKFILL_DAYS set, each sweep also walks that many
// past days, newest first, through the stations' day reads (ctx.recordingRowsForDay), so everything a station
// still holds is saved; a past day whose recordings are all saved is marked done in the index and not read
// again. Off unless CLIP_ARCHIVE_DIR is set.
import fs from "node:fs";
import path from "node:path";
import { muxMp4 } from "./clip.mjs";

/** After a detection, when to look for its recording: the clip runs up to a minute, then the row is written. */
const AFTER_DETECTION_MS = [45_000, 120_000, 300_000];
/** A downloaded recording shorter than this share of the frames its row counts is taken as still being written. */
const COMPLETE_SHARE = 0.9;
/** Index key prefix marking a past day whose recordings are all saved. */
const DAY_DONE = "day:";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** The local date `daysAgo` days before `now`, as `yyyyMMdd`. */
export function localDay(now, daysAgo = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function createClipArchive(ctx) {
  const { cfg, eufy } = ctx;
  const dir = cfg.clipArchiveDir;
  if (!dir) return { archiveAfterDetection: () => {}, archiveSweep: async () => 0, archiveBackfill: async () => 0 };
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);
  const indexFile = path.join(dir, ".index.json");
  const timers = new Map(); // sn -> pending after-detection timeouts
  const inFlight = new Set(); // index keys being saved right now
  let index;
  let chain = Promise.resolve(); // one pass at a time
  let indexWrites = Promise.resolve(); // one index write at a time
  let backfilling;

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

  function writeIndex() {
    indexWrites = indexWrites.then(async () => writeAtomic(indexFile, JSON.stringify(await loadIndex())));
    return indexWrites;
  }

  /** The cameras' archive folder names and their download-capable camera handles, looked up once per pass. */
  function lookups() {
    let names;
    const cams = new Map();
    return {
      async name(sn) {
        if (!names) {
          names = new Map();
          for (const d of (await eufy.getDevices?.()) ?? []) names.set(d.sn, folderName(d.name, d.sn));
        }
        return names.get(sn) ?? folderName(undefined, sn);
      },
      async cam(sn) {
        if (!cams.has(sn)) {
          const cam = await eufy
            .getDevice(sn)
            .then((d) => d.camera?.())
            .catch(() => undefined);
          cams.set(sn, typeof cam?.downloadRecording === "function" ? cam : undefined);
        }
        return cams.get(sn);
      },
    };
  }

  const keyOf = (row) => `${row.stationSn}/${row.recordId}`;

  /** Save one recording row; true when saved (or already), false when it should be tried again later. */
  async function save(row, look) {
    const key = keyOf(row);
    const idx = await loadIndex();
    if (idx[key]) return true;
    if (inFlight.has(key)) return false;
    const stem = recordingStem(row.recording);
    const cam = stem && (await look.cam(row.sn));
    if (!cam) return false;
    inFlight.add(key);
    try {
      const rel = `${await look.name(row.sn)}/${stem}.mp4`;
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
      idx[key] = rel;
      await writeIndex();
      log(`archive: saved ${rel} (${clip.frames} frames, ${clip.durationMs} ms${cover ? ", with cover" : ""})`);
      return true;
    } finally {
      inFlight.delete(key);
    }
  }

  /** One pass over the newest rows for `sn` (every camera when absent): save each one not yet saved, oldest first. */
  async function pass(sn) {
    const rows = (await ctx.recordingRows?.(sn)) ?? [];
    const idx = await loadIndex();
    const look = lookups();
    let saved = 0;
    for (const row of [...rows].reverse()) {
      if (idx[keyOf(row)]) continue;
      if (await save(row, look)) saved += 1;
    }
    return saved;
  }

  function queued(sn) {
    const run = chain.then(() => pass(sn));
    chain = run.catch((e) => console.error(`[bridge] clip archive pass failed: ${e?.message ?? e}`));
    return run.catch(() => 0);
  }

  /**
   * Walk today and the CLIP_ARCHIVE_BACKFILL_DAYS before it, newest first, saving every recording not yet saved,
   * CLIP_ARCHIVE_PAUSE_MS apart. A past day whose recordings are all saved is marked done. Stops early when no
   * station answers. One walk at a time; resolves to how many were saved.
   */
  function archiveBackfill() {
    if (!cfg.clipArchiveBackfillDays) return Promise.resolve(0);
    backfilling ??= (async () => {
      const idx = await loadIndex();
      const look = lookups();
      let saved = 0;
      for (let ago = 0; ago <= cfg.clipArchiveBackfillDays; ago++) {
        const day = localDay(Date.now(), ago);
        if (`${DAY_DONE}${day}` in idx) continue;
        const rows = await ctx.recordingRowsForDay?.(day);
        if (!rows) {
          log(`archive: backfill stopped at ${day}, no station answered`);
          break;
        }
        let complete = true;
        for (const row of rows) {
          if (idx[keyOf(row)]) continue;
          if (await save(row, look)) {
            saved += 1;
            if (cfg.clipArchivePauseMs) await sleep(cfg.clipArchivePauseMs);
          } else complete = false;
        }
        if (ago > 0 && complete) {
          idx[`${DAY_DONE}${day}`] = rows.length;
          await writeIndex();
        }
        if (rows.length) log(`archive: backfill ${day}: ${rows.length} recordings${complete ? ", all saved" : ""}`);
      }
      return saved;
    })().finally(() => {
      backfilling = undefined;
    });
    return backfilling;
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

  /** Every camera's newest unsaved recordings, then (in the background) the backfill; resolves to the first. */
  async function archiveSweep() {
    const saved = await queued(undefined);
    void archiveBackfill().catch((e) => console.error(`[bridge] clip archive backfill failed: ${e?.message ?? e}`));
    return saved;
  }

  return { archiveAfterDetection, archiveSweep, archiveBackfill };
}
