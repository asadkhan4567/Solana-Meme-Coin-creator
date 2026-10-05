// Opens a free Cloudflare quick tunnel to the bot (http://localhost:PORT) and reports the public
// URL to n8n, so the n8n pipeline can call POST /launch. The URL changes on every restart, so we
// re-report it on start and every 30 minutes. Needs `cloudflared` installed.
//   N8N_CHECKIN_URL  e.g. https://you.app.n8n.cloud/webhook/meme-agent-url
//   AGENT_API_TOKEN  same token the bot uses; n8n checks it on the webhook
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const port = env.PORT || "8080";
const checkinUrl = env.N8N_CHECKIN_URL;
const token = env.AGENT_API_TOKEN;
const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...extra }));
if (!checkinUrl || !token) {
  log("tunnel disabled: set N8N_CHECKIN_URL and AGENT_API_TOKEN in .env");
  process.exit(0);
}

let publicUrl = null;

async function checkIn() {
  if (!publicUrl) return;
  try {
    const r = await fetch(checkinUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: publicUrl }),
    });
    log(r.ok ? "n8n check-in ok" : "n8n check-in failed (is the workflow active?)", { status: r.status, url: publicUrl });
  } catch (err) {
    log("n8n check-in error", { error: String(err) });
  }
}

const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { windowsHide: true });
const onData = (buf) => {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && m[0] !== publicUrl) {
    publicUrl = m[0];
    log("tunnel up", { url: publicUrl });
    setTimeout(checkIn, 5000); // give the edge a moment to start routing
  }
};
cf.stdout.on("data", onData);
cf.stderr.on("data", onData);
cf.on("exit", (code) => {
  log("cloudflared exited", { code });
  process.exit(code ?? 1); // start-agent loop restarts us
});
cf.on("error", (err) => {
  log("cloudflared not found: install it with `winget install Cloudflare.cloudflared`", { error: String(err) });
  process.exit(1);
});
setInterval(checkIn, 30 * 60 * 1000);
