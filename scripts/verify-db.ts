import { sql } from "bun";

const EXPECTED_SCHEMAS = ["aqrag", "contextual_retrieval"] as const;
const EXPECTED_TABLES = ["documents", "chunks", "embeddings"] as const;

function formatList(items: readonly string[]): string {
	return items.join(", ");
}

async function verifySchemas(): Promise<boolean> {
	const schemaRows = await sql`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name IN ${sql(EXPECTED_SCHEMAS)}
    ORDER BY schema_name
  `;

	const tableRows = await sql`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname IN ${sql(EXPECTED_SCHEMAS)}
    ORDER BY schemaname, tablename
  `;

	const foundSchemas = new Set(
		schemaRows.map((row: { schema_name: string }) => row.schema_name),
	);
	const tablesBySchema = new Map<string, Set<string>>();

	for (const row of tableRows as { schemaname: string; tablename: string }[]) {
		const tableSet = tablesBySchema.get(row.schemaname) ?? new Set<string>();
		tableSet.add(row.tablename);
		tablesBySchema.set(row.schemaname, tableSet);
	}

	const missingSchemas = EXPECTED_SCHEMAS.filter(
		(schema) => !foundSchemas.has(schema),
	);
	const missingTables: string[] = [];

	for (const schema of EXPECTED_SCHEMAS) {
		if (!foundSchemas.has(schema)) {
			continue;
		}
		const tableSet = tablesBySchema.get(schema) ?? new Set<string>();
		const missing = EXPECTED_TABLES.filter((table) => !tableSet.has(table));
		if (missing.length > 0) {
			missingTables.push(`${schema}: ${formatList(missing)}`);
		}
	}

	console.log("Schemas found:");
	console.log(
		foundSchemas.size > 0
			? formatList([...foundSchemas] as string[])
			: "(none)",
	);
	console.log("\nTables found:");
	if (tableRows.length === 0) {
		console.log("(none)");
	} else {
		for (const [schema, tables] of tablesBySchema) {
			console.log(`${schema}: ${formatList([...tables].sort())}`);
		}
	}

	if (missingSchemas.length > 0) {
		console.error(`\nMissing schemas: ${formatList(missingSchemas)}`);
	}
	if (missingTables.length > 0) {
		console.error(`Missing tables: ${missingTables.join(" | ")}`);
	}

	return missingSchemas.length === 0 && missingTables.length === 0;
}

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL) {
		console.warn(
			"DATABASE_URL is not set. Bun will use default PG* environment variables if available.",
		);
	}

	try {
		const ok = await verifySchemas();
		if (!ok) {
			console.error(
				"\nSchema verification failed. Ensure providers have initialized their tables.",
			);
			process.exit(1);
		}
		console.log("\nSchema verification passed.");
	} catch (error) {
		console.error(
			"Schema verification failed due to a database error:",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
	} finally {
		await sql.close();
	}
}

await main();
