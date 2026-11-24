#!/usr/bin/env bash
# Terminus bootstrap — run from the repo:  bash scripts/bootstrap.sh [options]
#
# Makes sure everything Terminus needs is present, then installs and builds it.
# Safe to re-run: every step checks first and only changes what's missing.
#
# Options
#   --yes, -y        Don't ask; install whatever is missing (uses sudo for system packages)
#   --check          Only report what's missing; change nothing
#   --no-system      Never install system packages (just print the command to run)
#   --windows        On WSL, also install/update the native Windows app (no prompt)
#   --no-windows     On WSL, skip the native Windows app
#   --config FILE    Use FILE as ~/.terminus/config.json (existing one is backed up)
#   --skip-claude    Don't offer to install the Claude Code CLI
#   -h, --help       Show this help
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

YES=0 CHECK=0 NO_SYSTEM=0 WINDOWS=ask SKIP_CLAUDE=0 CONFIG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --check) CHECK=1 ;;
    --no-system) NO_SYSTEM=1 ;;
    --windows) WINDOWS=yes ;;
    --no-windows) WINDOWS=no ;;
    --skip-claude) SKIP_CLAUDE=1 ;;
    --config) shift; CONFIG_FILE="${1:-}" ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- output helpers
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B= G= Y= R= D= N=; fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
info() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
PROBLEMS=()
problem() { PROBLEMS+=("$*"); bad "$*"; }

INTERACTIVE=0; [ -t 0 ] && INTERACTIVE=1
ask() { # ask "question" -> 0 for yes
  [ "$CHECK" = 1 ] && return 1
  [ "$YES" = 1 ] && return 0
  [ "$INTERACTIVE" = 1 ] || return 1
  local a; read -r -p "  ? $1 [Y/n] " a </dev/tty || return 1
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" != 0 ]; then have sudo && SUDO="sudo"; fi

# ---------------------------------------------------------------- platform
step "Platform"
OS="$(uname -s)"; ARCH="$(uname -m)"; WSL=0
case "$OS" in
  Linux)
    # A WSL kernel alone isn't enough (Docker containers on WSL share it); require WSL's own markers.
    if grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && { [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -d /run/WSL ]; }; then WSL=1; fi
    . /etc/os-release 2>/dev/null || true
    ok "Linux ${PRETTY_NAME:-} ($ARCH)$([ $WSL = 1 ] && echo ", WSL distro ${WSL_DISTRO_NAME:-?}")" ;;
  Darwin) ok "macOS $(sw_vers -productVersion 2>/dev/null) ($ARCH)" ;;
  *) bad "Unsupported OS: $OS. On Windows, run Terminus from WSL (wsl --install), then run this script inside it."; exit 1 ;;
esac

PM=""
for m in apt-get dnf yum pacman zypper apk brew; do have "$m" && { PM="$m"; break; }; done
[ -n "$PM" ] && info "package manager: $PM" || warn "no known package manager found; system packages must be installed manually"

pkg_install() { # pkg_install <purpose> <packages...>
  local purpose="$1"; shift
  local cmd
  case "$PM" in
    apt-get) cmd="$SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o=Dpkg::Use-Pty=0 $* >/dev/null" ;;
    dnf|yum) cmd="$SUDO $PM install -y -q $*" ;;
    pacman) cmd="$SUDO pacman -S --needed --noconfirm $*" ;;
    zypper) cmd="$SUDO zypper --non-interactive install $*" ;;
    apk) cmd="$SUDO apk add $*" ;;
    brew) cmd="brew install $*" ;;
    *) problem "Install manually for $purpose: $*"; return 1 ;;
  esac
  if [ "$NO_SYSTEM" = 1 ] || [ "$CHECK" = 1 ]; then problem "Missing $purpose. Install with: $cmd"; return 1; fi
  if [ "$PM" != brew ] && [ "$(id -u)" != 0 ] && [ -z "$SUDO" ]; then problem "Missing $purpose and no sudo. As root run: ${cmd//sudo /}"; return 1; fi
  if ask "Install $purpose ($*)?"; then
    info "$cmd"
    if bash -c "$cmd"; then ok "installed $purpose"; return 0; fi
    problem "Installing $purpose failed. Try: $cmd"; return 1
  fi
  problem "Missing $purpose. Install with: $cmd"; return 1
}

# ---------------------------------------------------------------- base tools
step "Base tools"
need_base=()
have curl || need_base+=(curl)
have unzip || need_base+=(unzip)
have tar || need_base+=(tar)
if [ ${#need_base[@]} = 0 ]; then ok "curl, unzip, tar"; else pkg_install "base tools" "${need_base[@]}" || true; fi
info "curl is required: Claude Code hooks use it to report to Terminus"

# ---------------------------------------------------------------- Node.js
step "Node.js (needs ^20.19 or >=22.12)"
node_ok() {
  have node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' 2>/dev/null
}
load_nvm() { export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; }
if ! node_ok; then load_nvm; fi
if node_ok; then
  ok "node $(node -v), npm $(npm -v)"
else
  have node && warn "node $(node -v) is too old" || warn "node not found"
  if ask "Install Node.js 22 LTS for this user with nvm (no sudo)?"; then
    if [ ! -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash >/dev/null || problem "nvm install failed"
    fi
    load_nvm
    if have nvm && nvm install 22 >/dev/null && nvm alias default 22 >/dev/null; then
      ok "node $(node -v) via nvm (add 'source ~/.nvm/nvm.sh' to your shell rc if it isn't already)"
    else
      problem "Could not install Node via nvm. Install Node 22 LTS from https://nodejs.org and re-run."
    fi
  else
    problem "Node.js ^20.19 or >=22.12 is required (https://nodejs.org)"
  fi
fi

# ---------------------------------------------------------------- native build toolchain (node-pty)
step "Build tools (node-pty compiles a native module)"
if [ "$OS" = Darwin ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode command line tools"; else
    if ask "Install Xcode command line tools?"; then xcode-select --install || true; problem "Finish the Xcode tools installer, then re-run"; else problem "Run: xcode-select --install"; fi
  fi
else
  missing=()
  have python3 || missing+=(python3)
  have make || missing+=(make)
  { have g++ || have c++; } || missing+=(g++)
  if [ ${#missing[@]} = 0 ]; then ok "python3, make, g++"; else
    case "$PM" in
      apt-get) pkg_install "build tools" build-essential python3 ;;
      dnf|yum) pkg_install "build tools" gcc-c++ make python3 ;;
      pacman) pkg_install "build tools" base-devel python ;;
      zypper) pkg_install "build tools" gcc-c++ make python3 ;;
      apk) pkg_install "build tools" build-base python3 linux-headers ;;
      *) problem "Install a C++ compiler, make and python3" ;;
    esac
  fi
fi

# ---------------------------------------------------------------- Claude Code CLI
step "Claude Code CLI"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do [ -z "$CLAUDE_BIN" ] && [ -x "$c" ] && CLAUDE_BIN="$c"; done
if [ -n "$CLAUDE_BIN" ]; then
  ok "claude $("$CLAUDE_BIN" --version 2>/dev/null | head -1) ($CLAUDE_BIN)"
elif [ "$SKIP_CLAUDE" = 1 ]; then
  warn "claude not found (skipped). Terminus needs it to start Claude sessions."
elif ask "Claude Code isn't installed. Install it with the official installer (claude.ai/install.sh)?"; then
  if curl -fsSL https://claude.ai/install.sh | bash; then ok "Claude Code installed; run 'claude' once to sign in"; else problem "Claude Code install failed (see https://docs.claude.com/claude-code)"; fi
else
  warn "claude not found. Shell sessions work, but Claude sessions need it: curl -fsSL https://claude.ai/install.sh | bash"
fi

# ---------------------------------------------------------------- npm dependencies + build
step "Dependencies and build"
if ! node_ok; then
  problem "Skipping npm install/build until Node is fixed"
elif [ "$CHECK" = 1 ]; then
  if [ -d node_modules ] && [ -f dist/main/core/index.js ] && [ -f dist/renderer/index.html ]; then ok "node_modules and build present"; else warn "needs: npm ci && npm run build"; fi
else
  lock_hash="$(cat package-lock.json package.json 2>/dev/null | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16)"
  if [ -d node_modules ] && [ -f node_modules/.terminus-lock ] && [ "$(cat node_modules/.terminus-lock)" = "$lock_hash" ] && node -e "require('node-pty')" 2>/dev/null; then
    ok "node_modules up to date"
  else
    info "npm ci (installs exact locked versions; compiles node-pty)…"
    if npm ci --no-audit --no-fund --loglevel=error; then
      echo "$lock_hash" > node_modules/.terminus-lock; ok "dependencies installed"
    else
      problem "npm ci failed. Check the build tools above, then re-run"
    fi
  fi
  if [ -d node_modules ]; then
    info "npm run build…"
    if npm run build --silent >/tmp/terminus-build.$$ 2>&1; then ok "built"; else problem "build failed:"; tail -20 /tmp/terminus-build.$$; fi
    rm -f /tmp/terminus-build.$$
  fi
fi

# ---------------------------------------------------------------- verify the core actually runs
step "Self-test"
if [ -f dist/main/core/index.js ] && node_ok && [ "$CHECK" = 0 ]; then
  if node -e "const p=require('node-pty');const t=p.spawn('/bin/sh',['-c','echo ok'],{});t.onData(d=>{if(d.includes('ok'))process.exit(0)});setTimeout(()=>process.exit(1),5000)" 2>/dev/null; then
    ok "node-pty can spawn terminals"
  else
    problem "node-pty can't spawn terminals (native module didn't build). Re-run after fixing build tools: npm rebuild node-pty"
  fi
  tmp="$(mktemp -d)"; port=$(( 48000 + RANDOM % 1000 ))
  TERMINUS_HOME="$tmp" TERMINUS_PORT="$port" node dist/main/core/index.js >"$tmp/log" 2>&1 &
  cpid=$!
  for _ in $(seq 1 40); do grep -q TERMINUS_READY "$tmp/log" 2>/dev/null && break; sleep 0.25; done
  if grep -q TERMINUS_READY "$tmp/log" 2>/dev/null; then ok "core service starts (test port $port)"; else problem "core service failed to start: $(tail -3 "$tmp/log")"; fi
  kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null; rm -rf "$tmp"
else
  info "skipped"
fi

# ---------------------------------------------------------------- Linux window runtime libraries
if [ "$OS" = Linux ] && [ -x node_modules/electron/dist/electron ]; then
  step "Linux window libraries (Electron)"
  missing_libs="$(ldd node_modules/electron/dist/electron 2>/dev/null | awk '/not found/{print $1}' | tr '\n' ' ')"
  if [ -z "$missing_libs" ]; then ok "all shared libraries present"; else
    warn "missing: $missing_libs"
    case "$PM" in
      apt-get) libasound=libasound2; apt-cache show libasound2t64 >/dev/null 2>&1 && libasound=libasound2t64
               pkg_install "Electron runtime libraries" libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 "$libasound" libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libxss1 ;;
      dnf|yum) pkg_install "Electron runtime libraries" nss atk at-spi2-atk cups-libs libdrm gtk3 mesa-libgbm alsa-lib libxkbcommon libXcomposite libXdamage libXrandr pango cairo libXScrnSaver ;;
      pacman) pkg_install "Electron runtime libraries" nss atk at-spi2-core libcups libdrm gtk3 mesa alsa-lib libxkbcommon libxcomposite libxdamage libxrandr pango cairo libxss ;;
      zypper) pkg_install "Electron runtime libraries" mozilla-nss libatk-1_0-0 libatk-bridge-2_0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 libxkbcommon0 libXcomposite1 libXdamage1 libXrandr2 ;;
      *) problem "Install these libraries for the Linux window: $missing_libs" ;;
    esac
    [ $WSL = 1 ] && info "(Only needed for the WSLg window; the native Windows app doesn't use them.)"
    still="$(ldd node_modules/electron/dist/electron 2>/dev/null | awk '/not found/{print $1}' | tr '\n' ' ')"
    if [ -z "$still" ]; then ok "Linux window libraries verified"; elif [ "$CHECK" = 0 ]; then problem "Still missing for the Linux window: $still"; fi
  fi
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if [ $WSL = 1 ]; then warn "no WSLg display detected; use the native Windows app instead (below)"; else warn "no display detected (DISPLAY/WAYLAND_DISPLAY); 'npm start' needs a desktop session"; fi
  fi
fi

# ---------------------------------------------------------------- config
step "Terminus config (~/.terminus)"
TH="${TERMINUS_HOME:-$HOME/.terminus}"
if [ -n "$CONFIG_FILE" ]; then
  if [ ! -f "$CONFIG_FILE" ]; then problem "--config file not found: $CONFIG_FILE"
  elif ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG_FILE" 2>/dev/null; then problem "--config is not valid JSON: $CONFIG_FILE"
  elif [ "$CHECK" = 0 ]; then
    mkdir -p "$TH"
    [ -f "$TH/config.json" ] && cp "$TH/config.json" "$TH/config.json.bak-$(date +%Y%m%d%H%M%S)" && info "backed up existing config.json"
    cp "$CONFIG_FILE" "$TH/config.json"; ok "using $CONFIG_FILE as $TH/config.json"
  fi
elif [ -f "$TH/config.json" ]; then ok "$TH/config.json exists"
else info "will be created with defaults on first start ($TH/config.json)"; fi

# ---------------------------------------------------------------- native Windows app (WSL only)
if [ $WSL = 1 ]; then
  step "Native Windows app"
  if ! have cmd.exe || ! have wslpath; then
    warn "Windows interop is disabled in this distro; skipping (enable [interop] in /etc/wsl.conf)"
  elif [ "$WINDOWS" = no ] || [ "$CHECK" = 1 ]; then
    info "skipped (install later with: npm run win:install)"
  elif [ "${#PROBLEMS[@]}" -gt 0 ]; then
    warn "fix the problems above first, then: npm run win:install"
  elif [ "$WINDOWS" = yes ] || ask "Install/update the native Windows app (GPU-accelerated window, Start Menu shortcut)?"; then
    if node scripts/win-install.mjs; then ok "Windows app installed"; else problem "Windows app install failed (is Terminus open on Windows? close it and re-run)"; fi
  else
    info "skipped (install later with: npm run win:install)"
  fi
fi

# ---------------------------------------------------------------- summary
step "Summary"
if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  ok "Terminus is ready."
  if [ $WSL = 1 ]; then
    info "Windows:  open \"Terminus\" from the Start Menu   (or: npm run win)"
    info "WSLg:     npm start"
  else
    info "Start:    npm start"
  fi
  info "Then turn on hooks in Settings → Terminus → Claude Code hooks."
  exit 0
fi
printf '\n%s%d thing(s) need attention:%s\n' "$Y" "${#PROBLEMS[@]}" "$N"
for p in "${PROBLEMS[@]}"; do printf '  • %s\n' "$p"; done
[ "$CHECK" = 1 ] && printf '\nRe-run without --check to fix what can be fixed automatically.\n'
exit 1
