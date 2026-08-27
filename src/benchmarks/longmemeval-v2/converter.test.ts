import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createPhysicalDocuments, validateDocumentPlan } from "../../core/document-plan"
import type { AssetRef } from "../../types/migration"
import {
  cleanAccessibilityText,
  LEGACY_APPROACH_1_SOURCE_SHA256,
  parseStructuredAccessibilityTree,
  STRUCTURED_ACCESSIBILITY_CONVERTER_NAME,
  STRUCTURED_ACCESSIBILITY_CONVERTER_SOURCE_HASH,
  STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
  STRUCTURED_ACCESSIBILITY_INVARIANTS,
  structuredAccessibilityConverter,
} from "./converter"
import type { PreparedTrajectory } from "./types"

function screenshot(assetId: string): AssetRef {
  return {
    assetId,
    kind: "trajectory-screenshot",
    absolutePath: fileURLToPath(import.meta.url),
    relativePath: `screenshots/${assetId}.png`,
    mimeType: "image/png",
    sha256: assetId.padEnd(64, "0").slice(0, 64),
    byteLength: 100,
  }
}

function trajectory(overrides: Partial<PreparedTrajectory> = {}): PreparedTrajectory {
  return {
    id: "trajectory-1",
    domain: "enterprise",
    goal: "Find the overdue invoice.",
    startUrl: "https://example.test/start",
    outcome: "Invoice 42 was found.",
    states: [
      {
        stateIndex: 0,
        step: 3,
        url: "https://example.test/invoices",
        thoughts: "I should inspect the visible invoice list.",
        action: "click('Invoices')",
        accessibilityTree: [
          "[1] RootWebArea 'Admin &amp; Billing'",
          "  [2] dialog 'Invoice editor'",
          "  [3] status 'Saved', live=polite",
          "  [4] heading 'Invoices', level=2",
          "  [5] option 'Open', selected=true",
          "  [6] option 'Open', selected=false",
          "  [7] checkbox 'Paid', checked=false",
          "  [8] radio 'Card', checked=true",
          "  [9] button 'Submit', disabled=false",
          "  [10] StaticText 'Invoice #42'",
        ].join("\n"),
        screenshot: screenshot("state-0"),
      },
    ],
    contentHash: "trajectory-content-hash",
    ...overrides,
  }
}

describe("Structured Accessibility Converter", () => {
  test("emits the exact independent overview, state, and result documents", () => {
    const input = trajectory()
    const original = structuredClone(input)
    const plan = structuredAccessibilityConverter.convert(input, undefined)

    expect(input).toEqual(original)
    expect(structuredAccessibilityConverter.name).toBe(STRUCTURED_ACCESSIBILITY_CONVERTER_NAME)
    expect(structuredAccessibilityConverter.version).toBe(1)
    expect(LEGACY_APPROACH_1_SOURCE_SHA256).toBe(
      "22cff05fafa9f882040afa8296439da0f911f800c107424de105ab3af5e69236"
    )
    expect(STRUCTURED_ACCESSIBILITY_CONVERTER_SOURCE_HASH).toBe(
      "3e3d367fa0c691059f586f3c3ee65725dc678afaef98c8b854842bb9d7c5e716"
    )
    expect(plan.trajectoryId).toBe("trajectory-1")
    expect(plan.batchUpload).toBe(true)
    expect(plan.declaredInvariants).toEqual([...STRUCTURED_ACCESSIBILITY_INVARIANTS])
    expect(plan.notes).toBe(
      "Independent V3 batch per trajectory with structured accessibility documents and no state-level or cross-trajectory ingestion context."
    )
    expect(plan.documents).toHaveLength(3)
    expect(
      plan.documents.every(
        (document) => document.dependsOn.length === 0 && document.allowParallelUpload
      )
    ).toBe(true)

    expect(plan.documents[0]).toEqual({
      logicalDocumentId: "overview",
      content: [
        "# STATE_-1: TRAJECTORY OVERVIEW",
        "Trajectory ID: trajectory-1",
        "Domain: enterprise",
        "Start URL: https://example.test/start",
        "Document role: requested goal only; this is not proof that the task succeeded.",
        "",
        "## Requested goal",
        "Find the overdue invoice.",
      ].join("\n"),
      metadata: {
        evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
        sequenceIndex: -1,
        contentRole: "trajectory_goal",
      },
      documentType: "overview",
      sourceStateIndices: [],
      localAttachmentPaths: [],
      dependsOn: [],
      allowParallelUpload: true,
      allowDuplicateContent: false,
    })

    expect(plan.documents[1]).toEqual({
      logicalDocumentId: "state-0000",
      content: [
        "# STATE_0: STRUCTURED UI OBSERVATION",
        "Trajectory ID: trajectory-1",
        "State index: 0",
        "Step: 3",
        "URL: https://example.test/invoices",
        "Document role: UI observed at this state, followed by an unverified interpretation and attempted action.",
        "",
        "## Agent interpretation or next-step plan (unverified)",
        "I should inspect the visible invoice list.",
        "",
        "## Action issued after this observation (attempted, not proof of success)",
        "click('Invoices')",
        "",
        "## Observed accessibility evidence",
        "Page titles: Admin & Billing",
        "",
        "## Page landmarks and dialogs",
        "- dialog: Invoice editor",
        "",
        "## Alerts and status messages",
        "- status: Saved [live=polite]",
        "",
        "## Headings",
        "- heading: Invoices [level=2]",
        "",
        "## COMPLETE COLLECTION: options",
        "Observed option count: 2",
        "Completeness scope: all option roles in this captured snapshot.",
        "- option: Open [selected=true]",
        "- option: Open [selected=false]",
        "",
        "## COMPLETE COLLECTION: checkboxes",
        "Observed checkbox count: 1",
        "Completeness scope: all checkbox roles in this captured snapshot.",
        "- checkbox: Paid [checked=false]",
        "",
        "## COMPLETE COLLECTION: radio choices",
        "Observed radio count: 1",
        "Completeness scope: all radio roles in this captured snapshot.",
        "- radio: Card [checked=true]",
        "",
        "## Interactive controls",
        "- button: Submit [disabled=false]",
        "",
        "## Other exact visible evidence",
        "- StaticText: Invoice #42",
      ].join("\n"),
      metadata: {
        evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
        sequenceIndex: 0,
        contentRole: "ui_state_transition",
      },
      sourceStateIndices: [0],
      documentType: "state",
      stateIndex: 0,
      step: 3,
      screenshotRef: input.states[0].screenshot,
      localAttachmentPaths: [],
      dependsOn: [],
      allowParallelUpload: true,
      allowDuplicateContent: false,
    })

    expect(plan.documents[2]).toEqual({
      logicalDocumentId: "result",
      content: [
        "# RESULT: TRAJECTORY OUTCOME",
        "Trajectory ID: trajectory-1",
        "Document role: final runner outcome only; it does not restate the goal or override observed UI facts.",
        "Final outcome: Invoice 42 was found.",
      ].join("\n"),
      metadata: {
        evidenceFormat: STRUCTURED_ACCESSIBILITY_EVIDENCE_FORMAT,
        sequenceIndex: 1,
        contentRole: "trajectory_outcome",
      },
      documentType: "result",
      sourceStateIndices: [],
      localAttachmentPaths: [],
      dependsOn: [],
      allowParallelUpload: true,
      allowDuplicateContent: false,
    })

    expect(structuredAccessibilityConverter.convert(input, undefined)).toEqual(plan)
  })

  test("sorts states, keeps goal/outcome isolated, and uses empty-value fallbacks", () => {
    const firstScreenshot = screenshot("first")
    const secondScreenshot = screenshot("second")
    const plan = structuredAccessibilityConverter.convert(
      trajectory({
        outcome: null,
        states: [
          {
            stateIndex: 4,
            step: 9,
            url: "https://example.test/four",
            thoughts: "",
            action: "",
            accessibilityTree: "generic 'container'",
            screenshot: secondScreenshot,
          },
          {
            stateIndex: 2,
            step: 5,
            url: "https://example.test/two",
            thoughts: null,
            action: null,
            accessibilityTree: "",
            screenshot: firstScreenshot,
          },
        ],
      }),
      undefined
    )

    expect(plan.documents.map((document) => document.logicalDocumentId)).toEqual([
      "overview",
      "state-0002",
      "state-0004",
      "result",
    ])
    expect(plan.documents[1].content).toContain("No agent interpretation was recorded.")
    expect(plan.documents[1].content).toContain("No action was issued from this state.")
    expect(plan.documents[1].content).toEndWith(
      "No named accessibility evidence was captured in this snapshot."
    )
    expect(plan.documents[2].content).toEndWith(
      "No named accessibility evidence was captured in this snapshot."
    )
    expect(plan.documents[3].metadata.sequenceIndex).toBe(5)
    expect(plan.documents[3].content).toEndWith("Final outcome: unknown")

    const goal = "Find the overdue invoice."
    expect(plan.documents[0].content).toContain(goal)
    expect(plan.documents.slice(1).every((document) => !document.content.includes(goal))).toBe(true)
    expect(plan.documents[3].content).toContain("Final outcome: unknown")
    expect(
      plan.documents.slice(0, -1).every((document) => !document.content.includes("Final outcome:"))
    ).toBe(true)
  })

  test("cleans entities, Unicode private-use characters, and apostrophes in labels", () => {
    expect(cleanAccessibilityText("&lt;A&#x20AC;\uE000\\uE123 e\u0301&gt;\t&nbsp;done")).toBe(
      "<A€ é> done"
    )

    const evidence = parseStructuredAccessibilityTree(
      "[1] button 'Owner's report', value='', placeholder='A&nbsp;B', checked=false"
    )
    expect(evidence.controls).toEqual([
      {
        role: "button",
        label: "Owner's report",
        attributes: ["value=(empty)", "placeholder=A B", "checked=false"],
        indent: 0,
      },
    ])
  })

  test("preserves complete collection order and repeated labels", () => {
    const evidence = parseStructuredAccessibilityTree(
      [
        "option 'Same', selected=true",
        "option 'Same', selected=true",
        "option 'Other', selected=false",
        "checkbox 'Flag', checked=false",
        "checkbox 'Flag', checked=false",
        "radio 'One', checked=true",
        "radio 'One', checked=true",
      ].join("\n")
    )

    expect(evidence.options.map((node) => node.label)).toEqual(["Same", "Same", "Other"])
    expect(evidence.checkboxes).toHaveLength(2)
    expect(evidence.radios).toHaveLength(2)
  })

  test("preserves table rows and binds cells only when cardinalities match", () => {
    const evidence = parseStructuredAccessibilityTree(
      [
        "table 'Visible Users'",
        "  row ''",
        "    columnheader 'Name Name'",
        "    columnheader 'Role column options'",
        "  row ''",
        "    cell 'Ada'",
        "    cell 'Admin'",
        "  row ''",
        "    cell 'Grace'",
      ].join("\n")
    )

    expect(evidence.tables).toEqual([
      {
        title: "Visible Users",
        headers: ["Name", "Role"],
        rows: [["Ada", "Admin"], ["Grace"]],
      },
    ])

    const plan = structuredAccessibilityConverter.convert(
      trajectory({
        states: [
          {
            ...trajectory().states[0],
            accessibilityTree: [
              "table 'Visible Users'",
              "  row ''",
              "    columnheader 'Name Name'",
              "    columnheader 'Role column options'",
              "  row ''",
              "    cell 'Ada'",
              "    cell 'Admin'",
              "  row ''",
              "    cell 'Grace'",
            ].join("\n"),
          },
        ],
      }),
      undefined
    )
    const stateContent = plan.documents[1].content
    expect(stateContent).toContain("- Name: Ada\n- Role: Admin")
    expect(stateContent).toContain(
      "Schema mismatch: 2 visible headers and 1 visible cells; values are preserved without inferred bindings.\n- Ordered cell 1: Grace"
    )
  })

  test("retains labelled unparsed evidence and deduplicates normalized repeats", () => {
    const evidence = parseStructuredAccessibilityTree(
      ["??? 'Unparsed value'", "??? 'unparsed   value'", "not labelled"].join("\n")
    )
    expect(evidence.unparsedLines).toEqual(["??? 'Unparsed value'"])
    expect(evidence.other).toEqual([])
  })

  test("rejects empty and duplicate state-index inputs", () => {
    expect(() =>
      structuredAccessibilityConverter.convert(trajectory({ states: [] }), undefined)
    ).toThrow("must contain at least one state")

    const state = trajectory().states[0]
    expect(() =>
      structuredAccessibilityConverter.convert(
        trajectory({ states: [state, { ...state }] }),
        undefined
      )
    ).toThrow("duplicate stateIndex 0")
  })

  test("passes the generic deterministic-plan validator and rejects batch splitting", () => {
    const input = trajectory()
    const plan = structuredAccessibilityConverter.convert(input, undefined)
    const validated = validateDocumentPlan({
      plan,
      converter: structuredAccessibilityConverter,
      trajectory: input,
      context: undefined,
    })

    expect(validated.batchUpload).toBe(true)
    expect(validated.documents.map((document) => document.dependsOnOrdinals)).toEqual([[], [], []])
    expect(() =>
      createPhysicalDocuments({
        plan: validated,
        buildFingerprint: "build-fingerprint",
        maxDocumentChars: 50,
      })
    ).toThrow("a batch document cannot be split")
  })
})
