# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities in public GitHub issues, discussions, or
pull requests. Public disclosure can expose users and deployments before a fix
is available.

Use GitHub's private vulnerability reporting for this repository when it is
available:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Provide a description, affected component, reproduction steps, and the
   impact you believe the issue has.

If private vulnerability reporting is not enabled for the repository, open a
minimal public issue that asks the maintainer to establish a private channel.
Do not include vulnerability details, proof-of-concept code, credentials, or
affected deployment information in that issue.

No security email address, response-time guarantee, or bug bounty is currently
published for this project. Do not assume one exists.

## What to include

A useful report includes:

- A clear description of the vulnerability and the affected endpoint,
  component, or configuration.
- The version, commit, or deployment method you tested.
- Reproduction steps or a minimal proof of concept.
- The security impact and the conditions required to exploit it.
- Any suggested remediation, if you have one.
- Whether you want to be credited in the fix.

Remove real credentials, personal data, and production identifiers from logs
and screenshots before sending them.

## In scope

Security issues in this repository include, but are not limited to:

- Authentication or authorization bypasses, including admin-route access.
- Session, JWT, CSRF, or cookie handling flaws.
- Injection vulnerabilities (SQL, command, template, prompt, or header).
- Server-side request forgery or unsafe outbound request handling.
- Exposure of secrets, credentials, tokens, or sensitive configuration.
- Insecure defaults that affect production deployments.
- Path traversal, unsafe file handling, or export injection.
- Cross-site scripting or content-security-policy bypasses.
- Privilege escalation between users or between the API and worker.
- Unsafe deserialization or unvalidated AI output that reaches a security
  boundary.
- Vulnerabilities in the Docker, Compose, or reverse-proxy configuration
  maintained by this repository.

## Out of scope

The following are generally out of scope unless they demonstrate a concrete
security impact in this repository:

- Denial-of-service reports based only on traffic volume.
- Social engineering or phishing against maintainers or users.
- Vulnerabilities in third-party AI providers, cloud services, or upstream
  dependencies that are not caused by this repository's integration. Report
  those upstream as well.
- Missing security headers on endpoints that do not serve HTML, unless the
  omission enables an attack.
- Automated scanner output without a reproducible impact.
- Issues that require a compromised host, browser extension, or administrator
  account.
- Generated story content that is offensive or inaccurate but does not cross a
  security boundary. Content-quality issues can be reported as normal bugs.

## How reports are reviewed

The maintainer will review the report, attempt to reproduce the issue, and
determine whether it is in scope. You may be asked for additional details or a
safer reproduction. Please allow time for investigation; this is a
maintainer-run project and no response-time commitment is made.

If the issue is confirmed, the maintainer will prepare a fix, add regression
coverage where practical, and coordinate disclosure. Please do not publish the
details until a fix or mitigation is available and you have agreed on a
disclosure date.

## How fixes are communicated

Security fixes are documented in the repository's release notes and
[`CHANGELOG.md`](CHANGELOG.md). When appropriate, a GitHub security advisory may
be published with affected versions, remediation guidance, and credit. Users are
responsible for applying updates and rotating any credential that may have been
exposed.

## Safe harbor

Good-faith security research that follows this policy will not be treated as a
violation of the project's terms. Do not access data that is not yours, do not
disrupt running services, and do not retain or publish personal information.
