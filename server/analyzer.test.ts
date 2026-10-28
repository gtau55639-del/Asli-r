import { describe, it, expect } from "vitest";
import { analyzeProject, envKeysFrom, isUnsafePath, safeName, validateEnvVars } from "./analyzer.js";

describe("safeName", () => {
  it("normalizes a ZIP filename to a safe project label", () => {
    expect(safeName("../../Cool Bot.zip")).toBe("Cool-Bot");
    expect(safeName("C:\\temp\\My Bot v2.zip")).toBe("My-Bot-v2");
    expect(safeName("..zip")).toBe("bot-template");
  });
});

describe("isUnsafePath", () => {
  it("rejects traversal and absolute paths", () => {
    for (const p of ["../evil.js", "folder/../../evil.js", "/etc/passwd", "C:/x", "a\\..\\b", "./x"]) expect(isUnsafePath(p)).toBe(true);
    expect(isUnsafePath("src/index.js")).toBe(false);
  });
});

describe("envKeysFrom", () => {
  it("finds env names and skips NODE_ENV", () => {
    const keys = envKeysFrom("process.env.API_KEY; process.env['BOT_TOKEN']; process.env.NODE_ENV");
    expect(keys.sort()).toEqual(["API_KEY", "BOT_TOKEN"]);
  });
});

describe("analyzeProject", () => {
  it("handles a project wrapped in one folder", () => {
    const r = analyzeProject(["bot/package.json", "bot/index.js"], { scripts: { start: "node index.js" }, dependencies: { x: "1" } }, "");
    expect(r.root).toBe("bot/");
    expect(r.entryPoint).toBe("index.js");
    expect(r.compatible).toBe(true);
  });
  it("flags TypeScript entry without start script", () => {
    const r = analyzeProject(["package.json", "src/index.ts"], { devDependencies: { typescript: "5" } }, "");
    expect(r.language).toBe("TypeScript");
    expect(r.warnings.some((w) => w.includes("script start") || w.includes('"start"'))).toBe(true);
  });
  it("marks a ZIP without package.json as incompatible", () => {
    expect(analyzeProject(["a.py"], null, "").compatible).toBe(false);
  });
});

describe("validateEnvVars", () => {
  it("accepts normal vars", () => expect(validateEnvVars({ BOT_TOKEN: "abc" }).ok).toBe(true));
  it("rejects reserved and malformed names", () => {
    expect(validateEnvVars({ PATH: "/x" }).ok).toBe(false);
    expect(validateEnvVars({ NODE_OPTIONS: "--require x" }).ok).toBe(false);
    expect(validateEnvVars({ "1BAD": "x" }).ok).toBe(false);
    expect(validateEnvVars({ A: 1 }).ok).toBe(false);
  });
});
