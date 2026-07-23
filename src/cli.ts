#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import {
  checkProject,
  diffProject,
  ejectProject,
  initProject,
  statusProject,
  syncProject,
} from "./commands.js";
import { adoptProject } from "./adopt.js";

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
  .command("adopt")
  .description("scan existing agent config (AGENTS.md, CLAUDE.md, skills, mcp) and extract it into a central source")
  .option("--dir <dir>", "source directory to create", "agent-config")
  .option("--no-sync", "extract only; skip the initial sync")
  .option("--dry-run", "report what would be adopted without writing anything")
  .action((opts: { dir: string; sync: boolean; dryRun?: boolean }) => {
    try {
      const report = adoptProject(process.cwd(), { dir: opts.dir, dryRun: opts.dryRun });
      const say = (label: string, painted: (s: string) => string, text: string) =>
        console.log(`  ${painted(label.padEnd(9))} ${text}`);
      for (const f of report.fragments) say("adopt", pc.green, `${f.file}  ← ${f.from}`);
      for (const s of report.skills) say("adopt", pc.green, `skills/${s}/  ← .claude/skills/${s}/`);
      for (const s of report.servers) say("adopt", pc.green, `mcp: ${s.name}  ← ${s.from}`);
      for (const s of report.secretsReplaced)
        say("secret", pc.red, `${s.server}.${s.field} → ${s.ref} (literal value NOT copied — export it as an env var)`);
      for (const c of report.captured) say("captured", pc.yellow, `${c} (now rendered by muster)`);
      for (const n of report.notes) say("note", pc.yellow, n);

      if (opts.dryRun) {
        console.log(`\ndry run — nothing written`);
        return;
      }
      console.log(`\ncreated ${report.sourceDir}/ and muster.yaml (targets: ${report.targets.join(", ")})`);
      if (opts.sync) {
        console.log("");
        const sync = syncProject(process.cwd());
        for (const { path: p, action } of sync.actions) {
          if (action !== "unchanged") console.log(`  ${pc.green(action.padEnd(9))} ${p}`);
        }
        console.log(`\n${pc.green("✓")} adopted and synced — review with ${pc.bold("git diff")}, then commit`);
        console.log(pc.dim(`next: move ${report.sourceDir}/ into a shared git repo to distribute org-wide`));
      } else {
        console.log(pc.dim("run `muster sync` to render the managed files"));
      }
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
  .command("diff")
  .description("show the exact content changes `muster sync` would make (exit 1 if any)")
  .action(() => {
    try {
      const entries = diffProject(process.cwd());
      if (entries.length === 0) {
        console.log(pc.green("✓ no changes — rendered files already match the config source"));
        process.exit(0);
      }
      for (const entry of entries) {
        console.log(pc.bold(`\n▸ ${entry.path} ${pc.dim(`(${entry.action})`)}`));
        for (const line of entry.diff.trimEnd().split("\n")) {
          if (line.startsWith("+++") || line.startsWith("---")) console.log(pc.dim(line));
          else if (line.startsWith("@@")) console.log(pc.cyan(line));
          else if (line.startsWith("+")) console.log(pc.green(line));
          else if (line.startsWith("-")) console.log(pc.red(line));
          else console.log(line);
        }
      }
      console.log(`\n${pc.bold(String(entries.length))} file(s) would change — run ${pc.bold("muster sync")} to apply`);
      process.exit(1);
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
  .command("eject")
  .description("remove everything muster manages: strip managed regions, delete synced files and muster.lock")
  .action(() => {
    try {
      const { removed } = ejectProject(process.cwd());
      for (const p of removed) console.log(`  ${pc.red("removed".padEnd(9))} ${p}`);
      console.log(`\n${pc.bold(String(removed.length))} artifact(s) ejected — local content preserved`);
      console.log(pc.dim("muster.yaml kept so you can re-sync later; delete it to fully remove muster"));
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
