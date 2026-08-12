import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { CycleEngine, type CycleInput } from "./cycle-engine.js";

const file = argumentValue("--input");
const stdin = process.argv.includes("--stdin");
if (!file && !stdin) {
  console.error("Usage: npm run cycle -- --input /private/path/cycle-input.json | --stdin");
  process.exitCode = 1;
} else {
  const raw = file ? await readFile(file, "utf8") : await readStdin();
  const input = JSON.parse(raw) as CycleInput;
  const record = await new CycleEngine(loadConfig()).run(input);
  console.log(JSON.stringify({ id: record.id, status: record.status, summary: record.summary, createdAt: record.createdAt, completedAt: record.completedAt }, null, 2));
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}
