# Claude Code and Codex

Run Claude Code or Codex on your vAPI Compute allowance. Router and Compute are described in [router.md](./router.md).

These commands are available since 0.12.0.

Set up a vAPI account with the quickstart above. Install Claude Code or Codex and make its executable available on PATH. Configure
vAPI for the tools it finds:

```bash
vapi code install
```

The installer reuses your account link and Router key, or starts login and creates
a key when needed. The key stays in the existing OS secret store. Codex gets a
`vapi` model provider and profile in `~/.codex/config.toml`, or
`$CODEX_HOME/config.toml` when `CODEX_HOME` is set. Claude Code needs no config file
change. Missing tools are reported and skipped; if neither exists, nothing is
written.

Interactive terminals ask once before adding shell aliases. To accept without a prompt:

```bash
vapi code install --yes
```

Aliases cover only tools found on PATH. The installer replaces its marked block
in `~/.zshrc` or `~/.bashrc`; Windows skips aliases. Open a new terminal after
adding them. To keep your shell configuration as it is:

```bash
vapi code install --no-alias
```

Start either tool in your project directory:

```bash
vapi claude
vapi codex
```

At launch, vAPI chooses the Router when at least $0.50 of today's Compute remains.
Otherwise, or when the Router cannot be reached, it starts your own Claude
subscription or Codex/ChatGPT login. You must already be signed in to that tool.
The choice happens at launch. There is no local proxy or automatic mid-session
switch.

Claude Code defaults to `venice/claude-sonnet-5-5`. The installer sets Codex's
profile model to `venice/openai-gpt-61-sol`. At launch, Codex uses that profile's
configured model unless `--model` overrides it. Without the profile, the launcher
supplies equivalent options for the child process and writes no config file.

| Flag            | Behavior                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--own`         | Uses the tool's own login with your existing environment, without checking the Router.                              |
| `--vapi`        | Forces the Router route, even below $0.50. Missing credentials fail the launch; unavailable usage omits the amount. |
| `--use-balance` | Counts purchased Router balance for launch selection; uses it for the session when Compute is below $0.50.          |
| `--model`       | Selects a model. Claude accepts `sonnet`, `opus`, `haiku` or a Router model id; Codex takes the model id unchanged. |
| `--account`     | Selects the vAPI account whose Router credentials and allowance to use.                                             |

```bash
vapi claude --own
vapi codex --vapi
vapi claude --use-balance --model opus
vapi codex --model venice/openai-gpt-61-sol --account main
```

Other arguments keep their order. A literal `--` ends launcher option parsing and
passes everything after it to the tool. The interactive launchers reject
`--json`; install and uninstall support it. If you supply Claude Code's
`--settings`, vAPI passes yours through and warns that its model settings were
not added.

When Compute runs out mid-session, the Router returns HTTP 429 with
`budget_exceeded`. Exit Claude Code:

```text
/exit
```

Then resume the conversation through the launch check:

```bash
vapi claude --continue
```

For Codex, quit the session:

```text
/quit
```

Then resume its last conversation:

```bash
vapi codex resume --last
```

The launchers change model endpoint and selection. Project files, `CLAUDE.md`,
skills and MCP servers stay as configured. Claude requests on vAPI Compute go
through Venice. Claude rows on Venice are anonymized, not private.

Remove the installed provider, profile and marked alias blocks:

```bash
vapi code uninstall
```

Uninstall preserves other config content, including MCP entries. It retains
your account link and Router key.
