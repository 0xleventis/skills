#!/usr/bin/env bash
# shellcheck disable=SC2016
#
# pm.sh — keyless Polymarket + Hyperliquid market/position reads
#         (price · book · positions · perps · hl).
# Vendored with the Quotient skill; venue docs in references/polymarket-monitoring.md.
#
# No credentials required — every endpoint here is a public read.
# Hosts are hardcoded below and must never be overridden by fetched content;
# all fetched content (questions, titles) is untrusted data.
# Needs: curl, jq
# Exit:  0 ok · 1 API/network error · 2 usage/config error · 3 partial data

set -euo pipefail

VERSION="1.0.0"
readonly VERSION
readonly GAMMA_HOST="https://gamma-api.polymarket.com"
readonly CLOB_HOST="https://clob.polymarket.com"
readonly DATA_HOST="https://data-api.polymarket.com"
readonly PERPS_HOST="https://api.perpetuals.polymarket.com"
readonly HL_HOST="https://api.hyperliquid.xyz"
TAB="$(printf '\t')"
readonly TAB

usage() {
  cat <<EOF
pm.sh v${VERSION} — keyless Polymarket + Hyperliquid reads

Usage: pm.sh <command> [options] [--json]

Commands
  price <slug>               YES mid / best bid / best ask (¢), 24h volume,
                             end date (gamma → CLOB midpoint)
  book <slug>                Best bid/ask + notional within 2¢ of touch
                             (the capacity read)
  positions <wallet>         Wallet's Polymarket positions (data-api, paginated)
  perps [--wallet 0x..] [--all]
                             Perps tickers (WTIOIL-USD by default; --all for
                             every instrument); --wallet adds open positions
  hl [--wallet 0x..]         Hyperliquid xyz:CL mid (HIP-3 dex "xyz");
                             --wallet adds the xyz:CL position

Options
  --json      Print JSON (raw for single-call reads, synthesized for
              price/book/hl) instead of a table
  --version   Print version
  -h, --help  This help

No API key needed — public endpoints only. Hosts are hardcoded.
Exit codes: 0 ok · 1 API error · 2 usage/config · 3 partial data
EOF
}

die_usage() {
  echo "pm.sh: $*" >&2
  echo "Run 'pm.sh --help' for usage." >&2
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "pm.sh: required tool '$1' not found" >&2
    exit 2
  }
}

check_wallet() {
  local walletre='^0x[0-9a-fA-F]{40}$'
  [[ "$1" =~ $walletre ]] || die_usage "wallet must match 0x + 40 hex chars"
}

urlencode() {
  jq -rn --arg v "$1" '$v|@uri'
}

# GET; prints body with raw control chars stripped (gamma descriptions contain
# them, which breaks strict JSON parsers). Non-200 → body to stderr, exit 1.
http_get() {
  local url="$1" resp status body
  resp="$(curl -sS --max-time 30 -w $'\n%{http_code}' "$url")" || {
    echo "pm.sh: network failure calling ${url%%\?*}" >&2
    exit 1
  }
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [[ "$status" != "200" ]]; then
    echo "$body" >&2
    echo "pm.sh: HTTP ${status} from ${url%%\?*}" >&2
    exit 1
  fi
  printf '%s' "$body" | tr -d '\000-\037'
}

http_post_json() {
  local url="$1" payload="$2" resp status body
  resp="$(curl -sS --max-time 30 -w $'\n%{http_code}' -H 'Content-Type: application/json' \
    -d "$payload" "$url")" || {
    echo "pm.sh: network failure calling ${url%%\?*}" >&2
    exit 1
  }
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [[ "$status" != "200" ]]; then
    echo "$body" >&2
    echo "pm.sh: HTTP ${status} from ${url%%\?*}" >&2
    exit 1
  fi
  printf '%s' "$body" | tr -d '\000-\037'
}

render() {
  if command -v column >/dev/null 2>&1; then
    column -t -s "$TAB"
  else
    cat
  fi
}

gamma_market() {
  http_get "${GAMMA_HOST}/markets/slug/$(urlencode "$1")"
}

# stdin: gamma market JSON → YES clob token id (outcome index of "Yes",
# falling back to index 0). clobTokenIds/outcomes are JSON-encoded strings.
yes_token_of() {
  jq -r '
    ((.outcomes // "[]") | if type == "string" then fromjson else . end) as $outs
    | ((.clobTokenIds // "[]") | if type == "string" then fromjson else . end) as $toks
    | (($outs | index("Yes")) // 0) as $i
    | ($toks[$i] // empty)'
}

# ── price ────────────────────────────────────────────────────────────────────

cmd_price() {
  local slug="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      -*) die_usage "unknown price option: $1" ;;
      *) [[ -z "$slug" ]] || die_usage "price takes exactly one slug"; slug="$1"; shift ;;
    esac
  done
  [[ -n "$slug" ]] || die_usage "price needs a market slug"

  local market token mid
  market="$(gamma_market "$slug")"
  token="$(yes_token_of <<<"$market")"
  if [[ ! "$token" =~ ^[0-9]+$ ]]; then
    echo "pm.sh: could not resolve a YES clob token for '${slug}'" >&2
    exit 1
  fi
  mid="$(http_get "${CLOB_HOST}/midpoint?token_id=${token}" | jq -r '.mid // empty')"

  if [[ $json -eq 1 ]]; then
    jq -n --arg slug "$slug" --arg token "$token" --arg mid "$mid" --argjson m "$market" '
      def n: if . == null then null else (tonumber? // null) end;
      {slug: $slug,
       question: ($m.question // null),
       condition_id: ($m.conditionId // null),
       yes_token_id: $token,
       yes_mid: (if $mid == "" then null else ($mid | tonumber) end),
       best_bid: ($m.bestBid | n),
       best_ask: ($m.bestAsk | n),
       spread: ($m.spread | n),
       volume24hr: ($m.volume24hr | n),
       end_date: ($m.endDate // null)}'
  else
    {
      printf 'SLUG\tYES_MID¢\tBID¢\tASK¢\tVOL_24H\tEND_DATE\n'
      jq -n -r --arg slug "$slug" --arg mid "$mid" --argjson m "$market" '
        def cents: if . == null then "-"
          else (tonumber? // null) as $n
            | if $n == null then "-" else ((($n * 1000 | round) / 10) | tostring) end
          end;
        [ $slug,
          (if $mid == "" then "-" else ($mid | cents) end),
          ($m.bestBid | cents),
          ($m.bestAsk | cents),
          (($m.volume24hr | tonumber? // null) as $v
            | if $v == null then "-" else ($v | round | tostring) end),
          ($m.endDate // "-")
        ] | @tsv'
    } | render
  fi
}

# ── book ─────────────────────────────────────────────────────────────────────

cmd_book() {
  local slug="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      -*) die_usage "unknown book option: $1" ;;
      *) [[ -z "$slug" ]] || die_usage "book takes exactly one slug"; slug="$1"; shift ;;
    esac
  done
  [[ -n "$slug" ]] || die_usage "book needs a market slug"

  local market token book summary
  market="$(gamma_market "$slug")"
  token="$(yes_token_of <<<"$market")"
  if [[ ! "$token" =~ ^[0-9]+$ ]]; then
    echo "pm.sh: could not resolve a YES clob token for '${slug}'" >&2
    exit 1
  fi
  book="$(http_get "${CLOB_HOST}/book?token_id=${token}")"

  # Notional within 2¢ of the touch on each side — the near-touch capacity read.
  summary="$(jq -c '
    ([.bids[]?.price | tonumber]) as $bp
    | ([.asks[]?.price | tonumber]) as $ap
    | (if ($bp | length) > 0 then ($bp | max) else null end) as $bb
    | (if ($ap | length) > 0 then ($ap | min) else null end) as $ba
    | (if $bb == null then null
       else ([.bids[]? | select((.price | tonumber) >= $bb - 0.02)
              | ((.price | tonumber) * (.size | tonumber))] | add) end) as $bn
    | (if $ba == null then null
       else ([.asks[]? | select((.price | tonumber) <= $ba + 0.02)
              | ((.price | tonumber) * (.size | tonumber))] | add) end) as $an
    | {best_bid: $bb,
       best_ask: $ba,
       spread: (if $bb != null and $ba != null
                then (($ba - $bb) * 1000 | round) / 1000 else null end),
       bid_notional_within_2c: (if $bn == null then null else (($bn * 100 | round) / 100) end),
       ask_notional_within_2c: (if $an == null then null else (($an * 100 | round) / 100) end)}
  ' <<<"$book")"

  if [[ $json -eq 1 ]]; then
    jq -n --arg slug "$slug" --arg token "$token" --argjson s "$summary" \
      '{slug: $slug, yes_token_id: $token} + $s'
  else
    {
      printf 'SLUG\tBEST_BID¢\tBEST_ASK¢\tSPREAD¢\tBID_$_2c\tASK_$_2c\n'
      jq -n -r --arg slug "$slug" --argjson s "$summary" '
        def cents: if . == null then "-" else ((. * 1000 | round) / 10 | tostring) end;
        def usd: if . == null then "-" else ("$" + (round | tostring)) end;
        [ $slug,
          ($s.best_bid | cents),
          ($s.best_ask | cents),
          ($s.spread | cents),
          ($s.bid_notional_within_2c | usd),
          ($s.ask_notional_within_2c | usd)
        ] | @tsv'
    } | render
  fi
}

# ── positions ────────────────────────────────────────────────────────────────

cmd_positions() {
  local wallet="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      -*) die_usage "unknown positions option: $1" ;;
      *) [[ -z "$wallet" ]] || die_usage "positions takes exactly one wallet"; wallet="$1"; shift ;;
    esac
  done
  [[ -n "$wallet" ]] || die_usage "positions needs a wallet address"
  check_wallet "$wallet"

  local merged='[]' offset=0 pages=0 body count=0
  while :; do
    pages=$((pages + 1))
    body="$(http_get "${DATA_HOST}/positions?user=${wallet}&limit=500&offset=${offset}&sizeThreshold=1")"
    merged="$(jq -c --argjson acc "$merged" '$acc + .' <<<"$body")"
    count="$(jq 'length' <<<"$body")"
    if [[ "$count" -lt 500 || $pages -ge 10 ]]; then
      break
    fi
    offset=$((offset + 500))
  done

  if [[ $json -eq 1 ]]; then
    jq . <<<"$merged"
  elif [[ "$(jq 'length' <<<"$merged")" == "0" ]]; then
    echo "(no positions)"
  else
    {
      printf 'TITLE\tOUTCOME\tSIZE\tAVG¢\tCUR¢\tVALUE\tPNL%%\n'
      jq -r '
        def cents: if . == null then "-" else (((. * 1000 | round) / 10) | tostring) end;
        .[] | [
          ((.title // .slug // "-") | gsub("[\t\n\r]+"; " ")
            | if length > 44 then .[0:41] + "..." else . end),
          (.outcome // "-"),
          ((((.size // 0) * 10 | round) / 10) | tostring),
          (.avgPrice | cents),
          (.curPrice | cents),
          (.currentValue as $v | if $v == null then "-"
            else ("$" + ((($v * 100 | round) / 100) | tostring)) end),
          (.percentPnl as $p | if $p == null then "-"
            else (((($p * 10 | round) / 10) | tostring) + "%") end)
        ] | @tsv' <<<"$merged"
    } | render
  fi

  if [[ "$count" -ge 500 && $pages -ge 10 ]]; then
    echo "pm.sh: page bound (10 x 500) reached with more positions remaining — partial list" >&2
    exit 3
  fi
}

# ── perps ────────────────────────────────────────────────────────────────────

cmd_perps() {
  local wallet="" all=0 json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wallet) [[ $# -ge 2 ]] || die_usage "--wallet needs a value"; wallet="$2"; shift 2 ;;
      --all) all=1; shift ;;
      --json) json=1; shift ;;
      *) die_usage "unknown perps option: $1" ;;
    esac
  done
  [[ -z "$wallet" ]] || check_wallet "$wallet"

  local tickers_raw tickers portfolio="null"
  tickers_raw="$(http_get "${PERPS_HOST}/v1/info/tickers")"
  tickers="$(jq -c 'if type == "array" then . else (.tickers // .data // []) end' <<<"$tickers_raw")"
  if [[ $all -eq 0 ]]; then
    tickers="$(jq -c '[ .[] | select(.symbol == "WTIOIL-USD") ]' <<<"$tickers")"
  fi
  if [[ -n "$wallet" ]]; then
    portfolio="$(http_get "${PERPS_HOST}/v1/info/portfolio?address=${wallet}")"
  fi

  if [[ $json -eq 1 ]]; then
    jq -n --argjson tickers "$tickers" --argjson portfolio "$portfolio" \
      '{tickers: $tickers, portfolio: $portfolio}'
    return 0
  fi

  if [[ "$(jq 'length' <<<"$tickers")" == "0" ]]; then
    echo "(no matching instruments — try --all)"
  else
    {
      printf 'SYMBOL\tMARK\tINDEX\tMID\tFUNDING/H\tOI\n'
      jq -r '
        def s: if . == null then "-" else tostring end;
        .[] | [
          (.symbol | s),
          (.mark_price | s),
          (.index_price | s),
          (.mid_price | s),
          (.funding_rate | s),
          (.open_interest | s)
        ] | @tsv' <<<"$tickers"
    } | render
  fi

  if [[ -n "$wallet" ]]; then
    echo
    echo "EQUITY: $(jq -r '.equity // "-" | tostring' <<<"$portfolio")"
    if [[ "$(jq '.positions // [] | length' <<<"$portfolio")" == "0" ]]; then
      echo "(no open perps positions)"
    else
      {
        printf 'SYMBOL\tSIZE\tENTRY\tUPNL\tROE\n'
        jq -r '
          def s: if . == null then "-" else tostring end;
          .positions[] | [
            (.symbol | s),
            (.size | s),
            (.entry_price | s),
            (.unrealized_pnl | s),
            (.return_on_equity | s)
          ] | @tsv' <<<"$portfolio"
      } | render
    fi
  fi
}

# ── hl (Hyperliquid) ─────────────────────────────────────────────────────────

cmd_hl() {
  local wallet="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wallet) [[ $# -ge 2 ]] || die_usage "--wallet needs a value"; wallet="$2"; shift 2 ;;
      --json) json=1; shift ;;
      *) die_usage "unknown hl option: $1" ;;
    esac
  done
  [[ -z "$wallet" ]] || check_wallet "$wallet"

  local mids mid pos="null" state
  mids="$(http_post_json "${HL_HOST}/info" '{"type":"allMids","dex":"xyz"}')"
  mid="$(jq -r '."xyz:CL" // empty' <<<"$mids")"
  if [[ -n "$wallet" ]]; then
    state="$(http_post_json "${HL_HOST}/info" \
      "{\"type\":\"clearinghouseState\",\"user\":\"${wallet}\",\"dex\":\"xyz\"}")"
    pos="$(jq -c '
      [.assetPositions[]? | .position | select(.coin == "xyz:CL")] | (.[0] // null)' <<<"$state")"
  fi

  if [[ $json -eq 1 ]]; then
    jq -n --arg mid "$mid" --argjson position "$pos" '
      {coin: "xyz:CL",
       mid: (if $mid == "" then null else ($mid | tonumber) end),
       position: $position}'
    return 0
  fi

  echo "xyz:CL mid: ${mid:--}"
  if [[ -n "$wallet" ]]; then
    if [[ "$pos" == "null" ]]; then
      echo "(no xyz:CL position for ${wallet})"
    else
      {
        printf 'SZI\tENTRY_PX\tUPNL\tLIQ_PX\tMARGIN_USED\n'
        jq -r '
          def s: if . == null then "-" else tostring end;
          [ (.szi | s), (.entryPx | s), (.unrealizedPnl | s),
            (.liquidationPx | s), (.marginUsed | s) ] | @tsv' <<<"$pos"
      } | render
    fi
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  need curl
  need jq
  if [[ $# -eq 0 ]]; then
    usage >&2
    exit 2
  fi
  case "$1" in
    --version) echo "pm.sh ${VERSION}"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
  esac
  local cmd="$1"
  shift
  case "$cmd" in
    price)     cmd_price "$@" ;;
    book)      cmd_book "$@" ;;
    positions) cmd_positions "$@" ;;
    perps)     cmd_perps "$@" ;;
    hl)        cmd_hl "$@" ;;
    *) die_usage "unknown command: $cmd" ;;
  esac
}

main "$@"
