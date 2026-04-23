/**
 * Tiny, dependency-free metrics registry emitting Prometheus text-format. We
 * intentionally avoid prom-client so the backend stays light; the feature set
 * here is counters + gauges + histograms with a fixed bucket list, which
 * covers what we need (turn latency, LLM cost/day, unlock rate, fallback
 * invocation count). Swap for prom-client once we need percentile-exact
 * histograms or native summaries.
 */

type Labels = Record<string, string>;

interface Entry {
  help: string;
  type: "counter" | "gauge" | "histogram";
}

interface CounterState extends Entry {
  type: "counter";
  values: Map<string, number>;
}

interface GaugeState extends Entry {
  type: "gauge";
  values: Map<string, number>;
}

interface HistogramState extends Entry {
  type: "histogram";
  buckets: number[];
  series: Map<string, { counts: number[]; sum: number; count: number }>;
}

const registry = new Map<string, CounterState | GaugeState | HistogramState>();

function labelKey(labels: Labels | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(labels[k] ?? "")}`).join(",");
}

function formatLabels(labels: Labels | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${(labels[k] ?? "").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export interface Counter {
  inc(by?: number, labels?: Labels): void;
}

export interface Gauge {
  set(v: number, labels?: Labels): void;
}

export function counter(name: string, help: string): Counter {
  const s = ensureCounter(name, help);
  return {
    inc(by = 1, labels) {
      const key = labelKey(labels);
      s.values.set(key, (s.values.get(key) ?? 0) + by);
    },
  };
}

export function gauge(name: string, help: string): Gauge {
  const s = ensureGauge(name, help);
  return {
    set(v, labels) {
      const key = labelKey(labels);
      s.values.set(key, v);
    },
  };
}

const DEFAULT_LATENCY_BUCKETS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000,
];

export function histogram(
  name: string,
  help: string,
  opts?: { buckets?: number[] },
): { observe(value: number, labels?: Labels): void } {
  const s = ensureHistogram(name, help, opts?.buckets ?? DEFAULT_LATENCY_BUCKETS);
  return {
    observe(value, labels) {
      const key = labelKey(labels);
      let series = s.series.get(key);
      if (!series) {
        series = { counts: new Array(s.buckets.length).fill(0), sum: 0, count: 0 };
        s.series.set(key, series);
      }
      series.count += 1;
      series.sum += value;
      for (let i = 0; i < s.buckets.length; i++) {
        if (value <= (s.buckets[i] as number)) {
          series.counts[i] = (series.counts[i] ?? 0) + 1;
        }
      }
    },
  };
}

function ensureCounter(name: string, help: string): CounterState {
  const existing = registry.get(name);
  if (existing && existing.type === "counter") return existing;
  const s: CounterState = { help, type: "counter", values: new Map() };
  registry.set(name, s);
  return s;
}

function ensureGauge(name: string, help: string): GaugeState {
  const existing = registry.get(name);
  if (existing && existing.type === "gauge") return existing;
  const s: GaugeState = { help, type: "gauge", values: new Map() };
  registry.set(name, s);
  return s;
}

function ensureHistogram(name: string, help: string, buckets: number[]): HistogramState {
  const existing = registry.get(name);
  if (existing && existing.type === "histogram") return existing;
  const s: HistogramState = { help, type: "histogram", buckets, series: new Map() };
  registry.set(name, s);
  return s;
}

function parseLabelKey(key: string): Labels {
  if (!key) return {};
  const out: Labels = {};
  for (const pair of key.split(",")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    out[k] = JSON.parse(v);
  }
  return out;
}

/**
 * Render the registry in Prometheus text exposition format. Called by the /metrics HTTP handler.
 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, entry] of registry.entries()) {
    lines.push(`# HELP ${name} ${entry.help}`);
    lines.push(`# TYPE ${name} ${entry.type}`);
    if (entry.type === "counter" || entry.type === "gauge") {
      for (const [key, value] of entry.values.entries()) {
        const labels = parseLabelKey(key);
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    } else {
      for (const [key, series] of entry.series.entries()) {
        const labels = parseLabelKey(key);
        for (let i = 0; i < entry.buckets.length; i++) {
          const bLabels: Labels = { ...labels, le: String(entry.buckets[i]) };
          lines.push(`${name}_bucket${formatLabels(bLabels)} ${series.counts[i] ?? 0}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${series.count}`);
        lines.push(`${name}_sum${formatLabels(labels)} ${series.sum}`);
        lines.push(`${name}_count${formatLabels(labels)} ${series.count}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ─── Pre-declared metrics used across the service ──────────────────────────

export const metrics = {
  inboundEventsTotal: counter("peach_inbound_events_total", "Platform events received"),
  turnLatency: histogram("peach_turn_latency_ms", "End-to-end turn latency (inbound→enqueued reply)"),
  llmCallDuration: histogram("peach_llm_call_duration_ms", "LLM call latency"),
  llmCallCost: counter("peach_llm_cost_cents_total", "LLM spend in cents"),
  llmFallbackInvoked: counter("peach_llm_fallback_invoked_total", "Fallback provider invocations"),
  ppvPitched: counter("peach_ppv_pitched_total", "PPV pitches sent"),
  ppvUnlocked: counter("peach_ppv_unlocked_total", "PPV unlocks received"),
  ppvRevenueCents: counter("peach_ppv_revenue_cents_total", "PPV revenue in cents"),
  stateTransitions: counter("peach_state_transitions_total", "State machine transitions"),
  outboundSends: counter("peach_outbound_sends_total", "Outbound messages sent by adapter"),
  outboundFailures: counter("peach_outbound_failures_total", "Outbound send failures"),
};
