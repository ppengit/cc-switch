import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const child =
  process.platform === "win32"
    ? (() => {
        const scriptDir = path.dirname(fileURLToPath(import.meta.url));
        const wrapper = path.join(scriptDir, "run-with-msvc.cmd");
        return spawn("cmd.exe", ["/d", "/c", wrapper, "pnpm", "exec", "tauri", ...args], {
          stdio: "inherit",
        });
      })()
    : spawn("pnpm", ["exec", "tauri", ...args], {
        stdio: "inherit",
        shell: true,
      });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("[run-tauri-msvc] Failed to start command:", error);
  process.exit(1);
});
