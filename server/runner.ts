import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type RunnableProject = {
  projectId: string;
  name: string;
  workspace: string;
  root: string; // sub-folder inside workspace that holds package.json ("" or "bot/")
  scripts: Record<string, string>;
  entryPoint: string | null;
  env: Record<string, string>;
};

type Status = "installing" | "online" | "stopped" | "error";

type Handle = {
  child: ChildProcess;
  kind: "install" | "run";
  stopping: boolean;
};

const MAX_LOG_LINES = 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function createRunner(opts: {
  storage: string;
  onStatus: (projectId: string, status: Status, extra?: { installed?: boolean }) => void;
  log: (level: string, message: string, projectId?: string) => void;
}) {
  const handles = new Map<string, Handle>();
  const buffers = new Map<string, string[]>();
  const partial = new Map<string, string>();
  const maxRunning = Math.max(1, Number(process.env.MAX_RUNNING_BOTS || 3));
  const memoryMb = Math.max(64, Number(process.env.BOT_MEMORY_MB || 384));

  function push(id: string, chunk: string, stream: "out" | "err" | "sys") {
    const buf = buffers.get(id) ?? [];
    buffers.set(id, buf);
    const key = `${id}:${stream}`;
    const lines = ((partial.get(key) ?? "") + chunk.replace(/\r\n?/g, "\n")).split("\n");
    partial.set(key, lines.pop() ?? ""); // keep the unfinished last line for the next chunk
    const stamp = new Date().toISOString().slice(11, 19);
    const tag = stream === "err" ? "ERR " : stream === "sys" ? "SYS " : "";
    for (const line of lines) buf.push(`[${stamp}] ${tag}${line.slice(0, 2000)}`);
    if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
  }

  async function exists(p: string) {
    return fs.stat(p).then(() => true, () => false);
  }

  async function childEnv(p: RunnableProject, mode: "install" | "run") {
    const home = path.join(opts.storage, "home", p.projectId);
    await fs.mkdir(home, { recursive: true });
    const base: Record<string, string> = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      LANG: process.env.LANG || "C.UTF-8",
      npm_config_cache: path.join(home, ".npm"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false"
    };
    if (mode === "install") return { ...base, NODE_ENV: "development" };
    return {
      ...base,
      NODE_ENV: "production",
      NODE_OPTIONS: `--max-old-space-size=${memoryMb}`,
      ...p.env // validated upstream; reserved names are rejected
    };
  }

  function killTree(h: Handle, signal: NodeJS.Signals) {
    const pid = h.child.pid;
    if (!pid) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else h.child.kill(signal);
    } catch {
      try { h.child.kill(signal); } catch { /* already gone */ }
    }
  }

  function watch(p: RunnableProject, h: Handle) {
    h.child.stdout?.on("data", (d: Buffer) => push(p.projectId, d.toString("utf8"), "out"));
    h.child.stderr?.on("data", (d: Buffer) => push(p.projectId, d.toString("utf8"), "err"));
  }

  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

  async function install(p: RunnableProject): Promise<void> {
    if (handles.has(p.projectId)) throw new Error("Proses lain masih berjalan untuk proyek ini. Hentikan dulu.");
    const cwd = path.join(p.workspace, p.root);
    if (!(await exists(path.join(cwd, "package.json")))) throw new Error("package.json tidak ditemukan di workspace.");
    buffers.set(p.projectId, []);
    push(p.projectId, "npm install --ignore-scripts (script lifecycle dinonaktifkan demi keamanan)\n", "sys");
    const child = spawn(npmBin, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd, env: await childEnv(p, "install"), stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", shell: process.platform === "win32"
    });
    const h: Handle = { child, kind: "install", stopping: false };
    handles.set(p.projectId, h);
    watch(p, h);
    opts.onStatus(p.projectId, "installing");
    opts.log("info", `Install dependencies started for "${p.name}".`, p.projectId);
    const timer = setTimeout(() => { push(p.projectId, "Install melebihi batas waktu 10 menit, dihentikan.\n", "sys"); killTree(h, "SIGKILL"); }, INSTALL_TIMEOUT_MS);
    child.once("error", (e) => {
      clearTimeout(timer); handles.delete(p.projectId);
      push(p.projectId, `Gagal menjalankan npm: ${e.message}\n`, "sys");
      opts.onStatus(p.projectId, "error");
      opts.log("error", `Install failed to start: ${e.message}`, p.projectId);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (handles.get(p.projectId) === h) handles.delete(p.projectId);
      const ok = code === 0;
      push(p.projectId, `Install selesai dengan kode ${code}.\n`, "sys");
      opts.onStatus(p.projectId, ok ? "stopped" : "error", { installed: ok });
      opts.log(ok ? "info" : "error", `Install ${ok ? "succeeded" : "failed"} for "${p.name}" (exit ${code}).`, p.projectId);
    });
  }

  function resolveCommand(p: RunnableProject): { cmd: string; args: string[]; label: string } {
    if (p.scripts.start) return { cmd: npmBin, args: ["start", "--silent"], label: "npm start" };
    if (p.entryPoint && /\.(js|mjs|cjs)$/.test(p.entryPoint)) {
      return { cmd: process.execPath, args: [p.entryPoint], label: `node ${p.entryPoint}` };
    }
    throw new Error("Tidak ada script \"start\" dan entry point JavaScript. Tambahkan script start pada package.json.");
  }

  async function start(p: RunnableProject): Promise<void> {
    if (handles.has(p.projectId)) throw new Error(handles.get(p.projectId)!.kind === "install" ? "Install dependencies masih berjalan." : "Bot sudah berjalan.");
    const running = [...handles.values()].filter((h) => h.kind === "run").length;
    if (running >= maxRunning) throw new Error(`Batas bot aktif tercapai (${maxRunning}). Hentikan bot lain atau naikkan MAX_RUNNING_BOTS.`);
    const cwd = path.join(p.workspace, p.root);
    const hasPkg = await exists(path.join(cwd, "package.json"));
    if (!hasPkg) throw new Error("package.json tidak ditemukan di workspace.");
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    const needsDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    if (needsDeps && !(await exists(path.join(cwd, "node_modules")))) throw new Error("Dependensi belum dipasang. Klik \"Install dependencies\" terlebih dahulu.");
    const { cmd, args, label } = resolveCommand(p);
    push(p.projectId, `Menjalankan: ${label}\n`, "sys");
    const child = spawn(cmd, args, {
      cwd, env: await childEnv(p, "run"), stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", shell: process.platform === "win32" && cmd === npmBin
    });
    const h: Handle = { child, kind: "run", stopping: false };
    handles.set(p.projectId, h);
    watch(p, h);
    child.once("spawn", () => {
      opts.onStatus(p.projectId, "online");
      opts.log("info", `Bot "${p.name}" started (pid ${child.pid}).`, p.projectId);
    });
    child.once("error", (e) => {
      if (handles.get(p.projectId) === h) handles.delete(p.projectId);
      push(p.projectId, `Gagal menjalankan proses: ${e.message}\n`, "sys");
      opts.onStatus(p.projectId, "error");
      opts.log("error", `Bot failed to start: ${e.message}`, p.projectId);
    });
    child.once("close", (code, signal) => {
      if (handles.get(p.projectId) === h) handles.delete(p.projectId);
      const clean = h.stopping || code === 0;
      push(p.projectId, `Proses berhenti (kode ${code ?? "-"}, sinyal ${signal ?? "-"}).\n`, "sys");
      opts.onStatus(p.projectId, clean ? "stopped" : "error");
      opts.log(clean ? "info" : "error", `Bot "${p.name}" exited (code ${code}, signal ${signal}).`, p.projectId);
    });
  }

  async function stop(projectId: string): Promise<boolean> {
    const h = handles.get(projectId);
    if (!h) return false;
    h.stopping = true;
    killTree(h, "SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { killTree(h, "SIGKILL"); resolve(); }, 8000);
      h.child.once("close", () => { clearTimeout(t); resolve(); });
    });
    return true;
  }

  async function stopAll() {
    await Promise.all([...handles.keys()].map((id) => stop(id)));
  }

  return {
    install, start, stop, stopAll,
    isBusy: (id: string) => handles.has(id),
    isRunning: (id: string) => handles.get(id)?.kind === "run",
    logs: (id: string) => buffers.get(id) ?? [],
    clearLogs: (id: string) => { buffers.delete(id); for (const k of ["out", "err", "sys"]) partial.delete(`${id}:${k}`); },
    forget: async (id: string) => { await stop(id); buffers.delete(id); for (const k of ["out", "err", "sys"]) partial.delete(`${id}:${k}`); await fs.rm(path.join(opts.storage, "home", id), { recursive: true, force: true }); }
  };
}

export type Runner = ReturnType<typeof createRunner>;
