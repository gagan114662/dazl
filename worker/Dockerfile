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

# Seed the swamp repo scaffold.
COPY brain-repo/ /brain/
WORKDIR /brain
