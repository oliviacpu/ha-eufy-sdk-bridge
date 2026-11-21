// HomeBase 3 recordings: /clip falls back to the newest recording the station's history table names (a
// HomeBase 3's push names none), the table's rows become downloadable recordings with the path the station
// stores them under, and H.265 is muxed as hevc tagged hvc1. The rows have the shape a T8030 with a drive
// fitted returns: `storage_path` under /zx/hdd_data1, `cipher_id` 0, an absolute `thumb_path`.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createClips, muxArgs } from "../src/clip.mjs";
import { createWarmup } from "../src/warmup.mjs";

const row = (deviceSn, stamp, frames = 111) => ({
  device_sn: deviceSn,
  station_sn: "HB3",
  record_id: Number(`${stamp.slice(0, 8)}${stamp.slice(8, 13)}`),
  start_time: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`,
  end_time: "2026-11-21 09:51:18",
  storage_path: `/zx/hdd_data1/Camera01/${stamp.slice(0, 6)}/${stamp}/${stamp}.zxvideo`,
  thumb_path: `/zx/hdd_data1/Camera01/${stamp.slice(0, 6)}/${stamp}/snapshort.jpg`,
  cipher_id: 0,
  frame_num: frames,
});

test("muxArgs: H.265 is read as hevc and tagged hvc1, with the frame rate in -r before the input", () => {
  const args = muxArgs({ codec: "h265", fps: 14.2, hasAudio: true }, { video: "v.h265", audio: "a.aac" }, "out.mp4");
  assert.deepEqual(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2), ["-r", "14.2"]);
  assert.ok(args.indexOf("-r") < args.indexOf("-i"));
  assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4), ["-f", "hevc", "-i", "v.h265"]);
  assert.deepEqual(args.slice(args.indexOf("-tag:v"), args.indexOf("-tag:v") + 2), ["-tag:v", "hvc1"]);
  assert.ok(args.includes("-map"));
  assert.ok(!args.includes("-framerate"));
});

test("muxArgs: H.264, or an unknown codec, is read as h264 with no tag and no audio map without audio", () => {
  for (const codec of ["h264", undefined]) {
    const args = muxArgs({ codec, fps: 0, hasAudio: false }, { video: "v.h264", audio: "a.aac" }, "out.mp4");
    assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2), ["-f", "h264"]);
    assert.ok(!args.includes("-tag:v"));
    assert.ok(!args.includes("-r"));
    assert.ok(!args.includes("-map"));
  }
});

test("clip: with no push, the newest recording the station names is downloaded at its storage path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-hb3-"));
  const calls = { download: [], muxed: [] };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const cam = {
    downloadRecording: async (opts) => {
      calls.download.push(opts);
      return { video: Buffer.from("V"), codec: "h265", frames: 111, missingFrames: 0, durationMs: 7900 };
    },
  };
  const newest = { recording: "20261121095110", cipherId: 0, storagePath: "/zx/hdd_data1/Camera01/x.zxvideo" };
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ status: "ok" }),
    eufy: { getDevice: async () => ({ camera: () => cam }) },
    recordingRows: async (sn) => (sn === "CAM1" ? [newest, { ...newest, recording: "20261121090000" }] : []),
    muxClip: async (clip, out) => {
      calls.muxed.push(clip.codec);
      await fs.promises.writeFile(out, "MP4");
    },
  };
  Object.assign(ctx, createClips(ctx));
  const out = {};
  await createHttpHandler(ctx)(
    { url: "/clip/CAM1", headers: { host: "localhost" }, on() {} },
    { writeHead: (code) => (out.code = code), end: (body) => (out.body = body) },
  );
  assert.equal(out.code, 200);
  assert.deepEqual(calls.download, [newest]);
  assert.deepEqual(calls.muxed, ["h265"]);
});

/** A HomeBase 3 session that answers the direct history read with `rows` and serves any requested image. */
function fakeStation(rows) {
  const s = new EventEmitter();
  s.isConnected = true;
  s.images = [];
  s.queryDatabase = (_table, opts) => {
    if (opts.innerCmd === 10000) setTimeout(() => s.emit("dbChunk", { text: JSON.stringify({ data: rows }) }), 0);
  };
  s.requestImage = (file) => {
    s.images.push(file);
    setTimeout(() => s.emit("image", { file, data: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file)]) }), 0);
  };
  return s;
}

async function run(fn) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = fn().finally(() => (done = true));
    while (!done) {
      mock.timers.tick(200);
      await new Promise((r) => setImmediate(r));
    }
    return await p;
  } finally {
    mock.timers.reset();
  }
}

function warmup(rows) {
  const station = fakeStation(rows);
  const warm = createWarmup({
    eventImageDir: fs.mkdtempSync(path.join(os.tmpdir(), "rows-")),
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map(), streaming: new Set() },
    eufy: {
      getP2pSessions: () => new Map([["HB3", station]]),
      getDevices: async () => [
        { sn: "HB3", stationSn: "HB3" },
        { sn: "CAM1", stationSn: "HB3" },
        { sn: "CAM2", stationSn: "HB3" },
      ],
      connectStation: async () => {},
    },
  });
  return { warm, station };
}

test("recordingRows: a camera's rows become recordings with their storage path, newest first", async () => {
  const { warm } = warmup([
    row("CAM1", "20261121090000", 50),
    row("CAM2", "20261121093000"),
    row("CAM1", "20261121095110"),
    { device_sn: "CAM1", record_id: 1, thumb_path: "snapshort.jpg" }, // names no recording
  ]);
  const rows = await run(() => warm.recordingRows("CAM1"));
  assert.deepEqual(
    rows.map((r) => [r.recording, r.storagePath, r.cipherId, r.frameNum, r.stationSn]),
    [
      ["20261121095110", "/zx/hdd_data1/Camera01/202611/20261121095110/20261121095110.zxvideo", 0, 111, "HB3"],
      ["20261121090000", "/zx/hdd_data1/Camera01/202611/20261121090000/20261121090000.zxvideo", 0, 50, "HB3"],
    ],
  );
  assert.equal(rows[0].coverPath, "/zx/hdd_data1/Camera01/202611/20261121095110/snapshort.jpg");
  const all = await run(() => warm.recordingRows());
  assert.deepEqual(
    all.map((r) => r.sn),
    ["CAM1", "CAM2", "CAM1"],
  );
});

test("recordingCover: fetches the row's own cover from its station", async () => {
  const { warm, station } = warmup([row("CAM1", "20261121095110")]);
  const [newest] = await run(() => warm.recordingRows("CAM1"));
  const cover = await run(() => warm.recordingCover(newest));
  assert.deepEqual(station.images, [newest.coverPath]);
  assert.equal(cover[0], 0xff);
  assert.equal(cover.subarray(2).toString(), newest.coverPath);
});
