import { sha256 } from "../../core/canonical"
import type { TrajectoryConverter } from "../../core/document-plan"
import type { DocumentPlan, DocumentSpec } from "../../types/migration"
import type { PreparedTrajectory, PreparedTrajectoryState } from "./types"

export const STRUCTURED_ACCESSIBILITY_CONVERTER_NAME = "Structured Accessibility Converter"
export const STRUCTURED_ACCESSIBILITY_CONVERTER_VERSION = 1
export const STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT = "structured-accessibility-v1"

// Source oracle: LongMemEval-V2 feat/supermemory@2fa6616, Approach_1.py.
export const LEGACY_APPROACH_1_SOURCE_SHA256 =
  "22cff05fafa9f882040afa8296439da0f911f800c107424de105ab3af5e69236"

const NODE_ID_PREFIX = /^\s*\[[^\]]+\]\s*/
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu
const ESCAPED_PRIVATE_USE = /\\u(?:[eEfF][0-9a-fA-F]{3})/g

const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "main",
  "row",
  "rowgroup",
  "list",
  "listbox",
  "menu",
  "toolbar",
])
const TABLE_ROLES = new Set(["table", "grid", "treegrid"])
const TABLE_CELL_ROLES = new Set(["gridcell", "cell", "rowheader"])
const LANDMARK_ROLES = new Set(["dialog", "form", "navigation", "region", "tabpanel", "tablist"])
const ALERT_ROLES = new Set(["alert", "status", "log", "marquee", "timer"])
const CONTROL_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "textbox",
  "searchbox",
  "combobox",
  "switch",
  "slider",
  "spinbutton",
])
const STATE_ATTRIBUTE_NAMES = [
  "value",
  "placeholder",
  "checked",
  "selected",
  "expanded",
  "disabled",
  "required",
  "pressed",
  "level",
  "live",
  "hasPopup",
  "autocomplete",
] as const

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  divide: "÷",
  euro: "€",
  gt: ">",
  GT: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  LT: "<",
  mdash: "—",
  middot: "·",
  nbsp: "\u00a0",
  ndash: "–",
  quot: '"',
  QUOT: '"',
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  times: "×",
  trade: "™",
}

const WINDOWS_1252_NUMERIC_REFERENCES: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
}

const HTML_ENTITY_EXPRESSION = new RegExp(
  `&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|${Object.keys(NAMED_HTML_ENTITIES)
    .sort((left, right) => right.length - left.length)
    .join("|")});?`,
  "g"
)

export interface StructuredAccessibilityNode {
  role: string
  label: string
  attributes: string[]
  indent: number
}

export interface StructuredAccessibilityTable {
  title: string
  headers: string[]
  rows: string[][]
}

export interface StructuredAccessibilityEvidence {
  pageTitles: string[]
  landmarks: StructuredAccessibilityNode[]
  alerts: StructuredAccessibilityNode[]
  headings: StructuredAccessibilityNode[]
  options: StructuredAccessibilityNode[]
  checkboxes: StructuredAccessibilityNode[]
  radios: StructuredAccessibilityNode[]
  controls: StructuredAccessibilityNode[]
  other: StructuredAccessibilityNode[]
  tables: StructuredAccessibilityTable[]
  unparsedLines: string[]
}

function decodeNumericReference(raw: string): string {
  const hexadecimal = raw[1] === "x" || raw[1] === "X"
  const parsed = Number.parseInt(raw.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
  if (!Number.isFinite(parsed)) return `&${raw};`
  const codePoint = WINDOWS_1252_NUMERIC_REFERENCES[parsed] ?? parsed
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "\ufffd"
  }
  return String.fromCodePoint(codePoint)
}

function unescapeHtml(text: string): string {
  return text.replace(HTML_ENTITY_EXPRESSION, (_match, entity: string) =>
    entity.startsWith("#") ? decodeNumericReference(entity) : NAMED_HTML_ENTITIES[entity]
  )
}

export function cleanAccessibilityText(value: unknown): string {
  const text = unescapeHtml(String(value || ""))
    .replace(PRIVATE_USE, "")
    .replace(ESCAPED_PRIVATE_USE, "")
    .normalize("NFC")
  return text.replace(/\s+/gu, " ").trim()
}

function caseFoldCharacter(character: string): string {
  if (character === "ß" || character === "ẞ") return "ss"
  if (character === "ς") return "σ"
  return character.toLowerCase()
}

function normalizationKey(value: string): string {
  const output: string[] = []
  for (const character of value) {
    output.push(/[\p{L}\p{N}]/u.test(character) ? caseFoldCharacter(character) : " ")
  }
  return output.join("").split(/\s+/u).filter(Boolean).join(" ")
}

function orderedUniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const key = normalizationKey(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(value)
  }
  return output
}

function orderedUniqueNodes(nodes: StructuredAccessibilityNode[]): StructuredAccessibilityNode[] {
  const seen = new Set<string>()
  const output: StructuredAccessibilityNode[] = []
  for (const node of nodes) {
    const key = JSON.stringify([
      node.role.toLowerCase(),
      normalizationKey(node.label),
      node.attributes,
    ])
    if (seen.has(key)) continue
    seen.add(key)
    output.push(node)
  }
  return output
}

function quotedValue(text: string, quoteIndex: number): [string, number] | undefined {
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    if (text[index] !== "'") continue
    const suffix = text.slice(index + 1)
    if (!suffix || suffix.startsWith(",")) {
      return [text.slice(quoteIndex + 1, index), index]
    }
  }
  return undefined
}

function attributeValue(line: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=`).exec(line)
  if (!match || match.index === undefined) return undefined
  const start = match.index + match[0].length
  if (start >= line.length) return ""
  if (line[start] === "'") {
    const quoted = quotedValue(line, start)
    return quoted ? quoted[0] : line.slice(start + 1)
  }
  let end = start
  while (end < line.length && ![",", " ", "\t"].includes(line[end])) {
    end += 1
  }
  return line.slice(start, end)
}

function expandedIndent(prefix: string): number {
  let column = 0
  for (const character of prefix) {
    if (character === "\t") {
      column += 2 - (column % 2)
    } else {
      column += 1
    }
  }
  return column
}

function parseNode(rawLine: string): StructuredAccessibilityNode | undefined {
  const prefix = /^[\t ]*/.exec(rawLine)?.[0] ?? ""
  const indent = expandedIndent(prefix)
  const line = rawLine.replace(NODE_ID_PREFIX, "").trim()
  if (!line) return undefined
  const roleMatch = /^([A-Za-z][A-Za-z0-9_-]*)\b/.exec(line)
  if (!roleMatch) return undefined
  const role = roleMatch[1]
  const quoteIndex = line.indexOf("'", roleMatch[0].length)
  if (quoteIndex < 0) return undefined
  const quoted = quotedValue(line, quoteIndex)
  if (!quoted) return undefined
  const attributes: string[] = []
  for (const name of STATE_ATTRIBUTE_NAMES) {
    const value = attributeValue(line, name)
    if (value === undefined) continue
    const cleaned = cleanAccessibilityText(value)
    if (cleaned || value === "") {
      attributes.push(`${name}=${cleaned || "(empty)"}`)
    }
  }
  return {
    role,
    label: cleanAccessibilityText(quoted[0]),
    attributes,
    indent,
  }
}

function cleanHeader(label: string): string {
  const cleaned = cleanAccessibilityText(label).replace(/\s+column options$/i, "")
  const words = cleaned.split(" ")
  for (let splitAt = 1; splitAt < words.length; splitAt += 1) {
    const left = words.slice(0, splitAt).join(" ")
    const right = words.slice(splitAt).join(" ")
    if (normalizationKey(left) === normalizationKey(right)) return left
  }
  return cleaned || "(unnamed column)"
}

function tableCell(label: string): string {
  return cleanAccessibilityText(label) || "(empty)"
}

export function parseStructuredAccessibilityTree(tree: string): StructuredAccessibilityEvidence {
  const generalNodes: StructuredAccessibilityNode[] = []
  const unparsedLines: string[] = []
  const tables: StructuredAccessibilityTable[] = []
  let activeRowIndent: number | undefined
  let activeHeaders: string[] = []
  let activeCells: string[] = []
  let currentHeaders: string[] = []
  let currentTableTitle = "Visible table"

  const flushRow = (): void => {
    if (activeHeaders.length > 0) {
      currentHeaders = activeHeaders.map(cleanHeader)
    }
    if (activeCells.length > 0) {
      const row = activeCells.map(tableCell)
      const last = tables.at(-1)
      if (
        !last ||
        JSON.stringify(last.headers) !== JSON.stringify(currentHeaders) ||
        last.title !== currentTableTitle
      ) {
        tables.push({
          title: currentTableTitle,
          headers: [...currentHeaders],
          rows: [],
        })
      }
      tables.at(-1)!.rows.push(row)
    }
    activeRowIndent = undefined
    activeHeaders = []
    activeCells = []
  }

  for (const rawLine of tree.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
    const node = parseNode(rawLine)
    if (!node) {
      const stripped = cleanAccessibilityText(rawLine.replace(NODE_ID_PREFIX, ""))
      if (stripped && (rawLine.includes("'") || rawLine.includes("value="))) {
        unparsedLines.push(stripped)
      }
      continue
    }

    if (activeRowIndent !== undefined && node.indent <= activeRowIndent) {
      flushRow()
    }

    const role = node.role.toLowerCase()
    if (role === "row") {
      flushRow()
      activeRowIndent = node.indent
      continue
    }

    if (activeRowIndent !== undefined && node.indent > activeRowIndent) {
      if (role === "columnheader") {
        activeHeaders.push(node.label)
      } else if (TABLE_CELL_ROLES.has(role)) {
        activeCells.push(node.label)
      }
      continue
    }

    if (TABLE_ROLES.has(role)) {
      flushRow()
      currentHeaders = []
      currentTableTitle = node.label || "Visible table"
      continue
    }
    if (role === "rowgroup") continue
    generalNodes.push(node)
  }
  flushRow()

  const pageTitles = orderedUniqueStrings(
    generalNodes
      .filter((node) => node.role.toLowerCase() === "rootwebarea" && node.label)
      .map((node) => node.label)
  )
  const landmarks: StructuredAccessibilityNode[] = []
  const alerts: StructuredAccessibilityNode[] = []
  const headings: StructuredAccessibilityNode[] = []
  const options: StructuredAccessibilityNode[] = []
  const checkboxes: StructuredAccessibilityNode[] = []
  const radios: StructuredAccessibilityNode[] = []
  const controls: StructuredAccessibilityNode[] = []
  const otherNonStatic: StructuredAccessibilityNode[] = []
  const staticNodes: StructuredAccessibilityNode[] = []

  for (const node of generalNodes) {
    const role = node.role.toLowerCase()
    if (role === "rootwebarea") {
      continue
    } else if (LANDMARK_ROLES.has(role)) {
      if (node.label || node.attributes.length > 0) landmarks.push(node)
    } else if (
      ALERT_ROLES.has(role) ||
      node.attributes.some((value) => value.startsWith("live="))
    ) {
      if (node.label || node.attributes.length > 0) alerts.push(node)
    } else if (role === "heading") {
      headings.push(node)
    } else if (role === "option") {
      options.push(node)
    } else if (role === "checkbox") {
      checkboxes.push(node)
    } else if (role === "radio") {
      radios.push(node)
    } else if (CONTROL_ROLES.has(role)) {
      controls.push(node)
    } else if (role === "statictext") {
      if (node.label) staticNodes.push(node)
    } else if (!STRUCTURAL_ROLES.has(role) && (node.label || node.attributes.length > 0)) {
      otherNonStatic.push(node)
    }
  }

  const representedLabels = new Set(
    [
      ...landmarks,
      ...alerts,
      ...headings,
      ...options,
      ...checkboxes,
      ...radios,
      ...controls,
      ...otherNonStatic,
    ]
      .filter((node) => node.label)
      .map((node) => normalizationKey(node.label))
  )
  const other = [...otherNonStatic]
  for (const node of staticNodes) {
    const key = normalizationKey(node.label)
    if (key && !representedLabels.has(key)) {
      representedLabels.add(key)
      other.push(node)
    }
  }

  return {
    pageTitles,
    landmarks: orderedUniqueNodes(landmarks),
    alerts: orderedUniqueNodes(alerts),
    headings: orderedUniqueNodes(headings),
    options,
    checkboxes,
    radios,
    controls: orderedUniqueNodes(controls),
    other: orderedUniqueNodes(other),
    tables,
    unparsedLines: orderedUniqueStrings(unparsedLines),
  }
}

function formatNode(node: StructuredAccessibilityNode): string {
  const label = node.label || "(unnamed)"
  const suffix = node.attributes.length > 0 ? ` [${node.attributes.join(", ")}]` : ""
  return `- ${node.role}: ${label}${suffix}`
}

function appendNodes(lines: string[], heading: string, nodes: StructuredAccessibilityNode[]): void {
  if (nodes.length === 0) return
  lines.push("", heading, ...nodes.map(formatNode))
}

function appendCompleteCollection(
  lines: string[],
  heading: string,
  collectionName: string,
  nodes: StructuredAccessibilityNode[]
): void {
  if (nodes.length === 0) return
  lines.push(
    "",
    heading,
    `Observed ${collectionName} count: ${nodes.length}`,
    `Completeness scope: all ${collectionName} roles in this captured snapshot.`,
    ...nodes.map(formatNode)
  )
}

function appendTables(lines: string[], tables: StructuredAccessibilityTable[]): void {
  tables.forEach((table, tableIndex) => {
    lines.push("", `## TABLE ${tableIndex + 1}: ${table.title}`)
    if (table.headers.length > 0) {
      lines.push(`Visible columns (${table.headers.length}) in order: ${table.headers.join(" | ")}`)
    } else {
      lines.push("Visible column labels were unavailable for this table.")
    }
    lines.push(
      `Visible row count: ${table.rows.length}`,
      "Completeness scope: visible rows in this captured snapshot, not the full paginated dataset."
    )
    table.rows.forEach((row, rowIndex) => {
      lines.push(`### Record ${rowIndex + 1}`)
      if (table.headers.length > 0 && table.headers.length === row.length) {
        table.headers.forEach((header, index) => {
          lines.push(`- ${header}: ${row[index]}`)
        })
      } else {
        lines.push(
          `Schema mismatch: ${table.headers.length} visible headers and ${row.length} visible cells; values are preserved without inferred bindings.`
        )
        row.forEach((value, index) => {
          lines.push(`- Ordered cell ${index + 1}: ${value}`)
        })
      }
    })
  })
}

function baseDocument(
  input: Omit<
    DocumentSpec,
    | "sourceStateIndices"
    | "localAttachmentPaths"
    | "dependsOn"
    | "allowParallelUpload"
    | "allowDuplicateContent"
  > &
    Partial<Pick<DocumentSpec, "sourceStateIndices" | "stateIndex" | "step" | "screenshotRef">>
): DocumentSpec {
  return {
    ...input,
    sourceStateIndices: input.sourceStateIndices ?? [],
    localAttachmentPaths: [],
    dependsOn: [],
    allowParallelUpload: true,
    allowDuplicateContent: false,
  }
}

function overviewDocument(trajectory: PreparedTrajectory): DocumentSpec {
  const content = [
    "# STATE_-1: TRAJECTORY OVERVIEW",
    `Trajectory ID: ${trajectory.id}`,
    `Domain: ${trajectory.domain}`,
    `Start URL: ${trajectory.startUrl}`,
    "Document role: requested goal only; this is not proof that the task succeeded.",
    "",
    "## Requested goal",
    trajectory.goal,
  ].join("\n")
  return baseDocument({
    logicalDocumentId: "overview",
    content,
    metadata: {
      evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
      sequenceIndex: -1,
      contentRole: "trajectory_goal",
    },
    documentType: "overview",
  })
}

function stateDocument(
  trajectory: PreparedTrajectory,
  state: PreparedTrajectoryState
): DocumentSpec {
  const evidence = parseStructuredAccessibilityTree(state.accessibilityTree || "")
  const lines = [
    `# STATE_${state.stateIndex}: STRUCTURED UI OBSERVATION`,
    `Trajectory ID: ${trajectory.id}`,
    `State index: ${state.stateIndex}`,
    `Step: ${state.step}`,
    `URL: ${state.url}`,
    "Document role: UI observed at this state, followed by an unverified interpretation and attempted action.",
    "",
    "## Agent interpretation or next-step plan (unverified)",
    state.thoughts || "No agent interpretation was recorded.",
    "",
    "## Action issued after this observation (attempted, not proof of success)",
    state.action || "No action was issued from this state.",
    "",
    "## Observed accessibility evidence",
    `Page titles: ${evidence.pageTitles.length > 0 ? evidence.pageTitles.join(" | ") : "unknown"}`,
  ]
  appendNodes(lines, "## Page landmarks and dialogs", evidence.landmarks)
  appendNodes(lines, "## Alerts and status messages", evidence.alerts)
  appendNodes(lines, "## Headings", evidence.headings)
  appendCompleteCollection(lines, "## COMPLETE COLLECTION: options", "option", evidence.options)
  appendCompleteCollection(
    lines,
    "## COMPLETE COLLECTION: checkboxes",
    "checkbox",
    evidence.checkboxes
  )
  appendCompleteCollection(lines, "## COMPLETE COLLECTION: radio choices", "radio", evidence.radios)
  appendNodes(lines, "## Interactive controls", evidence.controls)
  appendTables(lines, evidence.tables)
  appendNodes(lines, "## Other exact visible evidence", evidence.other)
  if (evidence.unparsedLines.length > 0) {
    lines.push(
      "",
      "## Residual labelled accessibility evidence",
      "These source lines were preserved because they contained labelled or valued evidence that was not structurally classified.",
      ...evidence.unparsedLines.map((line) => `- ${line}`)
    )
  }
  if (
    [
      evidence.pageTitles,
      evidence.landmarks,
      evidence.alerts,
      evidence.headings,
      evidence.options,
      evidence.checkboxes,
      evidence.radios,
      evidence.controls,
      evidence.tables,
      evidence.other,
      evidence.unparsedLines,
    ].every((items) => items.length === 0)
  ) {
    lines.push("No named accessibility evidence was captured in this snapshot.")
  }

  return baseDocument({
    logicalDocumentId: `state-${state.stateIndex.toString().padStart(4, "0")}`,
    content: lines.join("\n"),
    metadata: {
      evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
      sequenceIndex: state.stateIndex,
      contentRole: "ui_state_transition",
    },
    sourceStateIndices: [state.stateIndex],
    documentType: "state",
    stateIndex: state.stateIndex,
    step: state.step,
    screenshotRef: state.screenshot,
  })
}

function resultDocument(trajectory: PreparedTrajectory): DocumentSpec {
  const finalStateIndex = Math.max(...trajectory.states.map((state) => state.stateIndex))
  const content = [
    "# RESULT: TRAJECTORY OUTCOME",
    `Trajectory ID: ${trajectory.id}`,
    "Document role: final runner outcome only; it does not restate the goal or override observed UI facts.",
    `Final outcome: ${trajectory.outcome ?? "unknown"}`,
  ].join("\n")
  return baseDocument({
    logicalDocumentId: "result",
    content,
    metadata: {
      evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
      sequenceIndex: finalStateIndex + 1,
      contentRole: "trajectory_outcome",
    },
    documentType: "result",
  })
}

export const STRUCTURED_ACCESSIBILITY_INVARIANTS = [
  "the goal appears only in the overview document",
  "the final outcome appears only in the result document",
  "one logical document is produced per observed state",
  "agent thoughts, attempted actions, and observed UI evidence are explicitly separated",
  "complete option, checkbox, and radio collections preserve displayed order and count",
  "table values are bound to headers only when their cardinalities match",
  "documents inside one trajectory have no causal dependencies",
  "all documents for one trajectory are submitted in one V3 batch",
  "no trajectory receives ingestion context from any other trajectory",
  "independent trajectories may be processed concurrently",
  "no cross-state persistent-shell deduplication is performed",
  "the benchmark question and gold answer are never used",
] as const

function convertPreparedTrajectory(trajectory: PreparedTrajectory): DocumentPlan {
  if (!trajectory.id) throw new Error("trajectory id must not be empty")
  if (trajectory.states.length === 0) {
    throw new Error(`trajectory ${trajectory.id} must contain at least one state`)
  }
  const states = [...trajectory.states].sort((left, right) => left.stateIndex - right.stateIndex)
  const seenStateIndexes = new Set<number>()
  for (const state of states) {
    if (!Number.isInteger(state.stateIndex) || state.stateIndex < 0) {
      throw new Error(`trajectory ${trajectory.id} stateIndex must be an integer >= 0`)
    }
    if (seenStateIndexes.has(state.stateIndex)) {
      throw new Error(`trajectory ${trajectory.id} has duplicate stateIndex ${state.stateIndex}`)
    }
    seenStateIndexes.add(state.stateIndex)
  }

  return {
    trajectoryId: trajectory.id,
    documents: [
      overviewDocument(trajectory),
      ...states.map((state) => stateDocument(trajectory, state)),
      resultDocument(trajectory),
    ],
    batchUpload: true,
    declaredInvariants: [...STRUCTURED_ACCESSIBILITY_INVARIANTS],
    notes:
      "Independent V3 batch per trajectory with structured accessibility documents and no state-level or cross-trajectory ingestion context.",
  }
}

const IMPLEMENTATION_FUNCTIONS = [
  decodeNumericReference,
  unescapeHtml,
  cleanAccessibilityText,
  caseFoldCharacter,
  normalizationKey,
  orderedUniqueStrings,
  orderedUniqueNodes,
  quotedValue,
  attributeValue,
  expandedIndent,
  parseNode,
  cleanHeader,
  tableCell,
  parseStructuredAccessibilityTree,
  formatNode,
  appendNodes,
  appendCompleteCollection,
  appendTables,
  baseDocument,
  overviewDocument,
  stateDocument,
  resultDocument,
  convertPreparedTrajectory,
]

export const STRUCTURED_ACCESSIBILITY_CONVERTER_SOURCE_HASH = sha256(
  [
    LEGACY_APPROACH_1_SOURCE_SHA256,
    STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
    JSON.stringify(NAMED_HTML_ENTITIES),
    JSON.stringify(WINDOWS_1252_NUMERIC_REFERENCES),
    JSON.stringify(STATE_ATTRIBUTE_NAMES),
    JSON.stringify([...STRUCTURAL_ROLES]),
    JSON.stringify([...TABLE_ROLES]),
    JSON.stringify([...TABLE_CELL_ROLES]),
    JSON.stringify([...LANDMARK_ROLES]),
    JSON.stringify([...ALERT_ROLES]),
    JSON.stringify([...CONTROL_ROLES]),
    JSON.stringify(STRUCTURED_ACCESSIBILITY_INVARIANTS),
    ...IMPLEMENTATION_FUNCTIONS.map((implementation) => implementation.toString()),
  ].join("\0")
)

export class StructuredAccessibilityConverter implements TrajectoryConverter<
  PreparedTrajectory,
  void
> {
  readonly name = STRUCTURED_ACCESSIBILITY_CONVERTER_NAME
  readonly version = STRUCTURED_ACCESSIBILITY_CONVERTER_VERSION
  readonly sourceHash = STRUCTURED_ACCESSIBILITY_CONVERTER_SOURCE_HASH

  convert(trajectory: PreparedTrajectory, _context: void): DocumentPlan {
    return convertPreparedTrajectory(trajectory)
  }
}

export const structuredAccessibilityConverter = new StructuredAccessibilityConverter()
