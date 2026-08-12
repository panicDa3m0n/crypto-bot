import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

export class GateService {
  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database) {}

  async observationGate() {
    return this.db.observationGate(this.chain.primaryRpc, this.chain.secondaryRpc, this.config.OBSERVATION_GATE_HOURS, this.config.MAX_OBSERVATION_GAP_SECONDS, this.config.MIN_OBSERVATION_HEALTH_RATIO);
  }

  async bootstrapObservationGate() {
    return this.db.bootstrapObservationGate(this.chain.primaryRpc, this.chain.secondaryRpc, this.config.BOOTSTRAP_GATE_MINUTES, this.config.MAX_OBSERVATION_GAP_SECONDS, this.config.MIN_OBSERVATION_HEALTH_RATIO);
  }

  async protocolObservationGate(protocol: "reward-vault" | "bend-vault" | "bex" | "other", address: string) {
    return this.db.protocolObservationGate(protocol, address, this.config.OBSERVATION_GATE_HOURS);
  }
}
