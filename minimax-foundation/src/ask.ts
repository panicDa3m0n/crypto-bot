import { loadConfig } from "./config.js";
import { MiniMaxClient } from "./client.js";

const input = process.argv.slice(2).join(" ").trim();
if (!input) {
  console.error('Usage: npm run ask -- "your request"');
  process.exitCode = 1;
} else {
  const client = new MiniMaxClient(loadConfig());
  const reply = await client.ask(input);
  console.log(JSON.stringify(reply, null, 2));
}
