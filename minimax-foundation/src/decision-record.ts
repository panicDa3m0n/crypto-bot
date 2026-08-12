import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CycleRecord } from "./cycle-store.js";

export const decisionActions = ["ENTER", "RESIZE", "HARVEST", "EXIT", "HOLD", "RESEARCH_MORE"] as const;
export type DecisionAction = typeof decisionActions[number];
type Validation = { state: "accepted" | "rejected"; reasons: string[] };
export type DecisionRecord = {
  schemaVersion: 1; id: string; createdAt: string; cycleId: string; model: string; promptSha256: string;
  action?: DecisionAction; strategy?: string; reasoning?: string; evidenceIds?: string[]; confidence?: number; proposedCapital?: { asset: string; amountRaw: string };
  financial: { estimatedNetProfit?: { asset: string; amountRaw: string }; risk?: string; sources: string[] };
  execution: { capability: "read-only"; status: "not-submitted"; calldata: null; transactionHash: null };
  validation: Validation; rawModelDecision: unknown;
};

export class DecisionStore {
  constructor(private readonly dataDirectory: string) {}
  async record(cycle: CycleRecord, semantic: { usdAttestationUnavailable?: boolean; positionCoverageIncomplete?: boolean } = {}): Promise<DecisionRecord> {
    const record = fromCycle(cycle, semantic);
    await atomicJson(this.path(record.id), record);
    await atomicJson(this.byCyclePath(cycle.id), record);
    return record;
  }
  async byCycle(cycleId: string): Promise<DecisionRecord | undefined> { try { return JSON.parse(await readFile(this.byCyclePath(cycleId), "utf8")) as DecisionRecord; } catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; } }
  private path(id: string) { return join(this.dataDirectory, "decision-records", "records", `${id}.json`); }
  private byCyclePath(cycleId: string) { return join(this.dataDirectory, "decision-records", "by-cycle", `${cycleId}.json`); }
}

/** Exact schema gate. A model answer can be persisted, but cannot be mistaken for an approved financial decision. */
export function fromCycle(cycle: CycleRecord, semantic: { usdAttestationUnavailable?: boolean; positionCoverageIncomplete?: boolean } = {}): DecisionRecord {
  const raw = objectValue(cycle.parsedFinalResponse)?.decision;
  const candidate = objectValue(raw);
  const reasons: string[] = [];
  const action = typeof candidate?.action === "string" && decisionActions.includes(candidate.action as DecisionAction) ? candidate.action as DecisionAction : undefined;
  const strategy = nonEmpty(candidate?.strategy); const reasoning = nonEmpty(candidate?.reasoning);
  const confidence = typeof candidate?.confidence === "number" && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : undefined;
  const evidenceIds = Array.isArray(candidate?.evidenceIds) && candidate.evidenceIds.every((item) => typeof item === "string" && validEvidenceReference(item)) ? candidate.evidenceIds as string[] : undefined;
  const capital = capitalValue(candidate?.proposedCapital);
  const financial = financialValue(candidate?.financial);
  if (!action) reasons.push("decision.action must be one of ENTER, RESIZE, HARVEST, EXIT, HOLD, RESEARCH_MORE");
  if (!strategy) reasons.push("decision.strategy must be a non-empty string");
  if (!reasoning) reasons.push("decision.reasoning must be a non-empty string");
  if (confidence === undefined) reasons.push("decision.confidence must be a number from 0 to 1");
  if (!evidenceIds?.length) reasons.push("decision.evidenceIds must contain one or more known-format persistent record IDs or HTTPS source URLs");
  if (action && ["ENTER", "RESIZE", "HARVEST", "EXIT"].includes(action) && !capital) reasons.push(`${action} requires decision.proposedCapital with asset and positive integer amountRaw`);
  if (action && ["ENTER", "RESIZE", "HARVEST", "EXIT"].includes(action) && !financial.risk) reasons.push(`${action} requires decision.financial.risk`);
  if (semantic.usdAttestationUnavailable && claimsUsdAttestation(cycle.finalResponse ?? "")) reasons.push("model claims an USD/USDC.e attestation absent from the supplied valuation evidence");
  if (semantic.positionCoverageIncomplete && claimsGlobalNoPositions(cycle.finalResponse ?? "")) reasons.push("model claims global absence of positions despite incomplete position coverage");
  return {
    schemaVersion: 1, id: `decision_${randomUUID()}`, createdAt: new Date().toISOString(), cycleId: cycle.id, model: cycle.model, promptSha256: cycle.promptSha256,
    ...(action ? { action } : {}), ...(strategy ? { strategy } : {}), ...(reasoning ? { reasoning } : {}), ...(evidenceIds ? { evidenceIds } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(capital ? { proposedCapital: capital } : {}),
    financial, execution: { capability: "read-only", status: "not-submitted", calldata: null, transactionHash: null }, validation: { state: reasons.length ? "rejected" : "accepted", reasons }, rawModelDecision: raw ?? null
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function capitalValue(value: unknown): { asset: string; amountRaw: string } | undefined { const item = objectValue(value); const asset = nonEmpty(item?.asset); const amountRaw = typeof item?.amountRaw === "string" && /^[1-9][0-9]*$/.test(item.amountRaw) ? item.amountRaw : undefined; return asset && amountRaw ? { asset, amountRaw } : undefined; }
function financialValue(value: unknown): DecisionRecord["financial"] {
  const item = objectValue(value); const net = objectValue(item?.estimatedNetProfit); const asset = nonEmpty(net?.asset); const amountRaw = typeof net?.amountRaw === "string" && /^[0-9]+$/.test(net.amountRaw) ? net.amountRaw : undefined;
  const sources = Array.isArray(item?.sources) ? item.sources.filter((source): source is string => typeof source === "string" && source.length > 0) : [];
  return { ...(asset && amountRaw ? { estimatedNetProfit: { asset, amountRaw } } : {}), ...(nonEmpty(item?.risk) ? { risk: nonEmpty(item?.risk) } : {}), sources };
}
function validEvidenceReference(value: string): boolean {
  if (/^https:\/\/[a-z0-9.-]+(?:\/|$)/i.test(value)) return true;
  return /^(?:cycle|registry|portfolio|bend|dolomite|bex|bex_quote|kodiak|valuation|decision)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function claimsUsdAttestation(value: string): boolean { return /(?:USDC\.e|USD|valuation)\s+(?:is|are|è|sono)\s+(?:an?\s+)?attested\b/i.test(value); }
function claimsGlobalNoPositions(value: string): boolean { return /\b(?:zero|no|nessuna|nessun)\s+positions?\s+(?:across|in)\s+(?:all|tutti|tutte)\b/i.test(value); }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }
