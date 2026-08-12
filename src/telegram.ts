import { Bot } from "grammy";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { AgentLoop } from "./agent.js";
import type { Database } from "./db.js";
import type { StrategyEngine } from "./strategy.js";
import type { NetworkResearcher } from "./research.js";

export function startTelegram(config: Config, agent: AgentLoop, db: Database, strategies: StrategyEngine, research: NetworkResearcher, logger: Logger): Bot | undefined {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_ADMIN_CHAT_ID) return undefined;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== config.TELEGRAM_ADMIN_CHAT_ID) return;
    await next();
  });
  bot.command("status", async (ctx) => {
    const latest = agent.lastDecision;
    const portfolio = latest?.portfolio ?? await db.latestPortfolio();
    const decision = latest?.decision ?? (await db.latestDecision())?.decision;
    if (!portfolio || !decision) return ctx.reply("Sto ancora raccogliendo il primo stato mainnet.");
    return ctx.reply(`NAV stimato: $${portfolio.estimatedNavUsd.toFixed(4)}\nAsset base: ${portfolio.baseAsset} (${portfolio.baseAssetBalance.toFixed(6)})\nUSDC.e: ${portfolio.usdcE.toFixed(4)}\nHONEY: ${portfolio.honey.toFixed(4)}\nBERA: ${portfolio.bera.toFixed(6)}\nWBERA: ${portfolio.wbera.toFixed(6)}\nPerdita 24h: $${portfolio.dailyLossUsd.toFixed(4)}\nDecisione: ${decision.action} (${decision.strategyId})`);
  });
  bot.command("why", async (ctx) => {
    const requested = ctx.match?.trim();
    const record = requested ? await db.decisionByIdPrefix(requested) : undefined;
    const latest = agent.lastDecision;
    const decision = record?.decision ?? latest?.decision ?? (await db.latestDecision())?.decision;
    if (!decision) return ctx.reply("Nessuna decisione registrata.");
    const outcome = record?.outcome ? `\nEsito reale: ${JSON.stringify(record.outcome).slice(0, 1_500)}` : "";
    return ctx.reply(`${record ? `Decisione ${record.id}\nStato: ${record.status}\n` : ""}Decisione: ${decision.action}\nMotivo: ${decision.rationale}\nConfidenza: ${(decision.confidence * 100).toFixed(0)}%\nProfitto netto stimato: $${decision.expectedNetProfitUsd.toFixed(4)}\nRischio: $${decision.riskUsd.toFixed(4)}\nRicerca richiesta: ${decision.needsResearch.length ? decision.needsResearch.join("; ") : "nessuna"}${outcome}\nFonti:\n${decision.evidence.join("\n")}`);
  });
  bot.command("strategies", async (ctx) => {
    const portfolio = agent.lastDecision?.portfolio ?? await db.latestPortfolio();
    if (!portfolio) return ctx.reply("Sto ancora raccogliendo il primo stato mainnet.");
    const report = strategies.report(portfolio, research.latest);
    return ctx.reply(report.sleeves.map((sleeve) => `${sleeve.id}: $${sleeve.capitalUsd.toFixed(4)} — ${sleeve.status}\n${sleeve.reason}`).join("\n\n"));
  });
  bot.command("transactions", async (ctx) => {
    const txs = await db.recentExecutions();
    return ctx.reply(txs.length ? txs.map((tx) => `${tx.status}: ${tx.txHash}\nTarget: ${tx.target}\n${tx.submittedAt}`).join("\n\n") : "Nessuna transazione inviata dal bot.");
  });
  bot.command("pnl", async (ctx) => {
    const [portfolio, day, all, llmDay, llmAll] = await Promise.all([
      agent.lastDecision?.portfolio ?? db.latestPortfolio(), db.ledgerSummary(24), db.ledgerSummary(), db.miniMaxUsageSummary(24), db.miniMaxUsageSummary()
    ]);
    const nav = portfolio ? `$${portfolio.estimatedNavUsd.toFixed(4)}` : "in attesa";
    return ctx.reply(`NAV stimato: ${nav}\nLedger netto 24h: $${day.netUsd.toFixed(4)}\nGas 24h: $${day.gasUsd.toFixed(4)}\nLedger netto totale: $${all.netUsd.toFixed(4)}\nGas totale: $${all.gasUsd.toFixed(4)}\nMiniMax 24h: ${llmDay.requests} richieste, ${llmDay.promptTokens + llmDay.completionTokens} token\nMiniMax totale: ${llmAll.requests} richieste, ${llmAll.promptTokens + llmAll.completionTokens} token\nIl piano MiniMax non è contabilizzato come costo per richiesta.`);
  });
  bot.on("message:text", async (ctx) => ctx.reply("Comandi read-only: /status, /pnl, /why [id], /strategies, /transactions. I messaggi Telegram non possono modificare strategie o inviare transazioni."));
  void bot.start({ onStart: () => logger.info("Telegram audit channel started") });
  return bot;
}
