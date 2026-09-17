# The `jupyter-collab` skill

`SKILL.md` contains instructions for the model rather than for a person: how to
work with a live notebook through `jupyter-collab-mcp` tools (session and
handle, IDs and revisions, `request_id`, `notebook_changes`, conflict handling,
the distinction between close/interrupt/restart/shutdown, the prohibition on
writing `.ipynb` directly, and launching JupyterLab externally). It conforms to
SPEC.md §10.

The skill itself does not start anything: it must be used with a configured
MCP server (see the root `README.md`).

## Claude Code

A skill is a directory containing `SKILL.md`; the file must have frontmatter
with `name` and `description`.

For the current user (across all projects):

```sh
mkdir -p ~/.claude/skills/jupyter-collab
cp skill/SKILL.md ~/.claude/skills/jupyter-collab/SKILL.md
```

For one project only, place the same file at
`<project>/.claude/skills/jupyter-collab/SKILL.md`.

From the installed npm package (the `skill` directory is included in `files`):

```sh
mkdir -p ~/.claude/skills/jupyter-collab
cp "$(npm root -g)/jupyter-collab-mcp/skill/SKILL.md" \
   ~/.claude/skills/jupyter-collab/SKILL.md
```

To verify it, start a new session and use `/skills` (or a request such as
"open the analysis.ipynb notebook and run the second cell"). The skill should
be selected based on its `description`.

## Codex

Install the skill in Codex's user skill directory:

```sh
mkdir -p ~/.codex/skills/jupyter-collab
cp skill/SKILL.md ~/.codex/skills/jupyter-collab/SKILL.md
```

Start a new Codex session after installation. Codex discovers the skill from
its YAML `name` and `description` fields. A project may also bind notebook work
to this skill explicitly in `AGENTS.md`:

```md
## Working with notebooks
Use the `jupyter-collab-mcp` skill for notebook reads, edits, and execution.
```

## Updating

The skill is versioned with the package. After updating
`jupyter-collab-mcp`, copy `SKILL.md` again: it specifies the tool names and
`request_id` semantics exactly.
