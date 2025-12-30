/**
 * PortStatus Worker v6.2 — NAVCEN + Pattern Signals (negative-aware) + Zone Events + Status Rollups + Freshness
 *
 * v6.2 changes vs v6.1:
 *  - ✅ Removes "orange" from top-level status contract (now only: green/yellow/red)
 *    - MODERATE signals now roll up to "yellow" (Reduced Operations)
 *
 * Notes:
 *  - Frontend expects green/yellow/red for marker coloring and labels.
 *  - All other logic is unchanged from v6.1.
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "OPTIONS") return cors("", 204);

      if (path === "/") {
        return corsJson({
          status: "green",
          version: "v6.2",
          routes: ["/", "/events", "/navcen/zones", "/navcen/lookup", "/navcen/zone", "/navcen/zone-events"],
          ts: new Date().toISOString(),
        });
      }

      if (path === "/navcen/zones") {
        const zonesInfo = await getNavcenZonesInfo(ctx);
        return corsJson({ status: "green", ...zonesInfo });
      }

      if (path === "/navcen/zone") {
        const zone = sanitizeZone(url.searchParams.get("zone"));
        if (!zone) return corsJson({ status: "red", error: "Missing or invalid ?zone=" }, 400);

        const fetchedAt = new Date().toISOString();
        const parsed = await getParsedZonePage(zone, ctx);
        const freshness = computeFreshnessFromRows(parsed.rows, fetchedAt);

        return corsJson({
          status: "green",
          zone,
          url: zoneUrl(zone),
          fetchedAt,
          cotp: parsed.cotp || null,
          rows_count: parsed.rows.length,
          rows_sample: parsed.rows.slice(0, 25),
          ...freshness,
        });
      }

      if (path === "/navcen/zone-events") {
        const zone = sanitizeZone(url.searchParams.get("zone"));
        if (!zone) return corsJson({ status: "red", error: "Missing or invalid ?zone=" }, 400);

        const fetchedAt = new Date().toISOString();
        const parsed = await getParsedZonePage(zone, ctx);
        const freshness = computeFreshnessFromRows(parsed.rows, fetchedAt);

        const navcenItems = parsed.rows.map((r) => ({
          source: "navcen",
          type: "cotp_port_status",
          title: `NAVCEN Port Status — ${r.port} (${zone})`,
          port: r.port,
          zone,
          status_text: r.status,
          comments: r.comments || null,
          last_changed: r.lastChanged || null,
          fetched_at: fetchedAt,
          cotp: parsed.cotp || null,
          url: zoneUrl(zone),
          match_score: 100,
          matched_on: "zone_events",
          ts: fetchedAt,
        }));

        const signals = extractSignalsFromNavcen(navcenItems);
        const zoneStatus = computeStatusFromSignals(signals);

        return corsJson({
          status: zoneStatus,
          zone,
          fetchedAt,
          cotp: parsed.cotp || null,
          rows_count: parsed.rows.length,
          rows: parsed.rows,
          signals_count: signals.length,
          signals,
          ...freshness,
        });
      }

      if (path === "/navcen/lookup") {
        const name = (url.searchParams.get("name") || "").trim();
        const deep = url.searchParams.get("deep") === "1";
        if (!name) return corsJson({ status: "red", error: "Missing ?name=" }, 400);

        const zonesInfo = await getNavcenZonesInfo(ctx);
        const matches = await findNavcenMatchesBounded(name, zonesInfo.zones, ctx, { deep });

        return corsJson({
          status: "green",
          zones_from: zonesInfo.from,
          zones_count: zonesInfo.count,
          query: name,
          deep,
          scanned_zones: matches._scannedZones,
          best: matches.items[0] || null,
          matches: matches.items.slice(0, 10),
        });
      }

      if (path === "/events") {
        const lat = url.searchParams.get("lat");
        const lon = url.searchParams.get("lon");
        const name = (url.searchParams.get("name") || "").trim();

        if (!lat || !lon || !name) {
          return corsJson({ status: "red", error: "Use /events?lat=...&lon=...&name=..." }, 400);
        }

        const fetchedAt = new Date().toISOString();
        const zonesInfo = await getNavcenZonesInfo(ctx);
        const matches = await findNavcenMatchesBounded(name, zonesInfo.zones, ctx, { deep: false });

        const navcenItems = matches.items.slice(0, 8).map((m) => ({
          source: "navcen",
          type: "cotp_port_status",
          title: `NAVCEN Port Status — ${m.port} (${m.zone})`,
          port: m.port,
          zone: m.zone,
          status_text: m.status,
          comments: m.comments || null,
          last_changed: m.lastChanged || null,
          fetched_at: fetchedAt,
          cotp: m.cotp || null,
          url: m.url,
          match_score: m._score,
          matched_on: m._matchedOn,
          ts: fetchedAt,
        }));

        const signals = extractSignalsFromNavcen(navcenItems);
        const health = computePortHealth(name, navcenItems, signals);
        const topStatus = computeStatusFromSignals(signals);

        return corsJson({
          status: topStatus,
          items: [
            {
              source: "portstatus",
              type: "port_health",
              title: "Port Health",
              port_name: name,
              as_of: fetchedAt,
              navcen_zones_from: zonesInfo.from,
              navcen_zones_count: zonesInfo.count,
              navcen_scanned_zones: matches._scannedZones,
              ...health,
            },
            ...navcenItems,
            ...signals,
          ],
        });
      }

      return corsJson({ status: "red", error: "Not found", path }, 404);
    } catch (err) {
      return corsJson(
        { status: "red", error: "Worker error", detail: String(err?.stack || err) },
        500
      );
    }
  },
};

/* ------------------------------ ZONE SANITIZER ------------------------------ */

function sanitizeZone(z) {
  const zone = (z || "").trim();
  if (!zone) return null;
  if (/[\/\?&]/.test(zone)) return null;
  return zone;
}

/* ------------------------------ STATUS / FRESHNESS ------------------------------ */

function computeStatusFromSignals(signals) {
  // Highest severity wins: red > yellow > green
  // Map: INFO -> 0, MINOR -> 1, MODERATE -> 2, SEVERE/MAJOR/CRITICAL -> 3
  const rank = (sev) => {
    const s = String(sev || "").toUpperCase();
    if (s === "INFO" || s === "NONE") return 0;
    if (s === "MINOR") return 1;
    if (s === "MODERATE") return 2;
    if (s === "SEVERE" || s === "MAJOR" || s === "CRITICAL") return 3;
    return 0;
  };

  let max = 0;
  for (const s of signals || []) {
    if (s.type !== "signal") continue;
    max = Math.max(max, rank(s.severity));
  }

  if (max >= 3) return "red";
  if (max >= 1) return "yellow"; // ✅ MINOR or MODERATE -> yellow (Reduced Operations)
  return "green";
}

function computeFreshnessFromRows(rows, fetchedAtIso) {
  // NAVCEN provides YYYY-MM-DD in lastChanged (date only). We compute:
  // - sourceLastChangedMax (max date)
  // - dataAgeDays (approx days since that max date)
  let maxDate = null;

  for (const r of rows || []) {
    const d = parseYmdDate(r.lastChanged);
    if (!d) continue;
    if (!maxDate || d > maxDate) maxDate = d;
  }

  const fetched = new Date(fetchedAtIso);
  const out = {
    sourceLastChangedMax: maxDate ? toYmd(maxDate) : null,
    dataAgeDays: null,
  };

  if (maxDate && isFinite(fetched.getTime())) {
    const diffMs = fetched.getTime() - maxDate.getTime();
    out.dataAgeDays = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  }

  return out;
}

function parseYmdDate(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // treat as UTC midnight to avoid TZ skew
  const d = new Date(s + "T00:00:00.000Z");
  return isFinite(d.getTime()) ? d : null;
}
function toYmd(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* ------------------------------ SIGNALS ------------------------------ */

function extractSignalsFromNavcen(navcenItems) {
  const out = [];
  const seen = new Set();

  // Track if any non-INFO signals exist for the port
  const hasNonInfoByPort = new Map();
  const portKey = (it) => `${it.zone}||${it.port}`;
  const markNonInfo = (it) => hasNonInfoByPort.set(portKey(it), true);

  // Pass 1: detect non-INFO signals (debris/flooding/etc.) so ALL_CLEAR is gated
  for (const it of navcenItems) {
    const comments = it.comments || "";
    const lc = comments.toLowerCase();

    const noDebris = /\bno\s+debris\b/.test(lc);
    const noFlooding =
      /\bno\s+flooding\b/.test(lc) ||
      /\bno\s+debris\s+or\s+flooding\b/.test(lc) ||
      /\bno\b[^;,.]{0,40}\bflooding\b/.test(lc);

    const hasDebris = /\bdebris\b/.test(lc);
    const hasFlooding = /\bflooding\b|\bflood\b/.test(lc);

    if ((hasDebris && !noDebris) || (hasFlooding && !noFlooding)) markNonInfo(it);
    if (/(with restrictions|restriction)/i.test(comments)) markNonInfo(it);
    if (matchPortCondition(comments)) markNonInfo(it);
    if (/MARSEC\s*(LEVEL)?\s*([0-9])/i.test(comments)) markNonInfo(it);
    if (/(security zone|security advisory|safety zone)/i.test(comments)) markNonInfo(it);
    if (/(storm|hurricane|tropical|wind|gale|fog|ice|weather)/i.test(comments)) markNonInfo(it);
    if (/(draft|shoal|shoaling|channel|river stage|bridge opening|lock)/i.test(comments)) markNonInfo(it);
    if (/(power|outage|terminal|equipment|facility|bridge|lock closure)/i.test(comments)) markNonInfo(it);
    if (/(strike|labor|work stoppage|union)/i.test(comments)) markNonInfo(it);
    if (/(congestion|queue|backlog|delays|anchorage|waiting)/i.test(comments)) markNonInfo(it);

    // “MTS impacts” present (not negated) should be non-INFO too
    if (
      /(mts impacts|mts impact)/i.test(comments) &&
      !/(no\s+mts\s+impacts|no\s+mts\s+impact|no\s+impacts\b)/i.test(comments)
    ) {
      markNonInfo(it);
    }
  }

  // Pass 2: emit signals
  const allClearByPort = new Set();

  for (const it of navcenItems) {
    const comments = it.comments || "";
    const lc = comments.toLowerCase();

    // Negative-aware detection:
    const noDebris = /\bno\s+debris\b/.test(lc);
    const noFlooding =
      /\bno\s+flooding\b/.test(lc) ||
      /\bno\s+debris\s+or\s+flooding\b/.test(lc) ||
      /\bno\b[^;,.]{0,40}\bflooding\b/.test(lc);

    const hasDebris = /\bdebris\b/.test(lc);
    const hasFlooding = /\bflooding\b|\bflood\b/.test(lc);

    // References (MSIB / BNM / LNM)
    for (const ref of findRefs(comments)) {
      const key = `ref|${ref.kind}|${ref.value}|${it.zone}|${it.port}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        source: "portstatus",
        type: "authority_reference",
        title: `${ref.kind} reference`,
        port: it.port,
        zone: it.zone,
        ref_kind: ref.kind,
        ref_value: ref.value,
        note: ref.note || null,
        url: "https://www.navcen.uscg.gov/maritime-safety-information",
        ts: it.ts,
      });
    }

    // Restrictions
    if (lc.includes("with restrictions") || lc.includes("restriction")) {
      pushOnce(out, seen, {
        key: `sig|restrictions|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Operating with restrictions",
          port: it.port,
          zone: it.zone,
          category: "RESTRICTION",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Port condition
    const pc = matchPortCondition(comments);
    if (pc) {
      pushOnce(out, seen, {
        key: `sig|port_condition|${pc.level}|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Port condition",
          port: it.port,
          zone: it.zone,
          category: "WEATHER",
          severity: pc.severity,
          port_condition: pc.level,
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // MARSEC
    const marsec = comments.match(/MARSEC\s*(LEVEL)?\s*([0-9])/i);
    if (marsec) {
      pushOnce(out, seen, {
        key: `sig|marsec|${marsec[2]}|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "MARSEC level",
          port: it.port,
          zone: it.zone,
          category: "SECURITY",
          severity: marsec[2] === "3" ? "SEVERE" : marsec[2] === "2" ? "MODERATE" : "MINOR",
          marsec_level: Number(marsec[2]),
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Zones
    if (/(security zone|security advisory)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|security_zone|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Security zone / advisory",
          port: it.port,
          zone: it.zone,
          category: "SECURITY",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }
    if (/(safety zone)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|safety_zone|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Safety zone",
          port: it.port,
          zone: it.zone,
          category: "SAFETY",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Generic weather keywords
    if (/(storm|hurricane|tropical|wind|gale|fog|ice|weather)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|weather|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Weather impact mentioned",
          port: it.port,
          zone: it.zone,
          category: "WEATHER",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Waterway constraints
    if (/(draft|shoal|shoaling|channel|river stage|bridge opening|lock)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|waterway|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Waterway constraint mentioned",
          port: it.port,
          zone: it.zone,
          category: "WATERWAY_CONDITION",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Infrastructure/outage
    if (/(power|outage|terminal|equipment|facility|bridge|lock closure)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|infrastructure|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Infrastructure / facility issue mentioned",
          port: it.port,
          zone: it.zone,
          category: "INFRASTRUCTURE",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Labor
    if (/(strike|labor|work stoppage|union)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|labor|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Labor disruption mentioned",
          port: it.port,
          zone: it.zone,
          category: "LABOR",
          severity: "SEVERE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // Congestion-ish
    if (/(congestion|queue|backlog|delays|anchorage|waiting)/i.test(comments)) {
      pushOnce(out, seen, {
        key: `sig|congestion_kw|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Congestion / delay mentioned",
          port: it.port,
          zone: it.zone,
          category: "CONGESTION",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // ✅ Debris reported (only if not negated)
    if (hasDebris && !noDebris) {
      const sev = /(minor)/i.test(comments) ? "MINOR" : "MODERATE";
      pushOnce(out, seen, {
        key: `sig|debris|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Debris reported",
          port: it.port,
          zone: it.zone,
          category: "WATERWAY_CONDITION",
          severity: sev,
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // ✅ Flooding reported (only if not negated)
    if (hasFlooding && !noFlooding) {
      pushOnce(out, seen, {
        key: `sig|flooding|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "Flooding reported",
          port: it.port,
          zone: it.zone,
          category: "WEATHER",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // ✅ “MTS impacts” present (not “no impacts”)
    if (
      /(mts impacts|mts impact)/i.test(comments) &&
      !/(no\s+mts\s+impacts|no\s+mts\s+impact|no\s+impacts\b)/i.test(comments)
    ) {
      pushOnce(out, seen, {
        key: `sig|mts_impacts|${it.zone}|${it.port}`,
        obj: {
          source: "portstatus",
          type: "signal",
          title: "MTS impacts reported",
          port: it.port,
          zone: it.zone,
          category: "CONGESTION",
          severity: "MODERATE",
          detail: comments,
          ts: it.ts,
        },
      });
    }

    // ✅ ALL CLEAR (only if port has NO non-INFO signals)
    const hasNoMtsImpacts = /(no\s+mts\s+impacts|no\s+mts\s+impact|no\s+impacts\b)/i.test(comments);
    const hasNoEnvIssues = noDebris || noFlooding;
    const kPort = portKey(it);

    if ((hasNoMtsImpacts || hasNoEnvIssues) && !hasNonInfoByPort.get(kPort)) {
      if (!allClearByPort.has(kPort)) {
        allClearByPort.add(kPort);

        const parts = [];
        if (hasNoMtsImpacts) parts.push("No MTS impacts");
        if (hasNoEnvIssues) parts.push("No debris/flooding");
        const combined = parts.join("; ");

        pushOnce(out, seen, {
          key: `sig|all_clear|${it.zone}|${it.port}`,
          obj: {
            source: "portstatus",
            type: "signal",
            title: "All clear",
            port: it.port,
            zone: it.zone,
            category: "ALL_CLEAR",
            severity: "INFO",
            detail: combined || "No issues reported",
            raw: comments || null,
            ts: it.ts,
          },
        });
      }
    }
  }

  return out;
}

function pushOnce(arr, seen, { key, obj }) {
  if (seen.has(key)) return;
  seen.add(key);
  arr.push(obj);
}

function findRefs(comments) {
  const out = [];
  const text = String(comments || "");
  for (const m of text.matchAll(/\bMSIB\s+(\d{1,4})[-\/](\d{2})\b/gi))
    out.push({ kind: "MSIB", value: `${m[1]}-${m[2]}` });
  for (const m of text.matchAll(/\bBNM\s+(\d{1,5})[-\/](\d{2})\b/gi))
    out.push({ kind: "BNM", value: `${m[1]}-${m[2]}` });
  for (const m of text.matchAll(/\bLNM\s+(\d{1,4})[-\/](\d{2})\b/gi))
    out.push({ kind: "LNM", value: `${m[1]}-${m[2]}` });
  return out;
}

function matchPortCondition(comments) {
  const m = String(comments || "").match(
    /PORT\s+CONDITION\s+(WHISKEY|X[- ]?RAY|YANKEE|ZULU|TROPICAL\s+STORM)/i
  );
  if (!m) return null;
  const lvl = m[1].toUpperCase().replace(/\s+/g, " ");
  const severity =
    lvl.includes("ZULU")
      ? "SEVERE"
      : lvl.includes("YANKEE")
      ? "MODERATE"
      : lvl.includes("X")
      ? "MODERATE"
      : lvl.includes("WHISKEY")
      ? "MINOR"
      : "MODERATE";
  return { level: lvl, severity };
}

/* ------------------------------ HEALTH LOGIC ------------------------------ */

function computePortHealth(portName, navcenItems, signals) {
  const out = {
    operational_state: "UNKNOWN",
    reason_code: "NONE",
    reason_summary: "No authority signal found",
    efficiency_impact_level: "UNKNOWN",
    efficiency_impact_score: 0,
    efficiency_summary: "Congestion layer not yet wired",
    confidence: 0.25,
    evidence: [],
  };

  if (!navcenItems || navcenItems.length === 0) return out;

  const e = navcenItems[0];
  const statusText = String(e.status_text || "");
  const comments = String(e.comments || "");
  const st = norm(statusText);
  const cm = comments.toLowerCase();

  if (st.includes("closed")) out.operational_state = "CLOSED";
  else if (st.includes("restrict") || st.includes("limit")) out.operational_state = "RESTRICTED";
  else if (st.includes("open")) out.operational_state = "OPEN";

  if (out.operational_state === "OPEN" && cm.includes("with restrictions"))
    out.operational_state = "RESTRICTED";

  const topCat = pickTopCategory(signals);
  out.reason_code = topCat || inferReasonCode(norm(comments), out.operational_state);

  out.reason_summary =
    out.operational_state === "OPEN" && out.reason_code === "NONE"
      ? "Open"
      : `${out.operational_state}${out.reason_code !== "NONE" ? " — " + out.reason_code : ""}`;

  const base = e.match_score != null ? clamp01(e.match_score / 100) : 0.5;
  const hasState = out.operational_state !== "UNKNOWN" ? 0.2 : 0;
  out.confidence = round2(Math.min(1, 0.5 * base + hasState + 0.3));

  out.evidence = [
    {
      source: e.source,
      type: e.type,
      title: e.title,
      url: e.url,
      extract: {
        status_text: e.status_text,
        comments: e.comments,
        last_changed: e.last_changed,
        zone: e.zone,
        fetched_at: e.fetched_at,
      },
      match_score: e.match_score,
      matched_on: e.matched_on,
    },
  ];

  return out;
}

function pickTopCategory(signals) {
  if (!signals || !signals.length) return null;
  if (signals.some((s) => s.type === "authority_reference")) return "REGULATORY";

  const nonClear = signals.filter((s) => s.category !== "ALL_CLEAR");
  if (nonClear.length === 0) return "NONE";

  const priority = [
    "SECURITY",
    "WEATHER",
    "SAFETY",
    "INFRASTRUCTURE",
    "WATERWAY_CONDITION",
    "LABOR",
    "CONGESTION",
    "RESTRICTION",
  ];
  for (const p of priority) if (signals.some((s) => s.category === p)) return p;
  return null;
}

function inferReasonCode(commentsNorm, operationalState) {
  if (!commentsNorm) return operationalState !== "OPEN" ? "REGULATORY" : "NONE";
  if (/(storm|hurricane|tropical|gale|wind|fog|weather|flood)/.test(commentsNorm)) return "WEATHER";
  if (/(safety|casualty|hazard|obstruction|allision|grounding|fire|spill)/.test(commentsNorm)) return "SAFETY";
  if (/(security|marsec|security zone)/.test(commentsNorm)) return "SECURITY";
  if (/(lock|bridge|terminal|power|outage|equipment)/.test(commentsNorm)) return "INFRASTRUCTURE";
  if (/(shoal|shoaling|draft|river|ice|channel depth|debris)/.test(commentsNorm)) return "WATERWAY_CONDITION";
  if (/(strike|labor|work stoppage|union)/.test(commentsNorm)) return "LABOR";
  if (operationalState !== "OPEN") return "REGULATORY";
  return "OTHER";
}

/* ------------------------------ NAVCEN PARSING ------------------------------ */

const NAVCEN_INDEX = "https://www.navcen.uscg.gov/port-status";
const ZONES_CACHE_KEY = "navcen:zones:v6.2";
const ZONE_PAGE_CACHE_PREFIX = "navcen:zonepage:v6.2:";

const ZONES_TTL_SECONDS = 6 * 60 * 60;
const ZONE_TTL_SECONDS = 20 * 60;

async function getNavcenZonesInfo(ctx) {
  const cache = caches.default;
  const key = new Request("https://cache.local/" + ZONES_CACHE_KEY);
  const cached = await cache.match(key);
  if (cached) return cached.json();

  const html = await fetchText(NAVCEN_INDEX);
  let zones = extractZonesRobust(html);
  let from = "parsed";
  if (!zones.length) {
    zones = NAVCEN_ZONES_FALLBACK.slice();
    from = "fallback";
  }

  const out = { from, count: zones.length, zones };
  const resp = new Response(JSON.stringify(out), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ZONES_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(key, resp.clone()));
  return out;
}

function extractZonesRobust(html) {
  const set = new Set();
  const reA = /\/port-status\?zone=([A-Za-z0-9().\-_% ]+)/g;
  let m;
  while ((m = reA.exec(html)) !== null) {
    const zone = decodeURIComponent(m[1]).trim();
    if (zone) set.add(zone);
  }
  const reB = /(?:\?|&|")zone=([A-Za-z0-9().\-_% ]+)/g;
  while ((m = reB.exec(html)) !== null) {
    const zone = decodeURIComponent(m[1]).trim();
    if (zone) set.add(zone);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

async function findNavcenMatchesBounded(portName, zones, ctx, { deep }) {
  const likely = guessLikelyZones(norm(portName), zones);
  const MAX_DEEP_ZONES = 12;
  let scanList = likely;

  if (deep) {
    const extra = zones
      .filter((z) => !likely.includes(z))
      .slice(0, Math.max(0, MAX_DEEP_ZONES - likely.length));
    scanList = likely.concat(extra);
  }

  const items = await scanZonesForMatches(portName, scanList, ctx);
  return { items, _scannedZones: scanList };
}

function guessLikelyZones(n, zones) {
  const picks = new Set();
  const addIfIncludes = (needle) => {
    for (const z of zones) if (norm(z).includes(needle)) picks.add(z);
  };

  if (n.includes("houston") || n.includes("galveston") || n.includes("freeport")) addIfIncludes("houston");
  if (n.includes("los angeles") || n.includes("long beach")) addIfIncludes("los angeles");
  if (n.includes("new york") || n.includes("new jersey")) addIfIncludes("new york");
  if (n.includes("savannah")) addIfIncludes("savannah");
  if (n.includes("seattle") || n.includes("tacoma") || n.includes("puget")) addIfIncludes("seattle");
  if (n.includes("new orleans")) addIfIncludes("new orleans");
  if (n.includes("charleston")) addIfIncludes("charleston");
  if (n.includes("miami")) addIfIncludes("miami");
  if (n.includes("jacksonville")) addIfIncludes("jacksonville");
  if (n.includes("corpus")) addIfIncludes("corpus");
  if (n.includes("mobile")) addIfIncludes("mobile");
  if (n.includes("san diego")) addIfIncludes("san diego");
  if (n.includes("san francisco") || n.includes("oakland")) addIfIncludes("san francisco");

  const arr = Array.from(picks);
  if (arr.length) return arr;
  return zones.slice(0, 6);
}

async function scanZonesForMatches(portName, zones, ctx) {
  const limit = 2;
  const out = [];

  for (let i = 0; i < zones.length; i += limit) {
    const batch = zones.slice(i, i + limit);
    const pages = await Promise.all(
      batch.map(async (zone) => {
        const parsed = await getParsedZonePage(zone, ctx);
        return { zone, ...parsed };
      })
    );

    for (const p of pages) {
      for (const row of p.rows) {
        const scored = scoreMatch(portName, row.port);
        if (scored._score >= 55) {
          out.push({
            zone: p.zone,
            url: zoneUrl(p.zone),
            port: row.port,
            status: row.status,
            comments: row.comments,
            lastChanged: row.lastChanged,
            cotp: p.cotp || null,
            _score: scored._score,
            _matchedOn: scored._matchedOn,
          });
        }
      }
    }
  }

  out.sort((a, b) => b._score - a._score);
  return out;
}

async function getParsedZonePage(zone, ctx) {
  const cache = caches.default;
  const key = new Request(
    "https://cache.local/" + ZONE_PAGE_CACHE_PREFIX + encodeURIComponent(zone)
  );
  const cached = await cache.match(key);
  if (cached) return cached.json();

  const html = await fetchText(zoneUrl(zone));
  const parsed = parseZonePageRobust(html);

  const resp = new Response(JSON.stringify(parsed), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ZONE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(key, resp.clone()));
  return parsed;
}

function zoneUrl(zone) {
  return `${NAVCEN_INDEX}?zone=${encodeURIComponent(zone)}`;
}

function parseZonePageRobust(html) {
  const stripped = stripTags(html).replace(/\r/g, "");
  const lines = stripped.split("\n").map(collapseSpaces).filter(Boolean);

  let cotp = null;
  const sectorIdx = lines.findIndex((l) => /^SECTOR\s+/i.test(l));
  if (sectorIdx >= 0) cotp = parseCotpBlock(lines.slice(sectorIdx, sectorIdx + 40));

  const blob = " " + lines.join(" \n ") + " ";
  const rows = [];
  const rowRe =
    /([A-Z0-9().,'\/\-& ]{2,}?)\s+(Open|Closed|Restricted)\s+(.{0,220}?)\s+(\d{4}-\d{2}-\d{2})/gi;

  let m;
  while ((m = rowRe.exec(blob)) !== null) {
    rows.push({
      port: collapseSpaces(m[1]).replace(/&/g, "and").trim(),
      status: collapseSpaces(m[2]).trim(),
      comments: collapseSpaces(m[3]).trim(),
      lastChanged: m[4].trim(),
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${norm(r.port)}|${norm(r.status)}|${r.lastChanged || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return { cotp, rows: deduped };
}

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseCotpBlock(lines) {
  const obj = { sector: lines[0] };
  for (const l of lines.slice(1)) {
    if (/^Primary Phone:/i.test(l)) obj.primaryPhone = l.replace(/^Primary Phone:\s*/i, "");
    if (/^Emergency Phone:/i.test(l)) obj.emergencyPhone = l.replace(/^Emergency Phone:\s*/i, "");
    if (/^Waterways Management Phone:/i.test(l))
      obj.waterwaysPhone = l.replace(/^Waterways Management Phone:\s*/i, "");
    if (/^Prevention Phone:/i.test(l)) obj.preventionPhone = l.replace(/^Prevention Phone:\s*/i, "");
    if (/^Vessel Traffic Service Phone:/i.test(l))
      obj.vtsPhone = l.replace(/^Vessel Traffic Service Phone:\s*/i, "");
  }
  const addr = [];
  for (const l of lines.slice(1, 10)) {
    if (/Phone:|Fax|MMSI|Branch|Rescue 21|Incident/i.test(l)) break;
    addr.push(l);
  }
  if (addr.length) obj.address = addr.join(", ");
  return obj;
}

/* ------------------------------ MATCHING ------------------------------ */

function scoreMatch(queryName, candidatePort) {
  const q = norm(queryName);
  const c = norm(candidatePort);
  if (q === c) return { _score: 100, _matchedOn: "exact" };
  if (c.includes(q) || q.includes(c)) return { _score: 90, _matchedOn: "contains" };

  const qt = new Set(q.split(" ").filter(Boolean));
  const ct = new Set(c.split(" ").filter(Boolean));
  let overlap = 0;
  for (const t of qt) if (ct.has(t)) overlap++;
  const union = new Set([...qt, ...ct]).size || 1;
  return { _score: Math.round((overlap / union) * 80), _matchedOn: "token_overlap" };
}

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<\/(p|div|br|li|tr|td|th|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PortStatus/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.navcen.uscg.gov/",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

/* ------------------------------ CORS ------------------------------ */

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}
function cors(body, status = 200) {
  return new Response(body, { status, headers: corsHeaders() });
}
function corsJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

const NAVCEN_ZONES_FALLBACK = [
  "BOSTON",
  "CHARLESTON",
  "COLUMBIA RIVER",
  "CORPUS CHRISTI",
  "DELAWARE BAY",
  "DETROIT",
  "DULUTH",
  "EASTERN GREAT LAKES",
  "GUAM",
  "HONOLULU",
  "HOUMA",
  "HOUSTON-GALVESTON",
  "JACKSONVILLE",
  "KEY WEST",
  "LAKE MICHIGAN",
  "LONG ISLAND SOUND",
  "LOS ANGELES-LONG BEACH",
  "LOWER MISSISSIPPI RIVER (MEMPHIS)",
  "MARYLAND-NCR",
  "MIAMI",
  "MOBILE",
  "NEW ORLEANS",
  "NEW YORK",
  "NORTH CAROLINA",
  "NORTHERN GREAT LAKES",
  "NORTHERN NEW ENGLAND (PORTLAND, MAINE)",
  "OHIO VALLEY",
  "PITTSBURGH",
  "PORT ARTHUR AND LAKE CHARLES",
  "PRINCE WILLIAM SOUND (VALDEZ)",
  "SAN DIEGO",
  "SAN FRANCISCO",
  "SAN JUAN",
  "SAVANNAH",
  "SEAK - SOUTHEAST ALASKA (JUNEAU)",
  "SEATTLE (PUGET SOUND)",
  "SOUTHEASTERN NEW ENGLAND (PROVIDENCE)",
  "ST. PETERSBURG",
  "UPPER MISSISSIPPI RIVER (ST. LOUIS)",
  "VIRGINIA",
  "WESTERN ALASKA (ANCHORAGE)",
];

