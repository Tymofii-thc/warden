export type Decision = "ALLOW" | "REVIEW" | "BLOCK" | "UNSCORED";

export interface RiskAttestationAccount {
  wallet: string;
  riskScore: number;
  flags: number;
  lastUpdatedSlot: bigint;
  updatedBy: string;
  bump: number;
}

export interface RegistryAccount {
  admin: string;
  authority: string;
  bump: number;
}

export interface ScreeningResult {
  wallet: string;
  attested: boolean;
  score: number | null;
  decision: Decision;
  flags: string[];
  lastUpdatedSlot: bigint | null;
}

export interface AttestationEvent {
  wallet: string;
  riskScore: number;
  flags: number;
  slot: bigint;
}
