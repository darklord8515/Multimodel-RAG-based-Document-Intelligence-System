# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues or discussions.
Contact the maintainers privately and include:

- a description of the problem and its impact;
- the affected component (for example upload handling, document parsing, the query API);
- steps to reproduce, or a proof of concept.

## Deployment notes

- The web app has **no built-in authentication**. It binds to `127.0.0.1` by default.
  Put it behind an authenticating reverse proxy before exposing it to a network.
- API keys live in `.env`, which is git-ignored. Never commit it, and rotate any key that has been shared.
- Uploaded files are stored unencrypted under `DATA_DIR` (default `./data`).
