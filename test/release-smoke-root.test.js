import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const foreign of [false, true]) test(`release entrypoint compares canonical Git identity: foreign=${foreign}`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-root-test-")));
  const bin = join(root, "node_modules", "hoklims-devkit", "bin");
  mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, "hoklims-devkit.js"), "");
  const script = new URL("../scripts/release-smoke.js", import.meta.url).href;
  const helper = new URL("../scripts/proof-profile-smoke.js", import.meta.url).href;
  const fixtureHelper = new URL("../scripts/fixture-readiness.js", import.meta.url).href;
  const code = `import {mock} from "bun:test"; import * as path from "node:path"; import {realpathSync} from "node:fs";
    mock.module(${JSON.stringify(helper)},()=>({proofProfileSmoke:async()=>{}}));
    mock.module(${JSON.stringify(fixtureHelper)},()=>({isAttributableDirtyFixtureInstall:()=>false,prepareFixtureScope:()=>{},commitGeneratedFixtureSources:()=>{},qualifyInstalledFixture:()=>{},canonicalFixtureRoot:()=>${JSON.stringify(root)}}));
    const originalResolve=path.resolve; mock.module("node:path",()=>({...path,resolve:(...args)=>originalResolve(...args)+"/.",}));
    const spawn=Bun.spawnSync.bind(Bun); Bun.spawnSync=options=>{
      const argv=options.cmd;
      if(argv[0]!=="bunx")return spawn(options);
      if(!argv.includes("--dry-run"))throw Error("TEST_STOP_BEFORE_NATIVE_SETUP");
      const repo=argv[4]; const git=spawn({cmd:["git","-C",repo,"rev-parse","--show-toplevel"],stdout:"pipe",stderr:"pipe"});
      const canonical=realpathSync(git.stdout.toString().trim());
      return {exitCode:0,stdout:Buffer.from(JSON.stringify({ok:true,projectRoot:${foreign ? '"/foreign"' : 'canonical'},components:(argv.includes("--with")?["semctx","assertledger","latent-compass"]:["semctx"]).map(name=>({name,state:"planned"}))})),stderr:Buffer.from("")};
    }; process.argv=[process.execPath,${JSON.stringify(script)},${JSON.stringify(root)}]; await import(${JSON.stringify(script)});`;
  try {
    const result = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const out = result.stdout.toString(), err = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    if (foreign) { expect(err).toContain("Unexpected codex preflight"); expect(out).not.toContain("PASS codex"); }
    else { expect(out.match(/PASS .* dry-run/g)).toHaveLength(6); expect(err).toContain("TEST_STOP_BEFORE_NATIVE_SETUP"); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
