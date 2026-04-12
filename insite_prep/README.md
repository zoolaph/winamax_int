# On-Site Interview Prep

This folder is not for reading. It is for doing.

The `course/` folder built your knowledge. This folder builds your ability to perform that knowledge under pressure, in front of two engineers who will interrupt you, go deeper, and watch how you think.

---

## What Stage 3 looks like

Two SRE/infra engineers, ~2 hours. Expect:

- **Incident war games** — they describe a broken system, you diagnose it out loud while they interrupt and probe
- **Architecture design** — blank page, 10 minutes, design something at Winamax scale
- **Hands-on exercise** — laptop, broken config or repo, find and fix it
- **Linux debugging** — "here's a terminal, the service is failing, go"
- **Deep probing** — you say X, they ask "why does that happen at the kernel level"

---

## How to use each section

### 01-incident-wargames/
Read the scenario. Stop. Talk through your diagnosis out loud — full sentences, as if presenting to the two engineers. Only then scroll to the answer.

If you cannot speak for 3 minutes straight without looking at notes, you are not ready.

### 02-architecture-design/
Set a 10-minute timer. Read the constraints. Close your notes. Draw the architecture in ASCII and write your rationale. Only look at the reference design after your timer runs out.

If your design is missing a major component, add it to your review list and redo the exercise the next day from scratch.

### 03-hands-on-labs/
These require a real environment. Do not skip them. The lab tells you what to set up. Follow it, then attempt the "break it" exercises without hints.

If you cannot complete a break-it exercise within 20 minutes, note where you got stuck — that is your gap.

### 04-linux-debugging/
Each file gives you terminal output. Write down the next command you would run and why — before reading the next step. Treat it like a real terminal session.

### 05-verbal-practice/
Read the question. Answer out loud. Time yourself. Target: under 90 seconds for the first answer, with enough left unsaid that they ask a follow-up.

---

## Priority order

Do these in order. If your interview is in less than a week, focus on 1 and 2.

1. **01-incident-wargames** — highest ROI, closest to actual Stage 3 format
2. **02-architecture-design** — blank-page exercises expose gaps that Q&A prep hides
3. **03-hands-on-labs** — cannot be faked; do at least ECS and Terraform
4. **04-linux-debugging** — fast to practice, often tested as a warm-up
5. **05-verbal-practice** — do this in parallel with everything else

---

## How to know you are ready

- You can diagnose any wargame scenario out loud in under 4 minutes without notes
- You can draw an end-to-end architecture from a blank page in 10 minutes
- You have deployed and broken a real ECS service at least once
- You can run `ss`, `tcpdump`, `strace`, and `nsenter` without looking up the flags
- Your answers are under 90 seconds and you stop before over-explaining
