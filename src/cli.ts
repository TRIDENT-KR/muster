#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import { checkProject, initProject, statusProject, syncProject } from "./commands.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("muster")
  .description(
    "Org-wide control plane for AI coding agent configuration.\n" +
      "One source of truth -> AGENTS.md, CLAUDE.md, skills, and MCP config, kept in sync."
  )
  .version(pkg.version);

function fail(err: unknown): never {
  console.error(pc.red(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(2);
}

program
  .command("init")
  .description("create an muster.yaml in the current repo")
  .option("--force", "overwrite an existing muster.yaml")
  .action((opts: { force?: boolean }) => {
    try {
      const file = initProject(process.cwd(), opts);
      console.log(pc.green(`created ${file}`));
      console.log(`\nNext steps:`);
      console.log(`  1. Point ${pc.bold("source:")} at your org's agent-config repo`);
      console.log(`  2. Run ${pc.bold("muster sync")}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("sync")
  .description("render org config into this repo and update muster.lock")
  .option("--dry-run", "show what would change without writing")
  .action((opts: { dryRun?: boolean }) => {
    try {
      const report = syncProject(process.cwd(), opts);
      const colors: Record<string, (s: string) => string> = {
        create: pc.green,
        update: pc.yellow,
        delete: pc.red,
        unchanged: pc.dim,
      };
      for (const { path, action } of report.actions) {
        const paint = colors[action] ?? ((s: string) => s);
        console.log(`  ${paint(action.padEnd(9))} ${path}`);
      }
      const changed = report.actions.filter((a) => a.action !== "unchanged").length;
      if (opts.dryRun) {
        console.log(`\n${pc.bold(String(changed))} change(s) planned (dry run — nothing written)`);
      } else {
        console.log(`\n${pc.bold(String(changed))} change(s) applied`);
        if (report.sourceCommit) console.log(pc.dim(`source commit: ${report.sourceCommit}`));
      }
      if (report.stale) {
        console.log(pc.yellow("warning: could not update git source — using cached copy"));
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("check")
  .description("verify rendered files match the lock (exit 1 on drift) and report source updates")
  .option("--json", "machine-readable output")
  .action((opts: { json?: boolean }) => {
    try {
      const result = checkProject(process.cwd());
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.drift.length === 0) {
          console.log(pc.green("✓ passes muster — rendered files match muster.lock"));
        } else {
          console.log(pc.red(`✗ fails muster — drift in ${result.drift.length} file(s):`));
          for (const d of result.drift) console.log(pc.red(`    ${d.path} (${d.reason})`));
          console.log(pc.dim("  run `muster sync` to restore, or update the config source"));
        }
        if (result.sourceUnavailable) {
          console.log(pc.yellow("! config source unavailable — skipped update check"));
        } else if (result.outdated.length > 0) {
          console.log(pc.yellow(`! ${result.outdated.length} update(s) available from source:`));
          for (const o of result.outdated) console.log(pc.yellow(`    ${o.path} (${o.reason})`));
          console.log(pc.dim("  run `muster sync` to apply"));
        } else {
          console.log(pc.green("✓ up to date with config source"));
        }
      }
      process.exit(result.drift.length > 0 ? 1 : 0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("show managed artifacts and their state")
  .action(() => {
    try {
      const info = statusProject(process.cwd());
      if (!info.source) {
        console.log("not synced yet — run `muster sync`");
        return;
      }
      console.log(pc.bold("source"));
      console.log(`  ${info.source.ref}${info.source.gitRef ? ` @ ${info.source.gitRef}` : ""}`);
      if (info.source.commit) console.log(pc.dim(`  commit ${info.source.commit}`));
      console.log(pc.bold("\nartifacts"));
      const stateColor = { ok: pc.green, drift: pc.red, outdated: pc.yellow } as const;
      for (const a of info.artifacts) {
        console.log(`  ${stateColor[a.state](a.state.padEnd(9))} ${a.path} ${pc.dim(`(${a.kind})`)}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program.parse();
