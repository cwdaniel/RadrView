# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in RadrView, please report it responsibly.

**Do not open a public issue.** Instead, email **security@radrview.com** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

You will receive a response within 48 hours. We will work with you to understand and address the issue before any public disclosure.

## Scope

RadrView is a self-hosted application. Security concerns include:

- Server-side vulnerabilities (Express, WebSocket, tile rendering)
- Data injection via tile parameters or API queries
- Docker container escape or privilege escalation
- Dependency vulnerabilities

## Out of Scope

- The upstream data sources (NOAA, Environment Canada, DWD) are not controlled by this project
- Denial of service via excessive tile requests (rate limiting is the deployer's responsibility)
