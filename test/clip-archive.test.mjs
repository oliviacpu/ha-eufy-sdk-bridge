// CLIP_ARCHIVE_DIR keeps every recording the HomeBase holds as <camera>/<yyyy>/<MM>/<dd>/<HH-mm-ss>.mp4 with
// the event's cover beside it, once each. Drives the archive against fake rows, a fake SDK camera and a fake
// muxer, so neither a station nor ffmpeg is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";
import { createClipArchive, folderName, localDay, recordingStem } from "../src/clip-archive.mjs";

const rowFor = (sn, recording, recordId, frameNum = 100) => ({
  sn,
  stationSn: "HB3",
  recordId,
  recording,
  storagePath: `/zx/hdd_data1/Camera01/${recording.slice(0, 6)}/${recording}/${recording}.zxvideo`,
  cipherId: 0,
  frameNum,
  coverPath: `/zx/hdd_data1/Camera01/${recording.slice(0, 6)}/${recording}/snapshort.jpg`,
});

function setup({ rows = () => [], download, archive = true, dayRows, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
  const env = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...extraEnv };
  if (archive) env.CLIP_ARCHIVE_DIR = dir;
  const calls = { download: [], covers: [], days: [] };
  const cam = {
    downloadRecording: async (opts) => {
      calls.download.push(opts.recording);
      return download ? download(opts) : { video: Buffer.from(opts.recording), frames: 100, missingFrames: 0 };
    },
  };
  const ctx = {
    ...loadConfig(env),
    eventLog: () => {},
    eufy: {
      getDevices: async () => [
        { sn: "CAM1", name: "Balcony" },
        { sn: "CAM2", name: "Front/Door: 2" },
      ],
      getDevice: async () => ({ camera: () => cam }),
    },
    recordingRows: async (sn) => rows().filter((r) => !sn || r.sn === sn),
    recordingRowsForDay: async (day) => (calls.days.push(day), dayRows ? dayRows(day) : null),
    recordingCover: async (row) => (calls.covers.push(row.coverPath), Buffer.from("JPEG")),
    muxClip: async (clip, out) => fs.promises.writeFile(out, Buffer.concat([Buffer.from("MP4:"), clip.video])),
  };
  return { archive: createClipArchive(ctx), dir, calls };
}

const files = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();

test("folderName and recordingStem shape the archive's folders", () => {
  assert.equal(folderName("Front/Door: 2", "SN"), "Front Door 2");
  assert.equal(folderName("..", "SN"), "SN");
  assert.equal(folderName(undefined, "SN"), "SN");
  assert.equal(recordingStem("20261121095110"), "2026/11/21/09-51-10");
  assert.equal(recordingStem("h265_20261121095110"), "2026/11/21/09-51-10");
  assert.equal(recordingStem("../20261121095110"), undefined);
});

test("archive: off without CLIP_ARCHIVE_DIR", async () => {
  const { archive, calls } = setup({ archive: false, rows: () => [rowFor("CAM1", "20261121095110", 1)] });
  assert.equal(await archive.archiveSweep(), 0);
  assert.deepEqual(calls.download, []);
});

test("archive: saves each recording once, oldest first, with its cover, under the camera's name", async () => {
  const rows = [
    rowFor("CAM1", "20261121095110", 3),
    rowFor("CAM2", "20261121080000", 2),
    rowFor("CAM1", "20261120230000", 1),
  ];
  const { archive, dir, calls } = setup({ rows: () => rows });
  assert.equal(await archive.archiveSweep(), 3);
  assert.deepEqual(calls.download, ["20261120230000", "20261121080000", "20261121095110"]);
  assert.deepEqual(files(dir), [
    ".index.json",
    "Balcony/2026/11/20/23-00-00.jpg",
    "Balcony/2026/11/20/23-00-00.mp4",
    "Balcony/2026/11/21/09-51-10.jpg",
    "Balcony/2026/11/21/09-51-10.mp4",
    "Front Door 2/2026/11/21/08-00-00.jpg",
    "Front Door 2/2026/11/21/08-00-00.mp4",
  ]);
  assert.equal(fs.readFileSync(path.join(dir, "Balcony/2026/11/21/09-51-10.mp4"), "utf8"), "MP4:20261121095110");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".index.json"), "utf8")), {
    "HB3/1": "Balcony/2026/11/20/23-00-00.mp4",
    "HB3/2": "Front Door 2/2026/11/21/08-00-00.mp4",
    "HB3/3": "Balcony/2026/11/21/09-51-10.mp4",
  });

  assert.equal(await archive.archiveSweep(), 0); // nothing new
  assert.equal(calls.download.length, 3);
  rows.unshift(rowFor("CAM1", "20261121100000", 4));
  assert.equal(await archive.archiveSweep(), 1);
  assert.deepEqual(calls.download.slice(3), ["20261121100000"]);
});

test("archive: a failed or short download is not saved, and the next pass tries it again", async () => {
  let mode = "fail";
  const { archive, dir, calls } = setup({
    rows: () => [rowFor("CAM1", "20261121095110", 1, 111)],
    download: async (opts) => {
      if (mode === "fail") throw Object.assign(new Error("no data"), { reason: "no-data" });
      if (mode === "short") return { video: Buffer.from("V"), frames: 40, missingFrames: 0 };
      return { video: Buffer.from(opts.recording), frames: 111, missingFrames: 0 };
    },
  });
  assert.equal(await archive.archiveSweep(), 0);
  mode = "short";
  assert.equal(await archive.archiveSweep(), 0);
  assert.deepEqual(files(dir), []);
  mode = "ok";
  assert.equal(await archive.archiveSweep(), 1);
  assert.equal(calls.download.length, 3);
  assert.ok(files(dir).includes("Balcony/2026/11/21/09-51-10.mp4"));
});

test("archive: a detection looks for that camera's recording on a schedule a newer detection restarts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rows = [];
  const { archive, calls } = setup({ rows: () => rows });
  archive.archiveAfterDetection("CAM1");
  t.mock.timers.tick(30_000);
  archive.archiveAfterDetection("CAM1"); // restarts the schedule
  rows.push(rowFor("CAM1", "20261121095110", 1));
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.download, []); // 60 s after the first, 30 s after the second detection
  t.mock.timers.tick(15_000);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.download, ["20261121095110"]);
});

test("localDay counts back whole local days", () => {
  const noon = new Date(2026, 10, 21, 12, 0, 0).getTime();
  assert.equal(localDay(noon), "20261121");
  assert.equal(localDay(noon, 1), "20261120");
  assert.equal(localDay(noon, 21), "20261031");
});

test("archive: backfill walks past days newest first, marks a fully saved past day done and skips it next time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 21, 12, 0, 0) });
  const byDay = {
    20261121: [rowFor("CAM1", "20261121095110", 30)],
    20261120: [rowFor("CAM1", "20261120230000", 21), rowFor("CAM2", "20261120080000", 20)],
    20261119: [],
  };
  const { archive, dir, calls } = setup({
    dayRows: (day) => byDay[day] ?? [],
    extraEnv: { CLIP_ARCHIVE_BACKFILL_DAYS: "2", CLIP_ARCHIVE_PAUSE_MS: "0" },
  });
  assert.equal(await archive.archiveBackfill(), 3);
  assert.deepEqual(calls.days, ["20261121", "20261120", "20261119"]);
  assert.deepEqual(calls.download, ["20261121095110", "20261120230000", "20261120080000"]);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, ".index.json"), "utf8"));
  assert.equal(idx["day:20261120"], 2);
  assert.equal(idx["day:20261119"], 0);
  assert.equal(idx["day:20261121"], undefined); // today is never done
  assert.ok(files(dir).includes("Front Door 2/2026/11/20/08-00-00.mp4"));

  calls.days.length = 0;
  byDay[20261121].unshift(rowFor("CAM1", "20261121110000", 31));
  assert.equal(await archive.archiveBackfill(), 1);
  assert.deepEqual(calls.days, ["20261121"]); // the done past days aren't read again
});

test("archive: a failed backfill download leaves its day open, and no answer stops the walk", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 21, 12, 0, 0) });
  let fail = true;
  const answered = new Set(["20261121", "20261120"]);
  const { archive, dir, calls } = setup({
    dayRows: (day) => (answered.has(day) ? (day === "20261120" ? [rowFor("CAM1", "20261120230000", 21)] : []) : null),
    download: async (opts) => {
      if (fail) throw Object.assign(new Error("no data"), { reason: "no-data" });
      return { video: Buffer.from(opts.recording), frames: 100, missingFrames: 0 };
    },
    extraEnv: { CLIP_ARCHIVE_BACKFILL_DAYS: "5", CLIP_ARCHIVE_PAUSE_MS: "0" },
  });
  assert.equal(await archive.archiveBackfill(), 0);
  assert.deepEqual(calls.days, ["20261121", "20261120", "20261119"]); // the 19th: no station answered, so it stops
  assert.equal(fs.existsSync(path.join(dir, ".index.json")), false);
  fail = false;
  assert.equal(await archive.archiveBackfill(), 1);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, ".index.json"), "utf8"));
  assert.equal(idx["day:20261120"], 1);
});

test("archive: no backfill unless CLIP_ARCHIVE_BACKFILL_DAYS is set", async () => {
  const { archive, calls } = setup({ dayRows: () => [rowFor("CAM1", "20261120230000", 21)] });
  assert.equal(await archive.archiveBackfill(), 0);
  assert.deepEqual(calls.days, []);
});
