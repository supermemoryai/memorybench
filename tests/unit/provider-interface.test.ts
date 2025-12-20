/**
 * Provider Interface Type Conformance Tests
 *
 * Tests that provider fixtures correctly implement the BaseProvider interface
 * and that type guards work as expected.
 *
 * (T013, User Story 1)
 */

import { describe, expect, test } from "bun:test";
import type { ScopeContext } from "../../types/core";
import type { BaseProvider } from "../../types/provider";
import {
	isBaseProvider,
	isLegacyTemplate,
	validateScopeContext,
} from "../../types/provider";

// Dynamic imports for fixtures
const importValidMinimal = () =>
	import("../registry/fixtures/valid-minimal/index");
const importValidFull = () => import("../registry/fixtures/valid-full/index");

describe("BaseProvider Interface Conformance", () => {
	test("valid-minimal exports a BaseProvider", async () => {
		const module = await importValidMinimal();
		const provider = module.default;

		// Type guard should confirm this is a BaseProvider
		expect(isBaseProvider(provider)).toBe(true);

		// Should have correct name
		expect(provider.name).toBe("valid-minimal");

		// Should have all required methods
		expect(typeof provider.add_memory).toBe("function");
		expect(typeof provider.retrieve_memory).toBe("function");
		expect(typeof provider.delete_memory).toBe("function");

		// Should NOT have optional methods (minimal provider)
		expect(provider.update_memory).toBeUndefined();
		expect(provider.list_memories).toBeUndefined();
		expect(provider.reset_scope).toBeUndefined();
		expect(provider.get_capabilities).toBeUndefined();
	});

	test("valid-full exports a BaseProvider with optional operations", async () => {
		const module = await importValidFull();
		const provider = module.default;

		// Type guard should confirm this is a BaseProvider
		expect(isBaseProvider(provider)).toBe(true);

		// Should have correct name
		expect(provider.name).toBe("valid-full");

		// Should have all required methods
		expect(typeof provider.add_memory).toBe("function");
		expect(typeof provider.retrieve_memory).toBe("function");
		expect(typeof provider.delete_memory).toBe("function");

		// Should HAVE optional methods (full provider)
		expect(typeof provider.update_memory).toBe("function");
		expect(typeof provider.list_memories).toBe("function");
		expect(typeof provider.reset_scope).toBe("function");
		expect(typeof provider.get_capabilities).toBe("function");
	});

	test("valid-minimal methods accept correct parameters and return Promises", async () => {
		const module = await importValidMinimal();
		const provider = module.default;

		const scope: ScopeContext = {
			user_id: "test-user",
			run_id: "test-run",
		};

		// add_memory returns Promise<MemoryRecord>
		const addResult = provider.add_memory(scope, "test content", {
			tag: "test",
		});
		expect(addResult).toBeInstanceOf(Promise);
		const record = await addResult;
		expect(record).toHaveProperty("id");
		expect(record).toHaveProperty("context");
		expect(record).toHaveProperty("metadata");
		expect(record).toHaveProperty("timestamp");
		expect(record.context).toBe("test content");

		// retrieve_memory returns Promise<RetrievalItem[]>
		const retrieveResult = provider.retrieve_memory(scope, "test", 10);
		expect(retrieveResult).toBeInstanceOf(Promise);
		const items = await retrieveResult;
		expect(Array.isArray(items)).toBe(true);

		// delete_memory returns Promise<boolean>
		const deleteResult = provider.delete_memory(scope, record.id);
		expect(deleteResult).toBeInstanceOf(Promise);
		const deleted = await deleteResult;
		expect(typeof deleted).toBe("boolean");
	});

	test("valid-full optional methods work correctly", async () => {
		const module = await importValidFull();
		const provider = module.default;

		const scope: ScopeContext = {
			user_id: "test-user-full",
			run_id: "test-run-full",
		};

		// Add a memory first
		const record = await provider.add_memory(scope, "test content", {
			tag: "test",
		});

		// update_memory should work
		if (provider.update_memory) {
			const updated = await provider.update_memory(
				scope,
				record.id,
				"updated content",
				{ tag: "updated" },
			);
			expect(updated.context).toBe("updated content");
			expect(updated.metadata.tag).toBe("updated");
		}

		// list_memories should work
		if (provider.list_memories) {
			const list = await provider.list_memories(scope, 10, 0);
			expect(Array.isArray(list)).toBe(true);
			expect(list.length).toBeGreaterThan(0);
		}

		// get_capabilities should return capabilities
		if (provider.get_capabilities) {
			const caps = await provider.get_capabilities();
			expect(caps).toHaveProperty("core_operations");
			expect(caps).toHaveProperty("optional_operations");
			expect(caps.core_operations.add_memory).toBe(true);
			expect(caps.optional_operations.update_memory).toBe(true);
		}

		// reset_scope should clear all memories in scope
		if (provider.reset_scope) {
			const cleared = await provider.reset_scope(scope);
			expect(typeof cleared).toBe("boolean");
		}
	});
});

describe("Type Guards", () => {
	test("isBaseProvider correctly identifies BaseProvider", async () => {
		const module = await importValidMinimal();
		const provider = module.default;

		expect(isBaseProvider(provider)).toBe(true);
	});

	test("isBaseProvider rejects non-conforming objects", () => {
		// Missing methods
		expect(isBaseProvider({})).toBe(false);
		expect(isBaseProvider({ name: "test" })).toBe(false);
		expect(isBaseProvider({ name: "test", add_memory: () => {} })).toBe(false);

		// Wrong types
		expect(isBaseProvider(null)).toBe(false);
		expect(isBaseProvider(undefined)).toBe(false);
		expect(isBaseProvider("string")).toBe(false);
		expect(isBaseProvider(123)).toBe(false);

		// name is not a string
		expect(
			isBaseProvider({
				name: 123,
				add_memory: () => {},
				retrieve_memory: () => {},
				delete_memory: () => {},
			}),
		).toBe(false);

		// methods are not functions
		expect(
			isBaseProvider({
				name: "test",
				add_memory: "not a function",
				retrieve_memory: () => {},
				delete_memory: () => {},
			}),
		).toBe(false);
	});

	test("isLegacyTemplate correctly identifies TemplateType", () => {
		const legacyProvider = {
			name: "legacy",
			addContext: async () => {},
			searchQuery: async () => [],
			prepareProvider: () => [],
		};

		expect(isLegacyTemplate(legacyProvider)).toBe(true);
	});

	test("isLegacyTemplate rejects BaseProvider", async () => {
		const module = await importValidMinimal();
		const provider = module.default;

		expect(isLegacyTemplate(provider)).toBe(false);
	});

	test("validateScopeContext accepts valid scope", () => {
		const validScope: ScopeContext = {
			user_id: "test-user",
			run_id: "test-run",
		};

		expect(() => validateScopeContext(validScope)).not.toThrow();
		const result = validateScopeContext(validScope);
		expect(result).toEqual(validScope);
	});

	test("validateScopeContext accepts scope with optional fields", () => {
		const scopeWithOptional: ScopeContext = {
			user_id: "test-user",
			run_id: "test-run",
			session_id: "test-session",
			namespace: "test-namespace",
		};

		expect(() => validateScopeContext(scopeWithOptional)).not.toThrow();
	});

	test("validateScopeContext rejects invalid scope", () => {
		// Missing user_id
		expect(() => validateScopeContext({ run_id: "test" })).toThrow(/user_id/);

		// Missing run_id
		expect(() => validateScopeContext({ user_id: "test" })).toThrow(/run_id/);

		// Wrong types
		expect(() =>
			validateScopeContext({ user_id: 123, run_id: "test" }),
		).toThrow(/user_id/);

		expect(() =>
			validateScopeContext({ user_id: "test", run_id: 123 }),
		).toThrow(/run_id/);

		// Not an object
		expect(() => validateScopeContext(null)).toThrow(/expected object/);
		expect(() => validateScopeContext("string")).toThrow(/expected object/);
	});
});
