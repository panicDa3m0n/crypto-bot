import { BexQuoteService, BexQuoteStore } from "./bex-quote.js";
import { BexStore } from "./bex.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";

const value = (flag: string): string | undefined => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; };
const address = value("--address"); const tokenIn = value("--token-in"); const tokenOut = value("--token-out"); const amountInRaw = value("--amount-in-raw");
if (!address || !tokenIn || !tokenOut || !amountInRaw) throw new Error("Usage: bex-quote --address 0x... --token-in 0x... --token-out 0x... --amount-in-raw INTEGER");
const config = loadNetworkConfig();
const quote = await new BexQuoteService(new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl), new BexStore(config.dataDirectory), new BexQuoteStore(config.dataDirectory)).exactIn({ walletAddress: address, tokenIn, tokenOut, amountInRaw });
process.stdout.write(`${JSON.stringify(quote, null, 2)}\n`);
