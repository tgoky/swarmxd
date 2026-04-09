# 🎼 Swarm Conductor — Autonomous Multi-Agent DeFi Orchestra

> A living, collaborative AI swarm that acts like a decentralized hedge fund on Solana.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SWARM CONDUCTOR                          │
│                                                                 │
│  ┌────────────┐   Signal Bus (Redis Pub/Sub + Streams)         │
│  │  Conductor │◄──────────────────────────────────────────┐    │
│  │  (Orch.)   │                                           │    │
│  └─────┬──────┘                                           │    │
│        │ Broadcasts signals                               │    │
│        ▼                                                  │    │
│  ┌─────────────────────────────────────────┐              │    │
│  │          Agent Swarm (parallel)         │              │    │
│  │  ┌──────────┐  ┌──────────┐            │              │    │
│  │  │Researcher│  │  Risk    │            │   Votes/     │    │
│  │  │  Agent   │  │Assessor  │────────────┼──►Proposals  │    │
│  │  └──────────┘  └──────────┘            │              │    │
│  │  ┌──────────┐  ┌──────────┐            │              │    │
│  │  │ Executor │  │Rebalancer│            │              │    │
│  │  │  Agent   │  │  Agent   │            │              │    │
│  │  └──────────┘  └──────────┘            │              │    │
│  └─────────────────────────────────────────┘              │    │
│        │ Consensus → Execute                               │    │
│        ▼                                                  │    │
│  ┌──────────────────────────────────────────────────────┐ │    │
│  │                  Solana Blockchain                   │─┘    │
│  │  Jupiter (swaps) · Raydium · Orca · Meteora · Kamino │      │
│  │  Swarm Memory PDAs (immutable decision log)          │      │
│  └──────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
On-Chain Signal → Conductor Detects → Broadcasts to All Agents
       ↓
Agents Analyze in Parallel (Claude AI reasoning)
       ↓
Proposals Published to Bus
       ↓
All Agents Vote (weighted consensus: risk-assessor = 1.5x)
       ↓
Conductor Tallies → Consensus Decision
       ↓
Risk Guard Final Check (hard stops, can't be overridden)
       ↓
Executor Simulates → Submits via Jupiter/Raydium SDKs
       ↓
On-Chain Memory PDA records decision immutably
```

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Agent OS | Custom (TypeScript) | ElizaOS is JS-heavy and opinionated — we get better type safety and control with our own BaseAgent |
| Multi-agent orchestration | Custom bus (Redis Pub/Sub) | LangChain/CrewAI add overhead for async Solana workflows — direct Redis gives sub-10ms message latency |
| AI reasoning | Anthropic Claude (`claude-opus-4-5`) | Best reasoning quality for financial analysis |
| DeFi execution | Jupiter API v6, Raydium SDK, Orca SDK | Jupiter gives best swap routing; protocol SDKs for direct LP ops |
| On-chain memory | Anchor PDAs + Solana Memo (fallback) | PDAs are cheapest for structured data; Memo for demo/devnet |
| Message bus | Redis Pub/Sub + Streams | Durable, fast, supports consumer groups for agent recovery |
| API | Express + WebSocket | Simple, fast; WS for real-time dashboard |
| Dashboard | Vanilla HTML/CSS/JS (self-contained) | Zero build step, works anywhere, demo-ready |

---

## Project Structure

```
swarm-conductor/
├── packages/
│   ├── shared/              # Types, BaseAgent, MessageBus, Logger
│   ├── conductor/           # Orchestrator, SignalDetector, RiskGuard
│   │   └── src/
│   │       ├── conductor.ts         # Main orchestrator
│   │       ├── signal-detector.ts   # On-chain + off-chain signal sources
│   │       ├── risk-guard.ts        # Hard circuit breakers
│   │       ├── portfolio-monitor.ts # Real-time position tracking
│   │       ├── on-chain-memory.ts   # PDA write logic
│   │       └── bootstrap.ts        # Process entry point
│   ├── agents/
│   │   ├── researcher/      # Market research, APY analysis, opportunity discovery
│   │   ├── risk-assessor/   # Downside modeling, smart contract risk, IL estimation
│   │   ├── executor/        # Tx building, simulation, Jupiter routing, submission
│   │   └── rebalancer/      # Portfolio drift, reward harvesting, optimization
│   └── on-chain/
│       └── programs/swarm-memory/  # Anchor program for immutable decision log
├── apps/
│   ├── api/                # Express + WebSocket API server
│   └── dashboard/          # Live command center UI
│       └── public/index.html  # Self-contained dashboard (open in browser)
└── scripts/
    └── demo.ts             # Live demo script for presentations
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm 9+
- Redis (local or [Redis Cloud](https://redis.com/try-free/))
- Solana CLI (for on-chain deployment)
- Anchor CLI 0.30+ (for program deployment)

### 1. Install

```bash
git clone <repo>
cd swarm-conductor
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — minimum required:
#   ANTHROPIC_API_KEY=...
#   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
#   REDIS_URL=redis://localhost:6379
```

### 3. Run Demo (no wallet needed)

```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start API + WebSocket server
pnpm api:start

# Terminal 3: Open dashboard
open apps/dashboard/public/index.html
# (or just open it in a browser — it auto-connects to ws://localhost:3001)

# Terminal 4: Run the demo script
pnpm demo
# Watch the swarm come alive in the dashboard!
```

### 4. Run with Real Wallet (mainnet)

```bash
# Export your hot wallet private key (NOT your main wallet!)
# Format: JSON array of bytes, e.g. [12,34,56,...]
export WALLET_PRIVATE_KEY='[12,34,...]'
export WALLET_PUBLIC_KEY='YourWalletPublicKeyBase58'

# Start the conductor + all agents
pnpm conductor:start
```

### 5. Deploy On-Chain Memory Program

```bash
cd packages/on-chain

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.30.1
avm use 0.30.1

# Build
anchor build

# Deploy to devnet
solana config set --url devnet
anchor deploy

# Copy the program ID to .env
# SWARM_MEMORY_PROGRAM_ID=<deployed program ID>
```

---

## Agent Roles & Vote Weights

| Agent | Role | Vote Weight | Disposition |
|-------|------|-------------|-------------|
| Researcher | Find opportunities | 1.0x | Optimistic — seeks upside |
| Risk Assessor | Block bad trades | **1.5x** | Pessimistic — seeks downside |
| Executor | Technical feasibility | 0.8x | Neutral — validates mechanics |
| Rebalancer | Portfolio health | 1.0x | Systematic — targets allocation |

**Consensus threshold: 75% weighted approval** to execute.

The Risk Assessor's 1.5x weight means a single strong `reject` can block a proposal even if all three other agents approve — preventing reckless trades.

---

## Risk Controls (cannot be overridden by consensus)

1. **Stop-loss** — Portfolio drawdown > configured % halts all trading
2. **Max trade size** — No single trade > X% of portfolio
3. **Slippage cap** — Transaction rejects if slippage > limit
4. **Human approval gate** — Trades above threshold require manual approval
5. **Confidence floor** — Proposals with < 55% confidence are auto-rejected
6. **Max downside cap** — Proposal rejected if max downside > 15% of portfolio
7. **Emergency exit** — Risk Assessor can propose immediate exit from any position

---

## Extending the Swarm

### Add a new agent

```typescript
import { BaseAgent, type AgentDependencies } from "@swarm/shared";

export class SentimentAgent extends BaseAgent {
  constructor(deps: AgentDependencies) {
    super("sentiment", deps);  // Add "sentiment" to AgentRole type
  }

  protected getRoleDescription() {
    return "You monitor X/Twitter for protocol sentiment shifts...";
  }

  protected async onSignal(signal: Signal) {
    // React to relevant signals
  }

  protected async registerSubscriptions() {
    // Subscribe to relevant channels
  }

  protected async onStart() {
    // Initialize Twitter API client, etc.
  }
}
```

### Add a new signal source

```typescript
// In signal-detector.ts, add to refreshPoolData():
async fetchTwitterSentiment(): Promise<void> {
  // Call Twitter API v2
  // Emit sentiment_spike signals when score changes dramatically
}
```

### Add a new protocol

```typescript
// In executor.ts, add to buildAndSubmit():
case "meteora_dlmm":
  return this.executeMeteoraDLMM(action.params);

private async executeMeteoraDLMM(params: LiquidityParams): Promise<string[]> {
  // Use @meteora-ag/dlmm SDK
}
```

---

## Production Deployment

### Docker Compose

```yaml
version: "3.9"
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  conductor:
    build: .
    command: tsx packages/conductor/src/bootstrap.ts
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - SOLANA_RPC_URL=${SOLANA_RPC_URL}
      - REDIS_URL=redis://redis:6379
      - WALLET_PRIVATE_KEY=${WALLET_PRIVATE_KEY}
    depends_on: [redis]
    restart: unless-stopped

  api:
    build: .
    command: tsx apps/api/src/index.ts
    ports: ["3001:3001"]
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on: [redis]
    restart: unless-stopped
```

### Kubernetes (production)

Run each agent as its own Deployment with:
- Individual resource limits (agents are CPU/memory bound, not each other)
- Liveness probes on heartbeat channel
- Separate secrets for wallet keys (use Vault or AWS KMS)
- HPA on API server based on WebSocket connections

---

## Security Notes

- **Never** expose `WALLET_PRIVATE_KEY` in logs, dashboards, or error messages
- Use a dedicated hot wallet with only the capital you're willing to risk
- Set `HUMAN_APPROVAL_THRESHOLD_USD` to a low value initially
- Test on devnet first with `SOLANA_NETWORK=devnet`
- The RiskGuard's hard stops cannot be bypassed — don't remove them

---

## License

MIT — build on it, fork it, ship it. Credit appreciated.
