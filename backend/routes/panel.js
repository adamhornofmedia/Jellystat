// "Server" page backend: media conversion job status, disks, OS services, system load, folder sizes.
// Mounted in server.js under /panel behind authenticate. Everything machine-specific comes from a
// local config file (backend/panel.config.json, git-ignored; see panel.config.example.json) or
// the JS_PANEL_CONFIG env var pointing to one. Sections without config are simply left out.
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const router = express.Router();

function loadConfig() {
  const file = process.env.JS_PANEL_CONFIG || path.join(__dirname, "..", "panel.config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}
const CFG = loadConfig();
const CONV = CFG.conversion || null; // { log, progress, state, task, taskHour }
const FOLDERS = Array.isArray(CFG.folders) ? CFG.folders : []; // [{ label, dir }]
const SERVICES = Array.isArray(CFG.services) ? CFG.services : []; // [{ name, label }]

const run = (cmd, args, timeout = 5000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)))
  );

const readText = async (f) => {
  try {
    return (await fsp.readFile(f, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
};

// ---------- conversion job ----------
// Log format (one line per event): "YYYY-MM-DD HH:MM:SS  <KEYWORD>..." where KEYWORD is
// START / HOTOVO (done, "name  X MB -> Y MB") / CHYBA (error) / PRESKAKUJI (skipped) / SMAZAN (original deleted) / VSE DOKONCENO (run finished).
const num = (s) => parseInt(String(s).replace(/[\s  ]/g, ""), 10);

function parseLog(text) {
  const lines = (text || "").split(/\r?\n/).filter(Boolean);
  const done = new Map(); // name -> {before, after, at}
  const errors = new Map(); // name -> {at, msg}
  const events = [];
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/);
    if (!m) {
      events.push({ at: null, type: "info", text: line.replace(/^-+\s*|\s*-+$/g, "") });
      continue;
    }
    const [, at, msg] = m;
    let type = "info";
    let name = null;
    let x;
    if ((x = msg.match(/^HOTOVO[^:]*:\s+(\S+)\s+(\d[\d\s  ]*) MB -> (\d[\d\s  ]*) MB/))) {
      type = "done";
      name = x[1];
      done.set(name, { before: num(x[2]), after: num(x[3]), at });
      errors.delete(name);
    } else if ((x = msg.match(/^HOTOVO[^:]*:\s+(\S+)/))) {
      type = "done";
      name = x[1];
      errors.delete(name);
    } else if (msg.startsWith("CHYBA")) {
      type = "error";
      x = msg.match(/:\s+(\S+\.mkv)/);
      if (x) errors.set(x[1], { at, msg });
    } else if (msg.startsWith("START")) type = "start";
    else if (msg.startsWith("PRESKAKUJI")) type = "skip";
    else if (msg.startsWith("SMAZAN")) type = "deleted";
    else if (msg.startsWith("VSE DOKONCENO")) type = "finished";
    else if (msg.startsWith("OPRAVA")) type = "info";
    events.push({ at, type, text: msg });
  }
  let before = 0;
  let after = 0;
  for (const d of done.values()) {
    before += d.before;
    after += d.after;
  }
  const lastStart = [...events].reverse().find((e) => e.type === "start");
  return {
    stats: { count: done.size, beforeMB: before, afterMB: after, errors: [...errors].map(([n, e]) => ({ name: n, ...e })) },
    // newest first; skipped files repeat on every run, so they are only listed once
    events: events.filter((e) => e.type !== "skip").slice(-60).reverse(),
    skipped: [...new Set(events.filter((e) => e.type === "skip" && /\(h264/.test(e.text)).map((e) => (e.text.match(/:\s+(\S+\.mkv)$/) || [])[1]).filter(Boolean))],
    lastStart,
  };
}

async function currentJob() {
  if (!CONV?.progress) return null;
  let st;
  try {
    st = await fsp.stat(CONV.progress);
  } catch {
    return null;
  }
  const text = (await readText(CONV.progress)) || "";
  // ffmpeg -progress output: key=value blocks appended over time, the last block wins
  const kv = {};
  for (const l of text.split(/\r?\n/)) {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  const ageSec = (Date.now() - st.mtimeMs) / 1000;
  // written every stats_period (30 s); progress=end means the file is finished
  const running = kv.progress === "continue" && ageSec < 120;
  if (!running) return null;
  let state = null;
  try {
    // optional { soubor, delka, start, hevc, velikostMB } written by the conversion script at start
    if (CONV.state) state = JSON.parse(await readText(CONV.state));
  } catch {}
  const pos = kv.out_time_us ? parseInt(kv.out_time_us) / 1e6 : null;
  const speed = kv.speed ? parseFloat(kv.speed) : null;
  const dur = state?.delka ? Number(state.delka) : null;
  const percent = pos != null && dur ? Math.min(100, (pos / dur) * 100) : null;
  const etaSec = pos != null && dur && speed > 0 ? (dur - pos) / speed : null;
  return {
    file: state?.soubor ?? null,
    hevc: state?.hevc ?? null,
    sizeMB: state?.velikostMB ?? null,
    startedAt: state?.start ?? null,
    positionSec: pos,
    durationSec: dur,
    percent,
    etaSec,
    speed,
    fps: kv.fps ? parseFloat(kv.fps) : null,
    bitrate: kv.bitrate ?? null,
    outMB: kv.total_size ? Math.round(parseInt(kv.total_size) / 1048576) : null,
  };
}

async function nextRun() {
  if (!CONV?.task && CONV?.taskHour == null) return null;
  const out = CONV.task && process.platform === "win32" ? await run("schtasks", ["/query", "/tn", CONV.task, "/fo", "csv", "/v", "/nh"]) : null;
  if (out) {
    // columns: HostName,TaskName,Next Run Time,Status,Logon Mode,Last Run Time,Last Result,...
    const cols = out.trim().split(/\r?\n/)[0].match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (cols && cols.length > 6) return { next: cols[2], last: cols[5], lastResult: cols[6], source: "schtasks" };
  }
  if (CONV.taskHour == null) return null;
  const d = new Date();
  d.setHours(CONV.taskHour, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return { next: d.toISOString(), source: "computed" };
}

// ---------- system ----------
function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}
let lastCpu = cpuTimes();
let cpuPercent = 0;
setInterval(() => {
  const now = cpuTimes();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    idle += c.idle - lastCpu[i].idle;
    total += c.total - lastCpu[i].total;
  });
  cpuPercent = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  lastCpu = now;
}, 5000).unref();

function disks() {
  const res = [];
  // Windows: every drive letter; elsewhere "/" plus extra mount points from config ("disks": ["/mnt/media"])
  const roots =
    process.platform === "win32" ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((L) => `${L}:\\`) : ["/", ...(CFG.disks || [])];
  for (const root of roots) {
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize;
      // skip empty/optical drives (e.g. a mounted ISO)
      if (!total || (s.bavail === 0 && total < 50 * 1073741824)) continue;
      res.push({ drive: root.replace(/\\$/, ""), totalGB: total / 1073741824, freeGB: (s.bavail * s.bsize) / 1073741824 });
    } catch {}
  }
  return res;
}

async function services() {
  return Promise.all(
    SERVICES.map(async (s) => {
      if (process.platform === "win32") {
        const out = await run("sc", ["query", s.name]);
        const m = out && out.match(/STATE\s*:\s*\d+\s+(\w+)/);
        return { ...s, state: m ? m[1] : out ? "UNKNOWN" : "NOT_FOUND" };
      }
      // systemd: "active" / "inactive" / "failed"...
      const out = await run("systemctl", ["is-active", s.name]);
      const v = (out || "").trim();
      return { ...s, state: v === "active" ? "RUNNING" : v ? "STOPPED" : "NOT_FOUND" };
    })
  );
}

// ---------- folder sizes (slow, cached for 10 min) ----------
let folderCache = { at: 0, data: null, busy: null };
async function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += (await fsp.stat(p)).size;
          files++;
        } catch {}
      }
    }
  }
  return { bytes, files };
}
async function folders() {
  if (folderCache.data && Date.now() - folderCache.at < 10 * 60 * 1000) return folderCache.data;
  if (!folderCache.busy) {
    folderCache.busy = Promise.all(FOLDERS.map(async (f) => ({ label: f.label, ...(await dirStats(f.dir)) })))
      .then((data) => {
        folderCache = { at: Date.now(), data, busy: null };
        return data;
      })
      .catch(() => {
        folderCache.busy = null;
        return null;
      });
  }
  return folderCache.data ?? folderCache.busy;
}

router.get("/status", async (req, res) => {
  try {
    const [logText, job, schedule, svc, fold] = await Promise.all([CONV?.log ? readText(CONV.log) : null, currentJob(), nextRun(), services(), folders()]);
    const log = parseLog(logText);
    res.send({
      generatedAt: new Date().toISOString(),
      conversion: CONV && {
        running: !!job,
        job,
        schedule,
        stats: log.stats,
        skipped: log.skipped,
        events: log.events,
      },
      system: {
        cpuPercent,
        cpuModel: os.cpus()[0]?.model?.trim(),
        cores: os.cpus().length,
        memTotalGB: os.totalmem() / 1073741824,
        memFreeGB: os.freemem() / 1073741824,
        uptimeSec: os.uptime(),
        os: `${os.type()} ${os.release()}`,
      },
      disks: disks(),
      services: svc,
      folders: fold,
    });
  } catch (error) {
    console.log(error);
    res.status(503).send({ error: "Panel status failed" });
  }
});

module.exports = router;
