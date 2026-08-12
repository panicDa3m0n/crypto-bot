import { resolve } from "node:path";
import { CycleStore } from "./cycle-store.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npm run show-cycle -- <cycle-id>");
  process.exitCode = 1;
} else {
  const directory = resolve(process.env.SCARLET_DATA_DIRECTORY?.trim() || "data");
  const cycle = await new CycleStore(directory).get(id);
  if (!cycle) { console.error(`Cycle not found: ${id}`); process.exitCode = 2; }
  else console.log(JSON.stringify(cycle, null, 2));
}
