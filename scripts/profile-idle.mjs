#!/usr/bin/env node
/**
 * Fully automated idle CPU/memory capture for PiChamber.
 *
 * Unlike `profile:browser`, this command needs no human in the loop: it loads
 * the app, lets it settle, then records a window during which no input is
 * delivered. Everything it reports is therefore work the app performs while the
 * user is doing nothing, which is the regression class users notice as fan
 * noise, battery drain, and a permanently busy tab.
 *
 * Reported dimensions (per second of the idle window):
 * - main-thread busy time, script time, style recalculation, layout;
 * - style recalculation and layout counts;
 * - DOM node, document, frame, and JS event listener growth;
 * - JS heap trajectory (start/end/max plus linear growth rate);
 * - CPU sampling profile with self time per function;
 * - scheduled-work attribution per timer/animation-frame/observer call site.
 *
 * Runs are directly comparable: `--baseline <run-directory>` prints a per-metric
 * delta table and exits non-zero when a budget in `--budget-*` is exceeded, so
 * the same command works as an investigation tool and as a regression gate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { buildIdleProbeSource, IDLE_PROBE_GLOBAL } from "./perf/idle-probe.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"
import {
  buildRailSwitchExpression,
  buildRailVerifyExpression,
  normalizeCycleMode,
  summarizeNetworkWindow,
  toNetworkEvent,
} from "./perf/network.mjs"
import { growthPerSecond, metricMap, round } from "./perf/metrics.mjs"

const HELP = `Usage: bun run profile:idle -- [options]

Records what PiChamber does while nobody is interacting with it.

Options:
  --url <url>              PiChamber URL (default: http://localhost:3000)
  --session <id>           Open this session before recording (deep link)
  --tab <name>             Open this main tab before recording
  --then-tab <name>        After settling, navigate to this tab without a
                           reload, then record. Use it to measure what a
                           surface keeps doing after the user leaves it.
  --expand-sessions        Click every "Show more sessions" control until the
                           sidebar has no collapsed session lists left, so all
                           session rows are mounted. Clicks happen before the
                           recording window, which stays input-free.
  --expand-projects        Expand every project in the sidebar before
                           recording, which mounts a row per worktree and
                           session directory
  --panel <mode[=target]>  Open the context panel on this surface before
                           recording (chat, preview, terminal, git, pr, notes,
                           file, diff, plan, context, browser, walkthrough).
                           Repeatable; the first entry becomes the active tab.
  --cycle-panels <a,b,c>  After the idle window, activate each context-panel
                           mode in order (e.g. git,terminal,files) to measure
                           per-switch refetches. Repeats for --cycle-rounds.
  --cycle-rounds <n>      Panel-cycle rounds (default: 3)
  --cycle-dwell-ms <ms>   Wait on each panel mode before switching (default:
                           2000). API requests between activations are
                           attributed to the switch that preceded them.
  --duration <seconds>     Idle recording window (default: 30)
  --settle <seconds>       Wait after load before recording (default: 15)
  --output <directory>     Artifact directory (default: artifacts/idle-profile-<time>)
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Reusable isolated Chrome profile
  --headed                 Show the browser (default: headless)
  --sampling-interval <us> CPU sampler interval in microseconds (default: 200)
  --baseline <directory>   Compare against a previous run directory
  --budget-cpu <percent>   Fail when idle main-thread busy time exceeds this
  --budget-listeners <n>   Fail when net listener growth exceeds this
  --budget-heap <mb>       Fail when heap growth exceeds this
  --budget-requests-per-minute <n>
                           Fail when idle API requests per minute exceeds this
  --json                   Print the summary as JSON instead of a table
  --help                   Show this help

Exit code is non-zero when any provided budget is exceeded.`

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    session: null,
    tab: null,
    thenTab: null,
    panels: [],
    expandProjects: false,
    expandSessions: false,
    duration: 30,
    settle: 15,
    output: null,
    label: null,
    chrome: null,
    profileDir: join(homedir(), ".pichamber", "browser-profile-google-chrome"),
    headless: true,
    samplingInterval: 200,
    baseline: null,
    budgetCpu: null,
    budgetListeners: null,
    budgetHeap: null,
    budgetRequestsPerMinute: null,
    cyclePanels: [],
    cycleRounds: 3,
    cycleDwellMs: 2000,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") return { ...options, help: true }
    else if (value === "--headed") options.headless = false
    else if (value === "--json") options.json = true
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--tab") options.tab = argv[++index]
    else if (value === "--then-tab") options.thenTab = argv[++index]
    else if (value === "--panel") options.panels.push(argv[++index])
    else if (value === "--expand-projects") options.expandProjects = true
    else if (value === "--expand-sessions") options.expandSessions = true
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--duration") options.duration = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = argv[++index]
    else if (value === "--sampling-interval") options.samplingInterval = Number(argv[++index])
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-cpu") options.budgetCpu = Number(argv[++index])
    else if (value === "--budget-listeners") options.budgetListeners = Number(argv[++index])
    else if (value === "--budget-heap") options.budgetHeap = Number(argv[++index])
    else if (value === "--budget-requests-per-minute") options.budgetRequestsPerMinute = Number(argv[++index])
    else if (value === "--cycle-panels") {
      const raw = argv[++index] ?? ""
      for (const entry of raw.split(",")) {
        const trimmed = entry.trim()
        if (trimmed) options.cyclePanels.push(normalizeCycleMode(trimmed))
      }
    }
    else if (value === "--cycle-rounds") options.cycleRounds = Number(argv[++index])
    else if (value === "--cycle-dwell-ms") options.cycleDwellMs = Number(argv[++index])
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error("--duration must be a positive number")
  if (!Number.isFinite(options.settle) || options.settle < 0) throw new Error("--settle must be zero or greater")
  if (!Number.isInteger(options.cycleRounds) || options.cycleRounds <= 0) {
    throw new Error("--cycle-rounds must be a positive integer")
  }
  if (!Number.isFinite(options.cycleDwellMs) || options.cycleDwellMs < 0) {
    throw new Error("--cycle-dwell-ms must be zero or greater")
  }
  if (options.budgetRequestsPerMinute !== null
    && (!Number.isFinite(options.budgetRequestsPerMinute) || options.budgetRequestsPerMinute < 0)) {
    throw new Error("--budget-requests-per-minute must be zero or greater")
  }
  // Deep-link parameters are folded into the URL so the recorded window starts
  // from the requested screen without synthesising input events.
  const target = new URL(options.url)
  if (options.session) target.searchParams.set("session", options.session)
  if (options.tab) target.searchParams.set("tab", options.tab)
  options.url = target.toString()
  return options
}

/**
 * Mirrors `useUIStore`'s context-panel tab identity rules so a seeded tab is
 * indistinguishable from one the user opened. Only `file` and `preview` key
 * their identity by target path; every other surface allows one tab per mode.
 */
const buildPanelTab = (descriptor, touchedAt) => {
  const { mode, targetPath } = descriptor
  const dedupeKey = (mode === "file" || mode === "preview") ? (targetPath || mode) : mode
  return {
    id: dedupeKey === mode ? mode : `${mode}:${dedupeKey}`,
    mode,
    targetPath: targetPath || null,
    dedupeKey,
    label: null,
    sessionTitleFallback: null,
    readOnly: false,
    stagedDiff: false,
    diffScope: "working",
    touchedAt,
  }
}

const parsePanelDescriptor = (value) => {
  const separator = value.indexOf("=")
  if (separator === -1) return { mode: value.trim(), targetPath: null }
  return { mode: value.slice(0, separator).trim(), targetPath: value.slice(separator + 1).trim() || null }
}

/**
 * Opens the context panel by seeding the persisted store the app reads on
 * boot, then reloading. Driving persisted state rather than synthesising
 * clicks keeps the scenario deterministic and keeps the recorded window free
 * of input-driven work that a real idle session would not perform.
 */
const seedContextPanel = async (client, panels, sessionId) => {
  const descriptors = panels.map(parsePanelDescriptor)
  const tabs = descriptors.map((descriptor, index) => buildPanelTab(
    descriptor.mode === "chat" && !descriptor.targetPath ? { ...descriptor, targetPath: sessionId } : descriptor,
    Date.now() + index,
  ))

  const stored = await evaluateValue(client, `JSON.stringify({
    lastDirectory: localStorage.getItem("lastDirectory"),
    uiStore: localStorage.getItem("ui-store"),
  })`)
  const { lastDirectory, uiStore } = JSON.parse(stored ?? "{}")
  if (!lastDirectory) throw new Error("Could not open the context panel: no lastDirectory in browser storage")
  if (!uiStore) throw new Error("Could not open the context panel: no ui-store in browser storage")

  // `lastDirectory` is persisted as a JSON string by some writers and as a raw
  // path by others; accept both rather than guessing.
  let directory = lastDirectory
  try {
    const decoded = JSON.parse(lastDirectory)
    if (typeof decoded === "string") directory = decoded
  } catch {
    // Already a raw path.
  }
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/g, "") || "/"

  const parsed = JSON.parse(uiStore)
  parsed.state = parsed.state ?? {}
  parsed.state.contextPanelByDirectory = parsed.state.contextPanelByDirectory ?? {}
  parsed.state.contextPanelByDirectory[normalized] = {
    isOpen: true,
    expanded: false,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    widthByMode: {},
    touchedAt: Date.now(),
  }

  await evaluateValue(client, `localStorage.setItem("ui-store", ${JSON.stringify(JSON.stringify(parsed))})`)
  console.log(`Context panel seeded for ${normalized}: ${tabs.map((tab) => tab.id).join(", ")}`)
}

const REPORTED_METRICS = [
  { key: "mainThreadBusyPercent", label: "Main-thread busy", unit: "%", lowerIsBetter: true },
  { key: "scriptPercent", label: "Script", unit: "%", lowerIsBetter: true },
  { key: "recalcStylePercent", label: "Style recalc", unit: "%", lowerIsBetter: true },
  { key: "layoutPercent", label: "Layout", unit: "%", lowerIsBetter: true },
  { key: "recalcStylePerSecond", label: "Style recalcs/sec", unit: "", lowerIsBetter: true },
  { key: "layoutsPerSecond", label: "Layouts/sec", unit: "", lowerIsBetter: true },
  { key: "tasksPerSecond", label: "Tasks/sec", unit: "", lowerIsBetter: true },
  { key: "listenerGrowth", label: "Listener growth", unit: "", lowerIsBetter: true },
  { key: "nodeGrowth", label: "DOM node growth", unit: "", lowerIsBetter: true },
  { key: "heapGrowthMbPerSecond", label: "Heap growth", unit: "MB/s", lowerIsBetter: true },
  { key: "heapMaxMb", label: "Heap max", unit: "MB", lowerIsBetter: true },
]

const buildSummary = ({ options, before, after, samples, cpu, probe, elapsedSeconds }) => {
  const delta = (name) => Number(after[name] ?? 0) - Number(before[name] ?? 0)
  const percent = (name) => round((delta(name) / elapsedSeconds) * 100)
  const heapSamples = samples.map((sample) => sample.jsHeapUsedMb)

  return {
    recordedAt: new Date().toISOString(),
    label: options.label,
    url: options.url,
    durationSeconds: round(elapsedSeconds),
    settleSeconds: options.settle,
    metrics: {
      mainThreadBusyPercent: percent("TaskDuration"),
      scriptPercent: percent("ScriptDuration"),
      recalcStylePercent: percent("RecalcStyleDuration"),
      layoutPercent: percent("LayoutDuration"),
      tasksPerSecond: round(delta("TaskCount") / elapsedSeconds),
      recalcStylePerSecond: round(delta("RecalcStyleCount") / elapsedSeconds),
      layoutsPerSecond: round(delta("LayoutCount") / elapsedSeconds),
      listenerStart: Number(before.JSEventListeners ?? 0),
      listenerEnd: Number(after.JSEventListeners ?? 0),
      listenerGrowth: delta("JSEventListeners"),
      listenerGrowthPerSecond: growthPerSecond(samples, "jsEventListeners"),
      nodeStart: Number(before.Nodes ?? 0),
      nodeEnd: Number(after.Nodes ?? 0),
      nodeGrowth: delta("Nodes"),
      documents: Number(after.Documents ?? 0),
      frames: Number(after.Frames ?? 0),
      heapStartMb: round(heapSamples.at(0) ?? 0),
      heapEndMb: round(heapSamples.at(-1) ?? 0),
      heapMaxMb: round(heapSamples.reduce((max, value) => Math.max(max, value), 0)),
      heapGrowthMbPerSecond: growthPerSecond(samples, "jsHeapUsedMb"),
    },
    cpuProfile: cpu,
    scheduledWork: probe,
    samples,
  }
}

const formatRow = (label, value, unit) => `${label.padEnd(22)} ${String(value).padStart(12)} ${unit}`

const formatNetworkPath = (entry) => {
  const names = entry.queryParamNames ?? []
  return names.length > 0 ? `${entry.pathname}{?${names.join(",")}}` : entry.pathname
}

const printNetworkWindow = (title, window, baselineWindow) => {
  console.log(`\n${title} (${window.durationSeconds}s):`)
  console.log(
    `  API requests: ${window.totalApi} (${window.apiPerMinute}/min)`
    + `  Static/other: ${window.totalStatic}  WS opened: ${window.wsOpened}  SSE opened: ${window.sseOpened}`,
  )
  if (window.grouped.length === 0) {
    console.log("  No API requests recorded in this window.")
    return
  }
  console.log(`  ${"Count".padStart(7)}  ${"Distinct".padStart(8)}  ${"Per/min".padStart(7)}  Method  Pathname (query names only, never values)`)
  for (const entry of window.grouped.slice(0, 20)) {
    console.log(
      `  ${String(entry.count).padStart(7)}  ${String(entry.distinct ?? "").padStart(8)}  ${String(entry.perMinute).padStart(7)}  ${(entry.method + " " + formatNetworkPath(entry)).trim()}`,
    )
  }
  if (baselineWindow) {
    const previous = baselineWindow.apiPerMinute
    if (Number.isFinite(previous)) {
      const change = round(window.apiPerMinute - previous)
      const marker = change === 0 ? "" : change < 0 ? "  improved" : "  WORSE"
      console.log(
        `  Baseline API req/min was ${previous}; change ${change > 0 ? "+" : ""}${change}${marker}`,
      )
    }
  }
}

const printPanelCycle = (cycle) => {
  if (!cycle) return
  console.log(`\nPanel cycle — modes ${cycle.modes.join(", ")} x${cycle.rounds} (dwell ${cycle.dwellMs}ms):`)
  console.log(`  Total cycle API requests: ${cycle.total.totalApi}  Static/other: ${cycle.total.totalStatic}`)
  const header = ["Round", ...cycle.modes].map((cell) => String(cell).padStart(10)).join("")
  console.log(`  Per-switch API requests:${"\n    " + header}`)
  for (const row of cycle.perModePerRound.slice(1)) {
    console.log(`    ${row.map((cell) => String(cell).padStart(10)).join("")}`)
  }
  console.log("  Per-mode totals (API requests across all rounds):")
  for (const [mode, totals] of Object.entries(cycle.perMode)) {
    console.log(
      `    ${mode.padEnd(14)} ${String(totals.totalApi).padStart(6)} total  ${String(totals.meanPerSwitch).padStart(6)}/switch over ${totals.switches} switches`,
    )
  }
  console.log(`  ${"Count".padStart(7)}  Method  Pathname (query names only, never values)`)
  for (const entry of cycle.total.grouped.slice(0, 15)) {
    console.log(`  ${String(entry.count).padStart(7)}  ${(entry.method + " " + formatNetworkPath(entry)).trim()}`)
  }
}

/**
 * Switches the live context panel to `mode` through the same right-rail
 * button the user clicks, then verifies an independent DOM signal (rail
 * pressed state plus a laid-out, non-inert panel) before returning. Throws
 * when the switch did not actually happen so a quiet cycle can never pass
 * as a clean measurement.
 */
const switchContextPanelMode = async (client, mode) => {
  const switched = await evaluateValue(client, buildRailSwitchExpression(mode))
  let status
  try {
    status = JSON.parse(switched ?? "null")
  } catch {
    throw new Error(`Could not switch context panel to ${JSON.stringify(mode)}: unreadable rail response`)
  }
  if (!status?.ok) {
    const available = Array.isArray(status?.available) ? status.available.filter(Boolean).join(", ") : ""
    throw new Error(
      `Could not switch context panel to ${JSON.stringify(mode)}`
      + ` (${status?.reason ?? "unknown"})`
      + (available ? `. Rail offers: ${available}` : ". Is the surface visible on the rail?"),
    )
  }
  await wait(600)
  const verified = await evaluateValue(client, buildRailVerifyExpression(mode))
  let state
  try {
    state = JSON.parse(verified ?? "null")
  } catch {
    throw new Error(`Could not verify context panel mode ${JSON.stringify(mode)}: unreadable verify response`)
  }
  if (!state?.pressed || !state?.panelOpen) {
    throw new Error(
      `Context panel switch to ${JSON.stringify(mode)} did not take effect`
      + ` (pressed: ${state?.pressed ?? "unknown"}, panel open: ${state?.panelOpen ?? "unknown"},`
      + ` width: ${state?.panelWidth ?? "unknown"}). The cycle measurement is invalid.`,
    )
  }
  return { clicked: status.clicked !== false, railLabel: status.label ?? null }
}

const printReport = (summary, baseline) => {
  const { metrics } = summary
  console.log(`\nIdle profile — ${summary.durationSeconds}s window at ${summary.url}`)
  if (summary.label) console.log(`Label: ${summary.label}`)
  console.log("")
  for (const metric of REPORTED_METRICS) {
    const current = metrics[metric.key]
    if (!baseline) {
      console.log(formatRow(metric.label, current, metric.unit))
      continue
    }
    const previous = baseline.metrics?.[metric.key]
    const change = Number.isFinite(previous) ? round(current - previous) : null
    const marker = change === null || change === 0
      ? ""
      : (change < 0) === metric.lowerIsBetter ? "  improved" : "  WORSE"
    const changeText = change === null ? "n/a" : `${change > 0 ? "+" : ""}${change}`
    console.log(`${formatRow(metric.label, current, metric.unit).padEnd(42)} was ${String(previous ?? "n/a").padStart(10)}  ${changeText.padStart(9)}${marker}`)
  }

  console.log("\nTop self time while idle:")
  for (const entry of summary.cpuProfile?.topSelfTime?.slice(0, 12) ?? []) {
    console.log(`  ${String(entry.selfMs).padStart(9)} ms  ${String(entry.percentOfBusy).padStart(5)}%  ${entry.function}`)
  }

  console.log("\nTop scheduled-work call sites while idle:")
  for (const entry of summary.scheduledWork?.sites?.slice(0, 12) ?? []) {
    console.log(`  ${String(entry.totalMs).padStart(9)} ms  ${String(entry.calls).padStart(6)}x  ${entry.site}`)
  }

  const counters = summary.scheduledWork?.counters
  if (counters) {
    console.log(
      `\nScheduled during window: timeouts ${counters.setTimeoutScheduled}, intervals ${counters.setIntervalScheduled},`
      + ` frames ${counters.rafScheduled}, listeners +${counters.listenersAdded}/-${counters.listenersRemoved},`
      + ` mutations ${counters.mutationRecords}, resizes ${counters.resizeEntries}, fetches ${counters.fetches}`,
    )
  }

  if (summary.network) {
    if (summary.network.settle) {
      printNetworkWindow("Network requests (settle/startup)", summary.network.settle, baseline?.network?.settle)
    }
    if (summary.network.idle) {
      printNetworkWindow("Network requests (idle)", summary.network.idle, baseline?.network?.idle)
    }
    if (!summary.network.settle && !summary.network.idle) {
      console.log("\nNetwork requests: no data recorded.")
    }
    if (summary.network.livenessWarning) {
      console.warn(`\nWARNING: ${summary.network.livenessWarning}`)
    }
    printPanelCycle(summary.network.cycle)
  }
}

const evaluateBudgets = (summary, options) => {
  const failures = []
  const check = (budget, key, label, unit) => {
    if (!Number.isFinite(budget)) return
    const value = summary.metrics[key]
    if (value > budget) failures.push(`${label} ${value}${unit} exceeds budget ${budget}${unit}`)
  }
  check(options.budgetCpu, "mainThreadBusyPercent", "Idle main-thread busy", "%")
  check(options.budgetListeners, "listenerGrowth", "Listener growth", "")
  check(options.budgetHeap, "heapGrowthMbPerSecond", "Heap growth", "MB/s")
  if (Number.isFinite(options.budgetRequestsPerMinute)) {
    const value = summary.network?.idle?.apiPerMinute
    if (Number.isFinite(value) && value > options.budgetRequestsPerMinute) {
      failures.push(`Idle API requests ${value}/min exceeds budget ${options.budgetRequestsPerMinute}/min`)
    }
  }
  return failures
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const chrome = resolveChrome(options.chrome)
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const output = resolve(options.output ?? join("artifacts", `idle-profile-${timestamp}`))
  const profileDir = resolve(options.profileDir)
  await mkdir(output, { recursive: true })
  await mkdir(profileDir, { recursive: true })

  const baseline = options.baseline
    ? JSON.parse(await readFile(join(resolve(options.baseline), "idle-summary.json"), "utf8"))
    : null

  const port = await reservePort()
  const chromeProcess = launchChrome({ chrome, profileDir, port, headless: options.headless })
  let client
  // Every entry keeps pathname + query parameter NAMES only; values never
  // enter the process output or the artifact (see scripts/perf/network.mjs).
  const networkEvents = []
  const wsOpenedAt = []
  const recordNetworkParams = (params) => {
    networkEvents.push(toNetworkEvent(params, Date.now()))
  }
  const recordWsOpened = () => {
    wsOpenedAt.push(Date.now())
  }
  let settleStartMs = 0
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Performance.enable"),
      client.send("Profiler.enable"),
      client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
    ])
    client.on("Network.requestWillBeSent", recordNetworkParams)
    client.on("Network.webSocketCreated", recordWsOpened)
    settleStartMs = Date.now()
    // Measure the current local build, never a service-worker-cached bundle
    // from an earlier optimization run.
    await client.send("Network.setBypassServiceWorker", { bypass: true })
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: buildIdleProbeSource() })
    // A fixed viewport keeps runs comparable and guarantees a compositor in
    // headless mode, so frame-driven work is measured rather than skipped.
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded

    if (options.expandProjects) {
      await expandProjects(client)
      console.log("Expanded every project in the sidebar.")
    }

    if (options.panels.length > 0 || options.expandProjects) {
      if (options.panels.length > 0) await seedContextPanel(client, options.panels, options.session)
      const reloaded = client.once("Page.loadEventFired", 60_000)
      // The settle/startup network window covers exactly one boot: the
      // reload that applies the seeded state, not the throwaway first load.
      settleStartMs = Date.now()
      await client.send("Page.reload", { ignoreCache: false })
      await reloaded
    }

    console.log(`Loaded ${options.url}; settling for ${options.settle}s before recording.`)
    await wait(options.settle * 1000)

    if (options.expandSessions) {
      const expanded = await expandSessionLists(client)
      console.log(`Expanded ${expanded} collapsed session lists; settling ${options.settle}s again.`)
      await wait(options.settle * 1000)
    }

    await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.start()`)
    await client.send("Profiler.setSamplingInterval", { interval: options.samplingInterval })
    await client.send("Profiler.start")
    const before = metricMap((await client.send("Performance.getMetrics")).metrics)
    const startedAt = Date.now()
    const settleEndMs = startedAt
    const idleStartMs = startedAt

    console.log(`Recording ${options.duration}s of idle time. No input is delivered to the page.`)
    const samples = []
    while (Date.now() - startedAt < options.duration * 1000) {
      await wait(1_000)
      const current = metricMap((await client.send("Performance.getMetrics")).metrics)
      samples.push({
        elapsedSeconds: round((Date.now() - startedAt) / 1000),
        jsHeapUsedMb: round(Number(current.JSHeapUsedSize ?? 0) / (1024 * 1024)),
        jsEventListeners: Number(current.JSEventListeners ?? 0),
        nodes: Number(current.Nodes ?? 0),
        taskDuration: round(Number(current.TaskDuration ?? 0), 3),
      })
    }

    // A renderer that is throttled or occluded reports near-zero rendering work
    // no matter what the page does. Measuring frame liveness turns that failure
    // mode into an explicit warning instead of a falsely clean report.
    const frameLiveness = await evaluateValue(client, `new Promise((resolve) => {
      let frames = 0
      const startedAt = performance.now()
      const tick = () => {
        frames += 1
        if (performance.now() - startedAt < 1000) requestAnimationFrame(tick)
        else resolve({ framesPerSecond: frames, visibilityState: document.visibilityState })
      }
      requestAnimationFrame(tick)
      setTimeout(() => resolve({ framesPerSecond: frames, visibilityState: document.visibilityState }), 2000)
    })`)

    const elapsedSeconds = (Date.now() - startedAt) / 1000
    const idleEndMs = Date.now()
    const after = metricMap((await client.send("Performance.getMetrics")).metrics)
    const { profile } = await client.send("Profiler.stop")
    await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.stop()`)
    const probe = await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.snapshot() ?? null`)

    const summary = buildSummary({
      options,
      before,
      after,
      samples,
      cpu: summarizeCpuProfile(profile),
      probe,
      elapsedSeconds,
    })
    summary.frameLiveness = frameLiveness
    if (Number(frameLiveness?.framesPerSecond ?? 0) < 10) {
      console.warn(
        `\nWARNING: the renderer produced ${frameLiveness?.framesPerSecond ?? 0} frames per second`
        + ` (visibility: ${frameLiveness?.visibilityState ?? "unknown"}). Rendering metrics from this run understate real work.`,
      )
    }

    // The cycle delivers real input (rail clicks), so it always runs after the
    // input-free idle window. Attribution windows start at the activation
    // instant so the refetch burst fired by the click belongs to that switch.
    let cycle = null
    if (options.cyclePanels.length > 0) {
      console.log(
        `Cycling context-panel modes ${options.cyclePanels.join(", ")} x${options.cycleRounds}`
        + ` with ${options.cycleDwellMs}ms dwell per switch.`,
      )
      const marks = []
      const cycleStartMs = Date.now()
      for (let currentRound = 1; currentRound <= options.cycleRounds; currentRound += 1) {
        for (const mode of options.cyclePanels) {
          const activationAt = Date.now()
          const switched = await switchContextPanelMode(client, mode)
          marks.push({
            round: currentRound,
            mode,
            startedAt: activationAt,
            clicked: switched.clicked,
            railLabel: switched.railLabel,
          })
          console.log(`  round ${currentRound}/${options.cycleRounds}: ${mode}${switched.clicked ? "" : " (already active)"}`)
          await wait(options.cycleDwellMs)
        }
      }
      const cycleEndMs = Date.now()
      const switches = marks.map((mark, index) => {
        const window = summarizeNetworkWindow(
          networkEvents,
          wsOpenedAt,
          mark.startedAt,
          marks[index + 1]?.startedAt ?? cycleEndMs,
        )
        return {
          index,
          round: mark.round,
          mode: mark.mode,
          clicked: mark.clicked,
          startedAt: new Date(mark.startedAt).toISOString(),
          apiRequests: window.totalApi,
          totalRequests: window.totalRequests,
          wsOpened: window.wsOpened,
        }
      })
      const perMode = {}
      for (const mode of options.cyclePanels) {
        const modeSwitches = switches.filter((entry) => entry.mode === mode)
        const totalApi = modeSwitches.reduce((total, entry) => total + entry.apiRequests, 0)
        perMode[mode] = {
          switches: modeSwitches.length,
          totalApi,
          meanPerSwitch: modeSwitches.length > 0 ? Number((totalApi / modeSwitches.length).toFixed(1)) : 0,
          perRound: Array.from({ length: options.cycleRounds }, (_, roundIndex) =>
            switches
              .filter((entry) => entry.round === roundIndex + 1 && entry.mode === mode)
              .reduce((total, entry) => total + entry.apiRequests, 0)),
        }
      }
      cycle = {
        modes: [...options.cyclePanels],
        rounds: options.cycleRounds,
        dwellMs: options.cycleDwellMs,
        switches,
        perMode,
        perModePerRound: [
          ["Round", ...options.cyclePanels],
          ...Array.from({ length: options.cycleRounds }, (_, roundIndex) => [
            roundIndex + 1,
            ...options.cyclePanels.map((mode) => perMode[mode]?.perRound[roundIndex] ?? 0),
          ]),
        ],
        total: summarizeNetworkWindow(networkEvents, wsOpenedAt, cycleStartMs, cycleEndMs),
      }
    }

    summary.network = {
      instrument: "cdp-Network.requestWillBeSent",
      settle: summarizeNetworkWindow(networkEvents, wsOpenedAt, settleStartMs, settleEndMs),
      idle: summarizeNetworkWindow(networkEvents, wsOpenedAt, idleStartMs, idleEndMs),
      ...(cycle ? { cycle } : {}),
    }
    if (networkEvents.length === 0 && wsOpenedAt.length === 0) {
      // Page load always issues requests; zero events means the Network
      // domain never delivered, not a quiet app. Keep the artifact but say so.
      summary.network.livenessWarning =
        "the Network domain recorded no requests during load, settle, or idle;"
        + " the network section below is a disabled instrument, not a quiet app."
        + " Check the Chrome build and the Network.enable dispatch before trusting it."
      console.warn(`\nWARNING: ${summary.network.livenessWarning}`)
    }

    await writeFile(join(output, "idle-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))

    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printReport(summary, baseline)
    console.log(`\nSaved to ${output}`)

    const failures = evaluateBudgets(summary, options)
    if (failures.length > 0) {
      console.error(`\nBudget failures:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
      process.exitCode = 1
    }
  } finally {
    client?.close()
    if (!chromeProcess.killed) chromeProcess.kill("SIGTERM")
  }
}

main().catch((error) => {
  console.error(`Idle profiling failed: ${error.message}`)
  process.exitCode = 1
})
