import { useState, useEffect } from "react";
import { FormCheck, ProgressBar } from "react-bootstrap";
import { Trans } from "react-i18next";
import i18next from "i18next";

import axios from "../lib/axios_instance";
import Config from "../lib/config";
import Loading from "./components/general/loading";
import "./css/server.css";
import "./css/events.css";

// "Server" page: media conversion job (optional), system load, disks, OS services, folder sizes.
// Backend: backend/routes/panel.js, configured by backend/panel.config.json.
const t = (k, o) => i18next.t(`SERVER_PAGE.${k}`, o);
const gb = (mb) =>
  (mb / 1024).toLocaleString(i18next.language, { maximumFractionDigits: 1 }) +
  " GB";
const fmtGB = (g) =>
  g.toLocaleString(i18next.language, {
    maximumFractionDigits: g < 10 ? 1 : 0,
  }) + " GB";
const fmtBytes = (b) =>
  b >= 1099511627776
    ? (b / 1099511627776).toFixed(2) + " TB"
    : fmtGB(b / 1073741824);
const hms = (s) => {
  if (s == null || !isFinite(s)) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const clock = (s) => {
  if (s == null) return "–";
  s = Math.floor(s);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};
const fmtDate = (d) => {
  let x = new Date(d);
  // schtasks returns local text such as "14.11.2026 3:00:00"
  const m = String(d).match(
    /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}):(\d{2})/,
  );
  if (m) x = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  if (isNaN(x)) return d;
  return x.toLocaleString(i18next.language, {
    weekday: "short",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};
const pctVariant = (p) => (p > 90 ? "danger" : p > 75 ? "warning" : "info");

function Stat({ label, value, sub, big }) {
  return (
    <div className={`srv-stat ${big ? "srv-stat-big" : ""}`}>
      <div className="srv-stat-label">{label}</div>
      <div className="srv-stat-value">{value}</div>
      {sub && <div className="srv-stat-sub">{sub}</div>}
    </div>
  );
}

function ServerPanel() {
  const [config, setConfig] = useState(null);
  const [data, setData] = useState(null);
  const [showStarts, setShowStarts] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!config) {
      Config.getConfig()
        .then(setConfig)
        .catch((e) => console.log(e));
      return;
    }
    let timer;
    const load = () =>
      axios
        .get("/panel/status", {
          headers: { Authorization: `Bearer ${config.token}` },
        })
        .then((res) => {
          // an old backend without /panel answers with index.html
          if (res.data && typeof res.data === "object" && res.data.conversion) {
            setData(res.data);
            setError(null);
          } else setError(t("NO_BACKEND"));
        })
        .catch((e) => {
          console.log(e);
          setError(
            e?.response?.status
              ? `HTTP ${e.response.status}`
              : String(e?.message ?? e),
          );
        })
        .finally(() => {
          // refresh less often in background tabs
          timer = setTimeout(load, document.hidden ? 120000 : 15000);
        });
    load();
    return () => clearTimeout(timer);
  }, [config]);

  if (!data && error)
    return (
      <div className="srv">
        <h1 className="my-3">
          <Trans i18nKey="MENU_TABS.SERVER" />
        </h1>
        <div className="srv-card text-warning">{error}</div>
      </div>
    );
  if (!data) return <Loading />;

  const { conversion: c, system: s } = data;
  const st = c?.stats;
  const savedMB = st ? st.beforeMB - st.afterMB : 0;
  const job = c?.job;
  const memUsed = s.memTotalGB - s.memFreeGB;
  const events = (c?.events ?? []).filter(
    (e) => showStarts || e.type !== "start",
  );

  return (
    <div className="srv">
      <div className="d-flex justify-content-between align-items-center">
        <h1 className="my-3">
          <Trans i18nKey="MENU_TABS.SERVER" />
        </h1>
        <span className="text-secondary fs-small">
          {t("UPDATED")}{" "}
          {new Date(data.generatedAt).toLocaleTimeString(i18next.language)}
        </span>
      </div>

      {/* ---- conversion job (only when configured) ---- */}
      {c && (
        <div className="srv-card">
          <div className="srv-card-head">
            <h4>{t("CONVERSION")}</h4>
            <span className={`srv-badge ${c.running ? "on" : ""}`}>
              {c.running ? t("RUNNING") : t("IDLE")}
            </span>
          </div>

          <div className="srv-stats">
            <Stat
              big
              label={t("SAVED")}
              value={gb(savedMB)}
              sub={
                st.beforeMB
                  ? `${Math.round((savedMB / st.beforeMB) * 100)} %`
                  : null
              }
            />
            <Stat label={t("CONVERTED")} value={st.count} />
            <Stat
              label={t("BEFORE_AFTER")}
              value={`${gb(st.beforeMB)} → ${gb(st.afterMB)}`}
            />
            {c.schedule && (
              <Stat
                label={t("NEXT_RUN")}
                value={fmtDate(c.schedule.next)}
                sub={
                  c.schedule.last
                    ? `${t("LAST_RUN")}: ${fmtDate(c.schedule.last)}`
                    : null
                }
              />
            )}
          </div>

          {job && (
            <div className="srv-job">
              <div className="srv-job-title" title={job.file}>
                {job.file ?? "…"}{" "}
                {job.sizeMB ? (
                  <span className="text-secondary">({gb(job.sizeMB)})</span>
                ) : null}
              </div>
              <ProgressBar
                animated
                now={job.percent ?? 100}
                label={job.percent != null ? `${job.percent.toFixed(1)} %` : ""}
                variant="info"
                className="my-2"
              />
              <div className="srv-job-meta">
                <span>
                  {t("POSITION")}: {clock(job.positionSec)} /{" "}
                  {clock(job.durationSec)}
                </span>
                <span>
                  {t("SPEED")}: {job.speed ? `${job.speed}×` : "–"}{" "}
                  {job.fps ? `(${Math.round(job.fps)} fps)` : ""}
                </span>
                <span>
                  {t("ETA")}: {hms(job.etaSec)}
                  {job.etaSec != null && (
                    <span className="text-secondary">
                      {" "}
                      ({t("FINISH_AT")}{" "}
                      {new Date(
                        Date.now() + job.etaSec * 1000,
                      ).toLocaleTimeString(i18next.language, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      )
                    </span>
                  )}
                </span>
                {job.outMB != null && (
                  <span>
                    {t("WRITTEN")}: {gb(job.outMB)}
                  </span>
                )}
              </div>
            </div>
          )}

          {st.errors.length > 0 && (
            <div className="srv-errors">
              <strong>{t("ERRORS")}:</strong>
              <ul>
                {st.errors.map((e) => (
                  <li key={e.name}>
                    <span className="text-secondary">{e.at}</span> {e.msg}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {c.skipped.length > 0 && (
            <div className="text-secondary fs-small mb-2">
              {t("SKIPPED")}: {c.skipped.join(", ")}
            </div>
          )}

          <div className="d-flex justify-content-between align-items-center mt-3">
            <h5 className="m-0">{t("LOG")}</h5>
            <FormCheck
              type="switch"
              id="srv-starts"
              label={t("SHOW_STARTS")}
              checked={showStarts}
              onChange={(e) => setShowStarts(e.target.checked)}
            />
          </div>
          <div className="srv-log">
            {events.map((e, i) => (
              <div key={i} className={`srv-log-row ${e.type}`}>
                <span className="srv-log-at">{e.at ?? ""}</span>
                <span className="srv-log-text">{e.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="srv-grid">
        {/* ---- system ---- */}
        <div className="srv-card">
          <h4>{t("SYSTEM")}</h4>
          <div className="srv-meter">
            <div className="d-flex justify-content-between">
              <span>{t("CPU")}</span>
              <span>{s.cpuPercent} %</span>
            </div>
            <ProgressBar
              now={s.cpuPercent}
              variant={pctVariant(s.cpuPercent)}
            />
            <div className="text-secondary fs-small">
              {s.cpuModel} · {s.cores}×
            </div>
          </div>
          <div className="srv-meter">
            <div className="d-flex justify-content-between">
              <span>{t("RAM")}</span>
              <span>
                {fmtGB(memUsed)} / {fmtGB(s.memTotalGB)}
              </span>
            </div>
            <ProgressBar
              now={(memUsed / s.memTotalGB) * 100}
              variant={pctVariant((memUsed / s.memTotalGB) * 100)}
            />
          </div>
          <div className="text-secondary fs-small">
            {t("UPTIME")}:{" "}
            {hms(s.uptimeSec).replace(/^(\d+) h/, (m, h) =>
              h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : m,
            )}
          </div>
        </div>

        {/* ---- disks ---- */}
        <div className="srv-card">
          <h4>{t("DISKS")}</h4>
          {data.disks.map((d) => {
            const used = d.totalGB - d.freeGB;
            const p = (used / d.totalGB) * 100;
            return (
              <div key={d.drive} className="srv-meter">
                <div className="d-flex justify-content-between">
                  <span>{d.drive}</span>
                  <span>
                    {fmtGB(d.freeGB)} {t("FREE")} / {fmtGB(d.totalGB)}
                  </span>
                </div>
                <ProgressBar now={p} variant={pctVariant(p)} />
              </div>
            );
          })}
        </div>

        {/* ---- services ---- */}
        {data.services.length > 0 && (
          <div className="srv-card">
            <h4>{t("SERVICES")}</h4>
            {data.services.map((x) => (
              <div key={x.name} className="srv-svc">
                <span
                  className={`srv-dot ${x.state === "RUNNING" ? "on" : "off"}`}
                />
                <span className="flex-grow-1">{x.label}</span>
                <span className="text-secondary fs-small">
                  {t(`STATE.${x.state}`, { defaultValue: x.state })}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ---- folder sizes ---- */}
        {(!data.folders || data.folders.length > 0) && (
          <div className="srv-card">
            <h4>{t("FOLDERS")}</h4>
            {!data.folders ? (
              <div className="text-secondary">{t("CALCULATING")}</div>
            ) : (
              data.folders.map((f) => (
                <div key={f.label} className="srv-svc">
                  <span className="flex-grow-1">{f.label}</span>
                  <span>{fmtBytes(f.bytes)}</span>
                  <span className="text-secondary fs-small ms-2">
                    {f.files} {t("FILES")}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ServerPanel;
