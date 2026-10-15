# WARDEN

An on-chain risk-screening oracle for Solana wallets and transactions. Any
dApp, exchange, or protocol can query a wallet's on-chain risk attestation
(a score plus a small set of flags) to decide whether to allow, flag for
review, or block an interaction - like a credit-bureau lookup, but fully
on-chain, open, and backed by heuristics computed from real transaction
history pulled live from Solana RPC.

Live browser verifier (no install, runs the same heuristics client-side against live devnet RPC): **https://tymofii-thc.github.io/warden/**

> **Disclaimer.** This is a hackathon-grade heuristic engine demonstrating
> the architecture end-to-end. It is **not** a licensed AML/compliance
> product and must not be used to make real regulatory or legal decisions
> without a licensed data provider (e.g. a real OFAC SDN feed, or a
> commercial provider such as Chainalysis/TRM). The "flagged program"
> sample list shipped in `offchain/scorer/sampleFlaggedPrograms.ts` is
> illustrative placeholder data - freshly generated keypairs, not a real
> intelligence feed - and is loudly labeled as such in the code.

## Architecture

```
                 ┌─────────────────────────┐
  Solana RPC --->│  offchain/scorer         │
  (real tx       │  heuristics.ts           │
  history)       │  scoreEngine.ts          │---submit_attestation--->┐
                 └─────────────────────────┘                          │
                                                                        v
                 ┌─────────────────────────┐                ┌───────────────────┐
                 │  sdk/ (TypeScript)       │<---query-------│  programs/warden   │
                 │  screenWallet()          │                │  (Anchor, Rust)    │
                 │  subscribeToAttestations │                │  RiskAttestation   │
                 └─────────────────────────┘                │  Registry PDA      │
                           ^                                 └───────────────────┘
                           │
                 ┌─────────────────────────┐
                 │  demo/ (blessed TUI)     │
                 │  live screening floor    │
                 └─────────────────────────┘
```

- **`programs/warden`** - the Anchor program. Stores a `RiskAttestation` PDA
  per wallet (`score`, `flags`, `last_updated_slot`) and a `Registry` PDA
  holding the current scoring `authority` and an `admin` who can rotate it.
  The program only stores and authorizes data; it never computes a score
  itself.
- **`offchain/scorer`** - real heuristics (wallet age, transaction velocity,
  counterparty fanout, flagged-program interaction) computed from live RPC
  data, combined into a weighted score, then submitted on-chain.
- **`sdk`** - a small TypeScript client: `screenWallet()` to read a wallet's
  current attestation and the ALLOW/REVIEW/BLOCK decision it implies, and
  `subscribeToAttestations()` to stream new attestations as they're
  submitted. No generated IDL dependency - account/event layouts are decoded
  directly against Anchor's discriminator scheme.
- **`demo`** - a console-only, animated terminal dashboard (no GUI) showing
  wallets being screened and decisions ticking in live, in the same
  cyberpunk-console style as a prior project of ours.

## Research basis

This project targets Colosseum's `institutional-rails` category
("Compliance & institutional infrastructure"). A search across the
Colosseum Copilot evidence corpus (8,286 submissions across five
hackathons) found 38 submissions in this category and **zero prize
winners** - a real, repeatedly-attempted problem that nobody has shipped a
complete, working result for. At least six independent teams tried an
on-chain compliance/risk-screening angle and all stalled before a finished,
demoable product:

- **LexNode** - a "conceptual compliance oracle" with no live on-chain
  integration; the submitted repo turned out to contain an unrelated
  financial-literacy prototype.
- **Aegis Protocol** - a real on-chain blacklist/escrow design, but scoped
  to compliance-escrow for deposits rather than general wallet screening.
- **Adher.ai** - described as "currently in the scoping phase" for a bank
  pilot; no working product shown.
- **Project Shadow** - a genuine rule-based heuristic screener, the closest
  prior attempt to this project, but narrower (sanctions/mixing/wallet-age
  heuristics only, no on-chain attestation storage for other programs to
  query).
- **Trustline** - an ambitious vault/compliance standard, but without a
  demonstrated live product interface for several of its claimed features.
- **FRACKS** - compliance infrastructure scoped specifically to RWA
  tokenization in one regional market, not general-purpose wallet
  screening.

WARDEN's bet is narrow: not a new idea, but a *complete* one - a real
Anchor program, real RPC-driven heuristics (not mocked), a working SDK, and
a live demo, where six prior attempts left the idea at the concept or
mockup stage.

## Decision thresholds

| risk_score range | decision |
|---|---|
| 0 - 299 | ALLOW |
| 300 - 699 | REVIEW |
| 700 - 1000 | BLOCK |

Defined once in `programs/warden/src/lib.rs` (as documentation - the
program itself doesn't branch on it) and mirrored in `sdk/src/decision.ts`.
A wallet with no attestation yet is `UNSCORED`, which callers must treat as
unknown - never as implicitly safe.

## Setup

### On-chain program

Requires the Rust toolchain and the Solana CLI (which provides
`cargo build-sbf`):

```bash
cargo build-sbf --manifest-path programs/warden/Cargo.toml
# -> target/deploy/warden.so, target/deploy/warden-keypair.json
```

To deploy to devnet:

```bash
solana config set --url devnet
solana program deploy target/deploy/warden.so --program-id target/deploy/warden-keypair.json
```

(Note: `target/deploy/warden-keypair.json` is the program's *upgrade
authority* keypair, not a user secret, but it is still gitignored - it is
never committed.)

### TypeScript side

```bash
npm install
npm run typecheck
npm test            # spawns solana-test-validator, deploys the program, runs the Anchor test suite
```

### Scoring a wallet and submitting an attestation (devnet)

```bash
npm run screen -- <walletAddress>
```

On first run this generates a local oracle-authority keypair at
`~/.warden/authority.json` (mode `0600`, never printed), initializes the
on-chain registry if needed, computes a real score from devnet transaction
history, and submits the attestation.

### Live demo UI

```bash
npm run demo    # --demo: cycles a small fixed set of real devnet addresses every 4s
npm run live     # live: subscribes to live devnet transaction logs and screens addresses as they appear
```

Both modes call the exact same scoring code path in `offchain/scorer` -
`--demo` only changes where the wallet addresses to screen come from
(a repeatable preset list vs. live network traffic), never the scoring
logic itself.

## Known limitations

- `getWalletAge` caps its backward scan at 1,000 signatures; a very old,
  very active wallet's true age may be understated if its earliest activity
  falls outside that window (`cappedOut: true` in the result signals this).
- The flagged-program list is illustrative demo data, not a real
  intelligence feed (see disclaimer above).
- `connection.onLogs("all", ...)` in live demo mode is intentionally
  throttled to one wallet screened every 4 seconds to stay within public
  devnet RPC rate limits; it is not meant to screen 100% of network traffic.
