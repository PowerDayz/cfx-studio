# Security Policy

## Reporting a vulnerability

Please do **not** report security vulnerabilities through public GitHub
issues, pull requests, or discussions.

Instead, use GitHub's private vulnerability reporting: open the
[Security tab](https://github.com/PowerDayz/cfx-studio/security) of this
repository and click **"Report a vulnerability"**. This creates a
private advisory visible only to the maintainers.

Please include as much of the following as you can:

- The type of issue and the component affected.
- Steps to reproduce, or a proof-of-concept.
- The version / commit of Cfx Studio you tested.
- The impact — how an attacker could exploit it.

Expect an initial response within a few days. Once a fix is ready the
advisory is published, and you will be credited unless you ask
otherwise.

## Scope

Cfx Studio is a fork of [Visual Studio Code](https://github.com/microsoft/vscode).
This policy covers the Cfx-specific code (`src/vs/workbench/contrib/cfx/`,
`cfx-mcp/`, `cfx-scripts/`) and Cfx Studio's build and configuration.
Vulnerabilities in unmodified upstream VS Code code should also be
reported to the [VS Code project](https://github.com/microsoft/vscode/blob/main/SECURITY.md).
