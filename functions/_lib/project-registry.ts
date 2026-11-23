interface RegistryDatabase {
  prepare(query: string): RegistryStatement;
  batch?(statements: RegistryStatement[]): Promise<unknown[]>;
}
interface RegistryStatement {
  bind(...values: unknown[]): RegistryStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/**
 * Ensure stable project UUIDs exist for the supplied Cloudflare project names.
 * Existing project records are never recreated or renamed; account + name is
 * intentionally retained as the compatibility key for all existing modules.
 */
export async function ensureProjectRegistry(
  db: RegistryDatabase,
  accountId: string,
  projectNames: string[]
): Promise<Record<string, string>> {
  const names = [...new Set(projectNames.filter((name) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name)))];
  if (!names.length) return {};

  const inserts = names.map((name) => db.prepare(`
    INSERT INTO project_registry(project_uid, account_id, project_name)
    VALUES(?,?,?)
    ON CONFLICT(account_id, project_name) DO NOTHING
  `).bind(crypto.randomUUID(), accountId, name));

  if (db.batch) {
    for (let offset = 0; offset < inserts.length; offset += 100) {
      await db.batch(inserts.slice(offset, offset + 100));
    }
  } else {
    await Promise.all(inserts.map((statement) => statement.run()));
  }

  const rows = await db.prepare(`
    SELECT project_name, project_uid
    FROM project_registry
    WHERE account_id=?
  `).bind(accountId).all<{ project_name: string; project_uid: string }>();
  const uidByName = new Map((rows.results || []).map((row) => [row.project_name, row.project_uid]));
  const result: Record<string, string> = {};
  for (const name of names) {
    const uid = uidByName.get(name);
    if (uid) result[name] = uid;
  }
  return result;
}
