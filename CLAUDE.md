# Winamax SRE/DevOps Interview Prep

## Who we are and what we are doing

**Candidate:** Farouq  
**Target role:** SRE / DevOps Engineer at Winamax (Paris)  
**Interview format:** Technical interview + practical mock test  
**Current date context:** April 2026

## Farouq's baseline

| Area | Level |
|------|-------|
| Kubernetes (ops) | Strong — production-grade, this is the core strength |
| AWS | 4/10 — test environments only, no production experience |
| Terraform | Never used in production |
| Kafka | Conceptual understanding, shallow operational knowledge |
| Observability (OTel, Prometheus, Grafana) | Moderate — needs depth on distributed tracing |
| Linux / scripting | Solid |

## The core narrative to build

> "I am a production platform engineer who has solved HA, container orchestration, CI/CD, observability, automation, and incident response in real systems. The control plane changes from Kubernetes to ECS — the principles do not."

Never frame yourself as "a Kubernetes person trying to learn AWS." Frame yourself as an engineer who solves distributed systems problems, currently translating that expertise into AWS-native tooling.

## What Winamax cares about (signal from JD + public talks)

1. **AWS-native runtime** — ECS, EC2, Lambda (not Kubernetes)
2. **Observability at scale** — OTel, Jaeger, Quickwit, Prometheus, Grafana (Devoxx 2026 talk)
3. **Kafka operations** — 75,000 msg/sec, operational depth expected
4. **Terraform in CI/CD** — drift management is a named example project
5. **Database access governance** — automated access mgmt is a named example project
6. **High-traffic resilience** — 900k bets/day, 700+ microservices, event-driven spikes
7. **Developer enablement** — self-service platform, SRE culture, not just keeping servers up

## Teaching approach

- Each module has a file that groups: concept small explination with a reference to it file.md → why Winamax cares → hands-on exercise → interview Q&A 
- Each concept needs to be in a seperate file that explains it well 
- Always connect back to Farouq's K8s background as a bridge
- Prioritize depth over breadth — they will probe operational knowledge
- Language: English (lessons), code/configs in English

## The course lives here

- each module has it own folder 
- `course/` — all modules in priority order 
- `exercises/` — hands-on labs and scenarios  
- `interview/` — story angles, mock questions, answer frameworks

## Key Winamax numbers to internalize

- 75,000 messages/second on Kafka
- 900,000+ sports bet slips/day
- 250,000+ poker tournaments/day
- 700+ microservices
- 50 TB of database data
- Thousands of service instances in parallel
