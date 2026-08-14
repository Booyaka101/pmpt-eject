# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/pmpt-eject/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Pulls your own prompts out of a dashboard and writes them to disk. Prompt text passes through it and is not sent anywhere else.

- **Prompt content passes through it** on the way to your disk. It is not sent anywhere else and not logged.
- **Ejected prompts land in plain files.** If they contain anything sensitive, treat the output directory accordingly.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
