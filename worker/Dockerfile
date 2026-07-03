# Cloudflare Sandbox runtime base (SDK controls the entrypoint).
# Tag MUST match the installed @cloudflare/sandbox npm version (0.12.3).
FROM docker.io/cloudflare/sandbox:0.12.3

# Claude Code CLI — the capability/reasoning agent (subscription-authed at runtime).
RUN npm install -g @anthropic-ai/claude-code

# swamp CLI — deterministic structure: workflows, versioned artifacts, approvals.
# RUN commands in this base image execute as root, so the installer's own
# root-install default (/usr/local/bin, already on PATH) is used directly —
# no separate `install` step into /root/.local/bin is needed.
RUN curl -fsSL https://swamp-club.com/install.sh | sh

# The container runs as root, and Claude Code refuses --dangerously-skip-permissions
# under root unless it knows it's sandboxed. IS_SANDBOX=1 tells Claude Code it is
# running in an isolated sandbox, which is exactly true here (Cloudflare Sandbox
# container), so the headless flag is honored and tool use is allowed. Verified:
# without this, claude exits non-zero with no output on any tool-using task.
ENV IS_SANDBOX=1

# Seed the swamp repo scaffold.
COPY brain-repo/ /brain/
WORKDIR /brain
