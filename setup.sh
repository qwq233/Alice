#!/usr/bin/env bash
# Alice Setup — One-click deployment helper
# Usage: bash setup.sh
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${CYAN}[Alice]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
die()     { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        Project Alice — Setup          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 0. Check we're in the right place ──────────────────────────────────────
[[ -f "runtime/package.json" ]] || die "Run this script from the project root (where runtime/ is)."

# ── 1. Check dependencies ───────────────────────────────────────────────────
info "Checking dependencies..."

check_cmd() {
  if command -v "$1" &>/dev/null; then
    success "$1 found ($(${1} --version 2>&1 | head -1))"
  else
    die "$1 not found. Install it first: $2"
  fi
}

check_cmd node  "https://nodejs.org/"
check_cmd pnpm  "npm install -g pnpm"
check_cmd pm2   "npm install -g pm2"

# Node version check
NODE_VER=$(node -e "process.exit(parseInt(process.versions.node) < 20 ? 1 : 0)" 2>&1 || true)
node -e "if(parseInt(process.versions.node)<20){process.exit(1)}" || die "Node.js 20+ required. Current: $(node --version)"

# ── 2. Install runtime dependencies ────────────────────────────────────────
info "Installing runtime dependencies..."
(cd runtime && pnpm install --frozen-lockfile)
success "Dependencies installed."

# ── 3. Configure .env ───────────────────────────────────────────────────────
if [[ -f "runtime/.env" ]]; then
  warn ".env already exists — skipping configuration."
  warn "To reconfigure, delete runtime/.env and run this script again."
else
  info "Setting up configuration..."
  cp runtime/.env.example runtime/.env

  echo ""
  echo -e "${YELLOW}Required configuration (press Enter to keep default):${NC}"
  echo ""

  # Telegram API credentials
  echo -e "  Get your API credentials at ${CYAN}https://my.telegram.org/apps${NC}"
  read -rp "  TELEGRAM_API_ID: " api_id
  read -rp "  TELEGRAM_API_HASH: " api_hash
  read -rp "  TELEGRAM_PHONE (e.g. +8613800138000): " phone

  # LLM
  echo ""
  echo -e "  LLM endpoint — OhMyGPT recommended: ${CYAN}https://www.ohmygpt.com${NC}"
  read -rp "  LLM_BASE_URL [https://api.ohmygpt.com/v1]: " llm_url
  read -rp "  LLM_API_KEY: " llm_key
  read -rp "  LLM_MODEL [gemini-2.5-flash-preview-05-20]: " llm_model

  llm_url="${llm_url:-https://api.ohmygpt.com/v1}"
  llm_model="${llm_model:-gemini-2.5-flash-preview-05-20}"

  # Write values
  sed -i \
    -e "s|^TELEGRAM_API_ID=.*|TELEGRAM_API_ID=${api_id}|" \
    -e "s|^TELEGRAM_API_HASH=.*|TELEGRAM_API_HASH=${api_hash}|" \
    -e "s|^TELEGRAM_PHONE=.*|TELEGRAM_PHONE=${phone}|" \
    -e "s|^LLM_BASE_URL=.*|LLM_BASE_URL=${llm_url}|" \
    -e "s|^LLM_API_KEY=.*|LLM_API_KEY=${llm_key}|" \
    -e "s|^LLM_MODEL=.*|LLM_MODEL=${llm_model}|" \
    runtime/.env

  success ".env written."
fi

# ── 4. Check .env is filled ─────────────────────────────────────────────────
source_val() { grep "^${1}=" runtime/.env | cut -d= -f2-; }
[[ -n "$(source_val TELEGRAM_API_ID)"   ]] || die "TELEGRAM_API_ID is empty in runtime/.env"
[[ -n "$(source_val TELEGRAM_API_HASH)" ]] || die "TELEGRAM_API_HASH is empty in runtime/.env"
[[ -n "$(source_val TELEGRAM_PHONE)"    ]] || die "TELEGRAM_PHONE is empty in runtime/.env"
[[ -n "$(source_val LLM_API_KEY)"       ]] || die "LLM_API_KEY is empty in runtime/.env"

# ── 5. First run vs pm2 ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Configuration looks good!${NC}"
echo ""

SESSION_FILE="runtime/alice.session"
if [[ ! -f "$SESSION_FILE" ]]; then
  echo -e "${YELLOW}First run — Alice needs to log in to Telegram interactively.${NC}"
  echo -e "She will send a verification code to your Telegram app."
  echo ""
  read -rp "Press Enter to start the interactive login..."
  echo ""
  info "Starting Alice for first login (Ctrl+C after login completes)..."
  (cd runtime && pnpm run dev)
else
  success "Session file found — skipping interactive login."
  echo ""
  info "Starting Alice with pm2..."
  pm2 start ecosystem.config.cjs --only alice-runtime
  pm2 status
  echo ""
  success "Alice is running!"
  echo ""
  echo -e "  ${CYAN}pm2 logs alice-runtime${NC}   — view logs"
  echo -e "  ${CYAN}pm2 stop alice-runtime${NC}    — stop"
  echo -e "  ${CYAN}pm2 restart alice-runtime${NC} — restart after changes"
  echo ""
  echo -e "  Full guide: ${CYAN}docs/deployment.md${NC}"
fi
