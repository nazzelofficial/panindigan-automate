# Security Policy

## Supported Versions

Only the latest release receives active security fixes and dependency updates. When a new minor or patch release is published, earlier versions are deprecated.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

---

## Reporting a Vulnerability

We take the security of this project and the safety of user sessions seriously. If you discover a vulnerability, please disclose it responsibly.

**Do not open a public GitHub issue, discussion, or pull request for security vulnerabilities.**

Instead, please report it through one of the following channels:

1. **GitHub Private Vulnerability Reporting**: Use the **"Report a vulnerability"** button under the repository's [Security](../../security) tab (recommended).
2. **Direct Maintainer Contact**: If GitHub advisories are unavailable, email the maintainers directly at `security@panindigan.com` (or open an issue requesting a private security contact channel without details).

### What to Include in Your Report

To help us triage and patch the issue quickly, please provide:

- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- The specific versions of `panindigan-automate`, Node.js, and OS where the issue was observed.
- Any known mitigations or workarounds.

### Our Response Process

1. **Acknowledgment**: We aim to acknowledge receipt of your report within **48 hours**.
2. **Investigation & Triage**: We will confirm the issue, assess severity, and keep you informed of our progress.
3. **Patch & Release**: A fix will be developed in a private branch, verified against our test suite, and published in a patch release.
4. **Credit**: We will credit you in the release notes and advisory (unless you request anonymity).

---

## Scope & Threat Model

`panindigan-automate` operates over personal session tokens and raw network sockets. The following guidelines define what constitutes a reportable vulnerability:

### In Scope
- **Credential & Token Leakage**: Cookies (`c_user`, `xs`, `datr`), session state, or `fb_dtsg` tokens leaking through exception messages, default log outputs, or error stack traces.
- **Tunneling & Transport Flaws**: Bypassing configured SOCKS5 / HTTP proxies, TLS certificate validation bypasses, or socket data corruption during handshakes.
- **Remote Code Execution / Injection**: Prototype pollution, unsafe deserialization, or command injection via malformed network payloads.
- **Denial of Service (DoS)**: Malformed MQTT/GraphQL packets from external peers causing uncaught panics or memory leaks in long-running processes.

### Out of Scope
- **Account Actions by Facebook**: Account checkpoints, temporary blocks, rate limits, or bans resulting from high-frequency messaging, spam, or Facebook policy violations.
- **Compromised Host Environment**: Vulnerabilities requiring root/physical access to the machine where the process is running or where session files are stored unencrypted.
- **Third-Party Upstream Outages**: Facebook backend downtime, schema rotations, or endpoint deprecations that break connectivity without a library flaw.

---

## Built-In Security Practices

This codebase enforces several baseline defenses:

- **Strict Input Validation**: External data from network payloads is validated through runtime schemas (Zod) and safe type-casting before reaching caller code.
- **No `eval` or Dynamic Code Generation**: All forms, queries, and task packets are pure JSON and URL-encoded structures.
- **Credential Hygiene**: The client never logs full cookie strings or secret tokens by default, even in debug modes.
- **Zero Telemetry**: No telemetry, analytics, tracking pings, or external callback webhooks are embedded in the library.
